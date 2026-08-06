/**
 * THE VC-3a MODULE SPECS — nine ported Bogaudio modules (VCV Rack).
 *
 * ── WHAT THIS FILE IS ───────────────────────────────────────────────────────
 * core/audio_specs.js's vocabulary applied to a ninth module set. Same record
 * shape, same rules, same reader (`core/audio_nodes.audioNodePlugin`): a spec is
 * the values that make one module differ from its neighbours, and NOTHING about
 * how it sounds. The DSP is `synth/vc3a_kernels.js`, whose docblocks carry the
 * derivation record — which C++ file and function, which recurrence, which
 * deviation — and each `help` below points at it rather than repeating it.
 *
 * ── WHY A SEPARATE FILE ─────────────────────────────────────────────────────
 * Several agents are writing ported module sets CONCURRENTLY (R7 Wave 3 Phase 3),
 * one block each. One shared file is one merge conflict per agent per save. The
 * barrel — `AUDIO_SPECS` in core/audio_specs.js — stays the single roster; this
 * array is spread into it, so "registered" is still one list you can read.
 *
 * ── THE UNITS, AND THE ONE LAW BEHIND THEM ──────────────────────────────────
 * Rack cables carry ±5 V nominal and ±10 V maximum; our wires carry ±1. So
 * ONE UNIT IS FIVE VOLTS, on every wire in this block with no exceptions —
 * `synth/vc3a_kernels.js`'s header states it once and this file just obeys.
 * Three consequences an author meets directly:
 *
 *   · A V/OCT INPUT IS THE ONE EXCEPTION AND IT CARRIES SEMITONES
 *     (`claude_instructions.md` § R7-UNITS, lead ruling 2026-08-06):
 *     `semitones = 12 × volts`, so 12 on a pitch wire is one octave. **ORIGIN C4,
 *     NOT E4** — a VCV V/oct 0 V is C4 (261.626 Hz here, Bogaudio's own constant),
 *     while the 34 Axoloti nodes' semitone 0 is E4, so an AX pitch wire into one of
 *     these ports is FOUR SEMITONES SHARP. `bogaudioSemitonesToHz` below is this
 *     block's display bridge; `core/audio_nodes.semitonesToHz` is the E4 one and
 *     must not be used here.
 *     TO TRANSCRIBE A RACK PATCH: divide every voltage by 5, EXCEPT a V/oct wire,
 *     which is multiplied by 12. A CV output driving a pitch port therefore needs a
 *     visible ×60 scaler — that is the ruling's stated cost, and P5's
 *     `AddrSeq → FMOp[Pitch]` chain is where it lands.
 *   · A GATE OR CLOCK is high at or above 0.2 (1 V), with Schmitt hysteresis
 *     re-arming below 0.02. Our own Trigger/Clock nodes emit 1.0, so they drive
 *     these correctly with nothing in between.
 *   · EVERY `…CV` INPUT DEFAULTS TO 2.0, WHICH IS UNITY, NOT ZERO. Bogaudio's CV
 *     inputs SCALE their knob and only when a cable is present; we have no
 *     connectedness signal, so an unwired scaler sits at 10 V where the scaler is
 *     exactly 1. Wire it and it behaves as Rack's. (Kernels' deviation D2.)
 *
 * KNOBS ARE NOT WIRES and carry the unit Bogaudio DISPLAYS — seconds, cents, a
 * frequency ratio, a 0…1 fraction — not its raw 0…1 param position. Each such
 * knob's `help` states the inverse curve so a Rack patch's raw number converts by
 * hand. (Kernels' D3.) Two switches are absent for the same reason: the LFO's
 * `slow` and DADSRH's `speed` only shift a knob's RANGE, and a knob that already
 * reads in hertz or seconds leaves them nothing to do — so the ranges are widened
 * instead of shipping an inert control. (Kernels' D4.)
 *
 * ── OPTION LISTS ARE RESTATED HERE, DELIBERATELY ────────────────────────────
 * THIS FILE MAY NOT IMPORT synth/** (core must run in bare node), so every
 * discrete knob's `options` array is restated from the kernels' own exported
 * lists. `tests/port_vc3a_test.js` pins each one against
 * `VC3A_OPTION_VALUES`, so a value this file offers and the kernel refuses turns
 * the suite red rather than throwing in an author's face.
 */

// ── SHARED KNOB FRAGMENTS ───────────────────────────────────────────────────

/** An on/off knob. Bogaudio's panel buttons and boolean context-menu items are
 *  all this, and it stays a two-option DISCRETE rather than a 0/1 number so the
 *  Inspector row reads as a choice and an equation cannot land it on 0.5. */
const OFF_ON = ["off", "on"];

/** An envelope stage, in SECONDS. Their knob is 0…1 shown as `v²·10`, so the
 *  ceiling is 10 s; the kernel floors every stage but `delay` at 10 ms. */
const SEGMENT = { min: 0, max: 10, step: 0.001, unit: " s" };

/** DADSRH's stages, once D4 folds its `speed` switch in: `v²·100`. */
const LONG_SEGMENT = { min: 0, max: 100, step: 0.001, unit: " s" };

/** A 0…1 amount — a fader position, a depth, a sustain level. Bogaudio shows
 *  these as a percentage; the number is the same. */
const AMOUNT = { min: 0, max: 1, step: 0.01 };

/** A ±1 amount — a pan, a pulse-width offset, a step value before its range. */
const BIPOLAR = { min: -1, max: 1, step: 0.01 };

/**
 * An octave in semitones — the pitch law's one number (R7-UNITS). Restated from
 * `synth/vc3a_kernels.js`'s `SEMITONES_PER_OCTAVE` because this file may not import
 * synth, and pinned against it by tests/port_vc3a_test.js.
 *
 * THERE IS NO `PITCH_INPUT` RANGE FRAGMENT HERE, and there was one for a day: an
 * INPUT PORT in this vocabulary is `{key, type, label}` and nothing else — a range
 * on it is read by no one, and neither is a `help`. Ranges live on the AudioParam
 * (`processors_vc3a.js`'s `PITCH_LIMIT`, ±120 st) and the units are stated in the
 * module's own `help`, which IS surfaced. The dead fragment was worse than nothing:
 * it read like the place the unit was declared, and the lead was pointed at it.
 */
const SEMITONES_PER_OCTAVE = 12;

/**
 * Pure function. THE BLOCK'S PITCH DISPLAY BRIDGE — semitones on a V/oct wire to
 * hertz, at VCV's C4 origin. R7-UNITS requires one of these per corpus and requires
 * that it NOT be `core/audio_nodes.semitonesToHz`, which is Axoloti's E4: a card
 * reading `0 st` where the author cannot see whether that is 261 Hz or 330 Hz is
 * exactly the divergence the rule exists to keep visible.
 *
 * The reference frequency is Bogaudio's OWN 261.626 (`src/dsp/pitch.hpp`), not
 * Rack's 261.6256 — three digits short, and theirs is what tunes their oscillators,
 * so it is what a display must agree with. Restated from `synth/vc3a_kernels.js`'s
 * `REFERENCE_FREQUENCY` for the layering reason the header gives, and pinned against
 * it by tests/port_vc3a_test.js.
 *
 * @param {number} semitones - a V/oct wire's value; 0 is C4
 * @returns {number} hertz
 *
 * @example bogaudioSemitonesToHz(0) // 261.626 (C4 — NOT Axoloti's 329.63)
 * @example bogaudioSemitonesToHz(12) // 523.252 (an octave up)
 * @example bogaudioSemitonesToHz(9) // 440.00108... (A4, within a cent of A440)
 * @example bogaudioSemitonesToHz(-12) // 130.813
 */
export function bogaudioSemitonesToHz(semitones) {
  return 261.626 * 2 ** (semitones / SEMITONES_PER_OCTAVE);
}

/** C4 and one octave above it, as text, so the two pitch inputs' help states real
 *  frequencies without either number being typed by hand. */
const C4_HZ_TEXT = bogaudioSemitonesToHz(0).toFixed(2);
const C5_HZ_TEXT = bogaudioSemitonesToHz(SEMITONES_PER_OCTAVE).toFixed(2);

/** A gate or clock input, and the knob-shaped button that sums with one. */
const GATE = { min: 0, max: 2, step: 0.01 };

/** The LFO's rate range, restated from `processors_vc3a.js` (this file may not
 *  import it) and pinned against it by tests/port_vc3a_test.js. The bottom is
 *  Bogaudio's own `cvToFrequency(-5 - 11)` — the −5 knob floor with the SLOW
 *  offset D4 folded in — and the top is `LFOBase::setFrequency`'s hard cap. */
const LFO_MIN_HZ = 261.626 * 2 ** -16;
const LFO_MAX_HZ = 2000;

/** …and its Rack default, `cvToFrequency(0 - 7)`. */
const LFO_DEFAULT_HZ = 261.626 * 2 ** -7;

/** `output_range.hpp`'s Range menu, in menu order — restated from the kernels'
 *  OUTPUT_RANGE_NAMES (see the header's note on why). */
const OUTPUT_RANGE_OPTIONS = ["+/-10v", "+/-5v", "+/-3v", "+/-2v", "+/-1v", "0-10v", "0-5v", "0-3v", "0-2v", "0-1v"];

/** The three addressed-sequencer flags AddrSeq and EightOne share, spelled once:
 *  each is a context-menu boolean in Rack and property state here. */
const SEQUENCE_FLAG_KNOBS = [
  {
    key: "triggeredSelect", label: "Triggered select", default: "off", discrete: true, options: OFF_ON,
    help: "OFF: the Select CV input is a POSITION — its voltage picks a step directly. ON: it is a STEP-ADVANCE — each rising edge moves the selection on by one and wraps at Select. That turns the one input from a transposer into a second, independent clock, which is how one sequencer gets two rhythms.",
  },
  {
    key: "selectOnClock", label: "Select on clock", default: "off", discrete: true, options: OFF_ON,
    help: "Sample the Select CV only on a clock edge. WHY IT MATTERS: with a smooth CV on Select and this off, the selection slides between steps mid-note and the output glides; with it on, the sequence changes only where a step boundary already is.",
  },
  {
    key: "wrapSelectAtSteps", label: "Wrap select at steps", default: "off", discrete: true, options: OFF_ON,
    help: "Wrap step+select at Steps instead of at 8. With Steps below 8 this is the difference between a select offset that stays inside the shortened sequence and one that reaches the steps beyond its end.",
  },
  {
    key: "reverseOnNegativeClock", label: "Reverse on negative clock", default: "off", discrete: true, options: OFF_ON,
    help: "A clock crossing −1 V steps BACKWARDS. One bipolar clock then drives the sequence in both directions, which is what makes a random-walk clock produce a wandering sequence rather than a running one.",
  },
];

/** The clock/reset/steps/direction/select controls those two also share. Their
 *  `help` is where the addressed-sequencer idea is explained, once. */
const SEQUENCE_CORE_KNOBS = [
  {
    key: "steps", label: "Steps", default: 8, min: 1, max: 8, step: 1,
    help: "How many steps a clock walks before wrapping. Truncated to a whole number, so 3.9 is three steps.",
  },
  {
    key: "direction", label: "Direction", default: "forward", discrete: true, options: ["reverse", "forward"],
    help: "Which way a clock edge moves the position.",
  },
  {
    key: "select", label: "Select", default: 0, min: 0, max: 7, step: 1,
    help: "THE ADDRESSED HALF, and the reason this module is not an ordinary sequencer: the clock advances a POSITION and Select is an absolute OFFSET added to it, their sum modulo 8 choosing the active step. Park the clock and sweep Select and you are addressing the steps by hand; run both and the phrase itself moves. The Select CV input adds to this knob (a 10 V CV adds all eight steps).",
  },
];

// ── SOURCES ─────────────────────────────────────────────────────────────────

export const VCV_FMOP_SPEC = {
  type: "audio_vcv_fmop", module: "vcvFmop", title: "FM-OP", family: "source",
  icon: "mdi:sine-wave", readout: "ratio", w: 180,
  help: `Bogaudio's FM-OP: ONE FM operator — a sine oscillator whose phase is bent by its own last output and by an external signal, with a built-in envelope that can drive its level, its feedback and its FM depth independently. A stack of these IS an FM synth; eight of them are the metallic layer of the Incanta patch and the FM Pad patch is nothing but two, one modulating the other. THE PITCH INPUT IS IN SEMITONES FROM C4 (0 is ${C4_HZ_TEXT} Hz, 12 is ${C5_HZ_TEXT} Hz) — a VCV V/oct wire times twelve. That is four semitones BELOW an Axoloti pitch wire's origin, which is E4.`,
  inputs: [
    { key: "pitch", type: "number", label: "pitch" },
    { key: "fm", type: "audio", label: "fm" },
    { key: "gate", type: "trigger", label: "gate" },
    { key: "depth_cv", type: "number", label: "depth" },
    { key: "feedback_cv", type: "number", label: "fbk" },
    { key: "level_cv", type: "number", label: "level" },
    { key: "sustain_cv", type: "number", label: "sus" },
  ],
  outputs: [{ key: "audio", type: "audio", label: "out" }],
  knobs: [
    {
      key: "ratio", label: "Ratio", default: 1, min: 0.01, max: 10, step: 0.01,
      help: "Frequency ratio against the pitch input — the number that makes an operator a harmonic partial (2, 3, 4…) or a bell (1.41, 3.7…). Rack's knob is raw −1…1 shown as this ratio: `raw < 0` reads `max(1+raw, 0.01)` and `raw >= 0` reads `1 + 9·raw`, so raw 0 is 1 and raw 1 is 10.",
    },
    { key: "fine", label: "Fine", default: 0, min: -100, max: 100, step: 1, unit: " ct", help: "Fine tune in cents. Rack's raw ±1 is `±1/12 V`, which is exactly this ±100 cents. Two operators a few cents apart is where an FM patch's movement comes from." },
    { key: "level", label: "Level", default: 1, ...AMOUNT, help: "Output level. In the default EXPONENTIAL response this is not a multiply: it maps to `(1 − level)·−60 dB` through Bogaudio's own 8192-entry decibel table, so the bottom of the knob fades rather than steps." },
    {
      key: "levelResponse", label: "Level response", default: "exponential", discrete: true, options: ["exponential", "linear"],
      help: "EXPONENTIAL is Rack's default and is a decibel curve; LINEAR multiplies the sample directly. It matters most when the ENVELOPE drives the level: an exponential level envelope sounds like a note dying away, a linear one like a fader being pulled.",
    },
    {
      key: "feedback", label: "Feedback", default: 0, ...AMOUNT,
      help: "How much of its OWN LAST OUTPUT bends this operator's phase — and the amount is in RADIANS, not in some normalised index: the last output is up to ±5 V, so feedback 1.0 is ±5 radians of self-modulation, four fifths of a cycle. Below about 0.1 it thickens the sine into a saw; above that it breaks up into noise. This is the single knob that makes one operator sound like several.",
    },
    {
      key: "depth", label: "FM depth", default: 0, ...AMOUNT,
      help: "How far the `fm` input bends the phase: `offset = fmVolts · depth · 2` radians. So with a full-scale ±1 modulator on `fm`, the modulation index is `β = 10·depth` — depth 0.1 is β = 1, which is one pair of strong sidebands, and depth 1.0 is β = 10, which is a metallic cluster. THE FM PAD PATCH IS ENTIRELY THIS KNOB'S ENVELOPE being shorter than the level's.",
    },
    { key: "attack", label: "Attack", default: 0.2, ...SEGMENT, help: "Envelope attack. Rack's raw 0…1 knob shows `raw²·10` seconds, so its 0.141 default is this 0.2 s. Floored at 10 ms." },
    { key: "decay", label: "Decay", default: 1, ...SEGMENT, help: "Envelope decay to the sustain level. Their default raw √0.1 is this 1 s." },
    { key: "sustain", label: "Sustain", default: 1, ...AMOUNT, help: "Envelope sustain level, scaled by the `sus` CV input." },
    { key: "release", label: "Release", default: 1, ...SEGMENT, help: "Envelope release once the gate falls." },
    {
      key: "envToLevel", label: "Env to level", default: "off", discrete: true, options: OFF_ON,
      help: "Route the envelope to the LEVEL. THE ENVELOPE ONLY RUNS AT ALL if at least one of these three is on — that is Bogaudio's own gate, so an operator with all three off is a bare oscillator and its gate input does nothing.",
    },
    { key: "envToFeedback", label: "Env to feedback", default: "off", discrete: true, options: OFF_ON, help: "Route the envelope to FEEDBACK, so a note's timbre collapses as it decays. This is the cheapest way to make one operator sound struck rather than blown." },
    { key: "envToDepth", label: "Env to FM depth", default: "off", discrete: true, options: OFF_ON, help: "Route the envelope to FM DEPTH — an INDEX envelope, the thing that makes FM sound like an instrument. A depth envelope shorter than the level envelope is the classic bell: bright attack, pure tail." },
    {
      key: "oscillator", label: "Oscillator", default: "classic", discrete: true, options: ["classic", "clean"],
      help: "CLASSIC is Rack's default and reads the 4096-entry sine table WITHOUT interpolation — the quantisation adds harmonics, and that grit is part of the module's character. CLEAN interpolates for a pure sine. Audible on a bare operator at low frequencies; nearly invisible once feedback is up.",
    },
    { key: "antialiasFeedback", label: "Anti-alias feedback", default: "on", discrete: true, options: OFF_ON, help: "Run the oscillator at 8× through a 4-stage decimator whenever feedback is active. ON is Rack's default: heavy feedback generates harmonics past Nyquist, and without this they fold back as inharmonic whistling. Off is cheaper and dirtier." },
    { key: "antialiasFm", label: "Anti-alias FM", default: "on", discrete: true, options: OFF_ON, help: "The same 8× path for EXTERNAL FM. Note it engages on the DEPTH knob alone here — our engine cannot tell whether `fm` is wired — so turning depth up with nothing patched costs the oversampling for no benefit (kernels' D2)." },
  ],
};

// ── MODULATION ──────────────────────────────────────────────────────────────

export const VCV_BOG_LFO_SPEC = {
  type: "audio_vcv_bog_lfo", module: "vcvBogLfo", title: "Bogaudio LFO", family: "modulation",
  icon: "mdi:wave", readout: "frequency", w: 165,
  help: "SIX PHASE-LOCKED OUTPUTS FROM ONE ACCUMULATOR — ramp up, ramp down, square, triangle, sine and stepped random, all read from the same phase, so they can never drift apart. That is the whole point of the module: patch two of them at different destinations and one LFO becomes a modulation section. Thirteen of the twenty demo patches use one. THE PITCH INPUT IS IN SEMITONES and multiplies the Rate knob rather than replacing it: 12 doubles the rate, −12 halves it.",
  inputs: [
    { key: "pitch", type: "number", label: "pitch" },
    { key: "reset", type: "trigger", label: "reset" },
    { key: "sample_cv", type: "number", label: "smpl" },
    { key: "pw_cv", type: "number", label: "pw" },
    { key: "offset_cv", type: "number", label: "offs" },
    { key: "scale_cv", type: "number", label: "scale" },
  ],
  outputs: [
    { key: "ramp_up", type: "audio", label: "ramp+" },
    { key: "ramp_down", type: "audio", label: "ramp-" },
    { key: "square", type: "audio", label: "sqr" },
    { key: "triangle", type: "audio", label: "tri" },
    { key: "sine", type: "audio", label: "sine" },
    { key: "stepped", type: "audio", label: "step" },
  ],
  knobs: [
    {
      key: "frequency", label: "Rate", default: LFO_DEFAULT_HZ, min: LFO_MIN_HZ, max: LFO_MAX_HZ, step: 0.001, unit: " Hz",
      help: "Rate in HERTZ. Rack's knob is a −5…8 CV against `261.626·2^(cv − 7)`, so its 0 default is this 2.0439 Hz; the SLOW switch subtracted another 4 octaves, which is why the bottom of this range reaches 0.004 Hz (four minutes a cycle) with no switch to set. TO TRANSCRIBE: `hz = 261.626·2^(knob − 7)`, or `− 11` if Slow was engaged. The pitch input multiplies this — 12 semitones doubles it.",
    },
    {
      key: "scale", label: "Scale", default: 1, ...AMOUNT,
      help: "Output amplitude, where 1 is Rack's ±5 V — our ±1 full scale. Scaled by the `scale` CV.",
    },
    {
      key: "offset", label: "Offset", default: 0, ...BIPOLAR,
      help: "Adds a DC offset, ±1 of the offset range. Offset 1 with scale 1 turns a bipolar LFO into a unipolar one, which is what a filter cutoff or a VCA gain usually wants.",
    },
    {
      key: "offsetRange", label: "Offset range", default: "5v", discrete: true, options: ["5v", "10v"],
      help: "How far the Offset knob reaches: ±5 V (our ±1) or ±10 V (our ±2). The wider setting exists so an LFO can offset a signal clear out of a ±5 V range.",
    },
    {
      key: "pw", label: "Pulse width", default: 0, ...BIPOLAR,
      help: "SQUARE OUTPUT ONLY. 0 is a 50% duty cycle; ±1 reaches Bogaudio's 3%/97% limits (their `minPulseWidth`). It is LATCHED at each cycle boundary, so modulating it steps once a cycle instead of smearing the edge.",
    },
    {
      key: "sample", label: "Sampling", default: 0, ...AMOUNT,
      help: "HOLDS each continuous output for up to a quarter cycle, turning the sine and ramps into staircases whose step count follows the rate. The square and stepped outputs are exempt — they are already stepped, and holding them would only lengthen a step at random.",
    },
    {
      key: "smooth", label: "Smoothing", default: 0, ...AMOUNT,
      help: "Slews every output with a shaped limiter whose time is set from the CURRENT rate, so it stays proportional as the rate changes. Its real use is on the STEPPED and SQUARE outputs, where it turns a step into a glide.",
    },
    {
      key: "offsetCvTarget", label: "Offset CV drives", default: "offset", discrete: true, options: ["offset", "smooth"],
      help: "Which knob the ONE Offset CV input scales — Bogaudio's `offset_cv_to_smoothing` field. Pointing it at SMOOTHING is how a patch modulates the glide without spending a second input; note that with nothing wired to the input the scaler is unity either way.",
    },
    {
      key: "seed", label: "Seed", default: 0, min: 0, max: 65535, step: 1, construct: true,
      help: "CONSTRUCT-TIME: the STEPPED output's 4096-value random table is built once, so changing this rebuilds the module. THE REASON THIS KNOB EXISTS: Bogaudio fills that table from a global RNG, so the same patch is a different sequence every launch — and a document that renders differently every time is not a document. Same seed, same sequence, forever.",
    },
  ],
};

export const VCV_BOG_ADSR_SPEC = {
  type: "audio_vcv_bog_adsr", module: "vcvBogAdsr", title: "Bogaudio ADSR", family: "modulation",
  icon: "mdi:chart-bell-curve", readout: "attack",
  help: "Bogaudio's ADSR, whose envelope is SHAPED rather than linear or exponential: the attack is a square root (fast then easing) and the decay and release are squares. That asymmetry is why it sounds like an analogue envelope and not like a ramp generator — and why the Linear switch is a genuinely different envelope rather than a tidier one.",
  inputs: [{ key: "gate", type: "trigger", label: "gate" }],
  outputs: [{ key: "out", type: "audio", label: "env" }],
  knobs: [
    { key: "attack", label: "Attack", default: 0.2, ...SEGMENT, help: "Rack's raw 0…1 knob shows `raw²·10` seconds; its 0.141 default is this 0.2 s. Floored at 1 ms. THE ATTACK ENDS WHEN THE ENVELOPE REACHES 1, not when the time expires — with the curved shape those differ." },
    { key: "decay", label: "Decay", default: 1, ...SEGMENT, help: "Fall to the sustain level. Their default raw √0.1 is this 1 s." },
    { key: "sustain", label: "Sustain", default: 1, ...AMOUNT, help: "Level held while the gate stays high." },
    { key: "release", label: "Release", default: 1, ...SEGMENT, help: "Fall from wherever the envelope was when the gate fell — not from the sustain level, which is what makes a short note release naturally." },
    {
      key: "shape", label: "Shape", default: "logarithmic", discrete: true, options: ["logarithmic", "linear"],
      help: "LOGARITHMIC is Rack's default: attack √, decay and release squared. LINEAR makes all three straight lines, which is what you want when the envelope is driving a pitch or a filter rather than an amplitude.",
    },
    {
      key: "polarity", label: "Polarity", default: "normal", discrete: true, options: ["normal", "inverted"],
      help: "INVERTED negates the output (their context-menu `invert`), giving a 0 → −2 envelope. Useful for ducking: one envelope opens a VCA while its inverse closes another.",
    },
  ],
};

export const VCV_DADSRH_SPEC = {
  type: "audio_vcv_dadsrh", module: "vcvDadsrh", title: "DADSR(H)", family: "modulation",
  icon: "mdi:chart-timeline-variant", readout: "hold", w: 170,
  help: "A DELAY-attack-decay-sustain-release envelope with a HOLD timer and per-stage shapes. Its two ideas: the delay lets one trigger fire several of these at staggered times, and the HOLD ends the note by itself — so in TRIGGERED mode the envelope is fire-and-forget, and with LOOP on it becomes an LFO with a shape you drew.",
  inputs: [{ key: "trigger", type: "trigger", label: "trig" }],
  outputs: [
    { key: "env", type: "audio", label: "env" },
    { key: "inv", type: "audio", label: "inv" },
    { key: "trigger", type: "trigger", label: "eoc" },
  ],
  knobs: [
    { key: "trigger", label: "Trigger", default: 0, ...GATE, help: "THE PANEL BUTTON, and it SUMS with the trigger input exactly as the C++ does. In Rack it is a momentary press; here it is keyframable state, so \"fire at 2.5 s\" is a keyframe. Anything at or above 0.2 counts as high." },
    { key: "delay", label: "Delay", default: 0, ...LONG_SEGMENT, help: "Silence before the attack begins. Zero is allowed here (alone among the stages), and staggering several of these off one trigger is what the stage is for." },
    { key: "attack", label: "Attack", default: 0.2, ...LONG_SEGMENT, help: "Rack's raw 0…1 knob shows `raw²·10` s, or `·100` with its Speed switch on slow. Both ranges are folded into this one knob (kernels' D4), which is why the ceiling is 100 s. Floored at 10 ms." },
    { key: "decay", label: "Decay", default: 1, ...LONG_SEGMENT, help: "Fall to the sustain level." },
    { key: "sustain", label: "Sustain", default: 0.5, ...AMOUNT, help: "Level held during sustain. Read PER SAMPLE, not once per note, so modulating it moves a held note." },
    { key: "release", label: "Release", default: 1, ...LONG_SEGMENT, help: "Fall from wherever the envelope was when the stage ended." },
    {
      key: "hold", label: "Hold", default: 2, ...LONG_SEGMENT,
      help: "A timer running from the START of the delay stage that forces the release when it expires. In TRIGGERED mode this is what ends the note. In GATED mode the gate ends it — but the timer keeps accumulating anyway, deliberately, so flipping Mode mid-note does the right thing.",
    },
    {
      key: "mode", label: "Mode", default: "gated", discrete: true, options: ["triggered", "gated"],
      help: "GATED (Rack's default) sustains while the trigger is high. TRIGGERED ignores the gate's length and lets HOLD decide — which is what makes this module usable from a one-sample pulse.",
    },
    {
      key: "loop", label: "Loop", default: "stop", discrete: true, options: ["loop", "stop"],
      help: "LOOP restarts from the delay stage whenever the release finishes, turning the envelope into a shaped LFO. Only in TRIGGERED mode — a gated envelope has nothing to loop back into.",
    },
    {
      key: "retrigger", label: "Retrigger", default: "resume", discrete: true, options: ["reset", "resume"],
      help: "What a trigger does mid-note. RESET (Rack calls it that) restarts from the delay, which clicks. RESUME re-enters the attack at the phase matching the CURRENT level, and rewinds Hold to where it would have been then, so a retriggered note has the same shape as a fresh one.",
    },
    {
      key: "attackShape", label: "Attack shape", default: "logarithmic", discrete: true, options: ["logarithmic", "linear", "exponential"],
      help: "The attack's curve. LOGARITHMIC rises fast then eases (a struck sound); EXPONENTIAL creeps then jumps (a swell).",
    },
    {
      key: "decayShape", label: "Decay shape", default: "exponential", discrete: true, options: ["exponential", "linear", "logarithmic"],
      help: "The decay's curve. NOTE THE ORDER IS REVERSED against Attack's, and that is Bogaudio's own labelling, not a slip: the first position is the \"fast first\" end of each stage, which is logarithmic going up and exponential coming down.",
    },
    { key: "releaseShape", label: "Release shape", default: "exponential", discrete: true, options: ["exponential", "linear", "logarithmic"], help: "The release's curve, with the same three exponents as Decay." },
  ],
};

export const VCV_ADDRSEQ_SPEC = {
  type: "audio_vcv_addrseq", module: "vcvAddrseq", title: "ADDR-SEQ", family: "modulation",
  icon: "mdi:format-list-numbered", readout: "steps", w: 170,
  help: "A voltage-ADDRESSABLE 8-step sequencer: a clock walks a position while the Select CV picks which part of the sequence is being walked. Nine of these are the modulation farm of the Incanta patch — with Select on a slow drift no two of them land on the same pattern, which is how one module type produces a whole generative texture.",
  inputs: [
    { key: "clock", type: "trigger", label: "clock" },
    { key: "reset", type: "trigger", label: "reset" },
    { key: "select_cv", type: "number", label: "select" },
  ],
  outputs: [{ key: "out", type: "audio", label: "seq" }],
  knobs: [
    ...SEQUENCE_CORE_KNOBS,
    {
      key: "range", label: "Range", default: "+/-10v", discrete: true, options: OUTPUT_RANGE_OPTIONS,
      help: "How the ±1 step knobs map to an output voltage: `out = (step + offset)·scale`, with the ten pairs Bogaudio's Range menu offers. The unipolar entries add 1 first, so `0-10v` turns a ±1 knob into 0…10 V. Our units are volts ÷ 5, so `+/-10v` reaches ±2 here.",
    },
    ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({
      key: `step${n}`, label: `Step ${n}`, default: 0, ...BIPOLAR,
      help: `Step ${n}'s value, before Range is applied. Ordinary keyframable state — so a sequence can be rewritten between slides, which is a thing Rack cannot do.`,
    })),
    ...SEQUENCE_FLAG_KNOBS,
  ],
};

export const VCV_EIGHTONE_SPEC = {
  type: "audio_vcv_eightone", module: "vcvEightone", title: "8:1", family: "modulation",
  icon: "mdi:call-merge", readout: "select", w: 165,
  help: "The demultiplexer half of ADDR-SEQ: the addressed position picks which of eight INPUTS reaches the output instead of which of eight knobs. Same clock, reset, steps and select semantics — so driving an 8:1 and an ADDR-SEQ from one clock keeps them in step, which is how a patch sequences a signal and a control voltage together.",
  inputs: [
    { key: "clock", type: "trigger", label: "clock" },
    { key: "reset", type: "trigger", label: "reset" },
    { key: "select_cv", type: "number", label: "select" },
    ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({ key: `in${n}`, type: "audio", label: `in ${n}` })),
  ],
  outputs: [{ key: "out", type: "audio", label: "out" }],
  knobs: [...SEQUENCE_CORE_KNOBS, ...SEQUENCE_FLAG_KNOBS],
};

export const VCV_BOOL_SPEC = {
  type: "audio_vcv_bool", module: "vcvBool", title: "BOOL", family: "modulation",
  icon: "mdi:logic-gate-and", readout: null,
  help: "Boolean logic on gates: A and B give AND, OR and XOR at once, and a separate input gives NOT. Anything above 1 V (0.2 in our units) is true. THE COMPARISON HAS NO HYSTERESIS — that is Bogaudio's, and it is why this module is for gates and not for audio: a signal hovering at the threshold chatters. NOTE that an unwired NOT input reads as false, so NOT emits high; Rack outputs zero there, because it can tell nothing is patched.",
  inputs: [
    { key: "a", type: "number", label: "a" },
    { key: "b", type: "number", label: "b" },
    { key: "not", type: "number", label: "not in" },
  ],
  outputs: [
    { key: "and", type: "trigger", label: "and" },
    { key: "or", type: "trigger", label: "or" },
    { key: "xor", type: "trigger", label: "xor" },
    { key: "not", type: "trigger", label: "not" },
  ],
  knobs: [],
};

export const VCV_MIX4_SPEC = {
  type: "audio_vcv_mix4", module: "vcvMix4", title: "MIX4", family: "modulation",
  icon: "mdi:tune-vertical", readout: "mix", w: 190,
  help: "Four channels with fader, mute/solo, pan and level CV into a master fader and a SATURATOR — so pushing it does not clip, it compresses. Faders are decibel curves through Bogaudio's own level table, and the pan is constant-power off the sine table. Five of these carry the Incanta patch's bus.",
  inputs: [
    ...[1, 2, 3, 4].map((n) => ({ key: `in${n}`, type: "audio", label: `in ${n}` })),
    ...[1, 2, 3, 4].map((n) => ({ key: `cv${n}`, type: "number", label: `lvl ${n}` })),
    ...[1, 2, 3, 4].map((n) => ({ key: `pan${n}_cv`, type: "number", label: `pan ${n}` })),
    { key: "mix_cv", type: "number", label: "mix cv" },
  ],
  outputs: [
    { key: "l", type: "audio", label: "left" },
    { key: "r", type: "audio", label: "right" },
  ],
  knobs: [
    ...[1, 2, 3, 4].flatMap((n) => [
      {
        key: `level${n}`, label: `Level ${n}`, default: 60 / 66, ...AMOUNT,
        help: `Channel ${n}'s fader, spanning −60 dB to +6 dB — so its default of 0.909 is UNITY, not a cut. It reaches the signal through an 8192-entry decibel table whose bottom 6 dB ramp linearly to zero, which is what makes the fader's floor a fade.`,
      },
      { key: `pan${n}`, label: `Pan ${n}`, default: 0, ...BIPOLAR, help: `Channel ${n}'s pan, constant power (centre is −3 dB in each side, not −6). Slewed over 10 ms so a stepped pan CV does not click.` },
      {
        key: `mute${n}`, label: `Mute ${n}`, default: "unmuted", discrete: true, options: ["unmuted", "muted", "soloed"],
        help: `Channel ${n}'s mute state. SOLO IS THE SAME CONTROL and it works by inverting the test: with anything soloed anywhere on the mixer, an UNMUTED channel is the one that goes quiet.`,
      },
    ]),
    { key: "mix", label: "Master", default: 60 / 66, ...AMOUNT, help: "Master fader, the same −60…+6 dB curve. 0.909 is unity." },
    { key: "masterMute", label: "Master mute", default: "off", discrete: true, options: OFF_ON, help: "Mute the master, slewed over 5 ms rather than cut." },
    { key: "masterDim", label: "Master dim", default: "off", discrete: true, options: OFF_ON, help: "Drop the master by the Dim amount — a monitoring control, so a level can be checked without losing the fader position." },
    { key: "dimDecibels", label: "Dim amount", default: "12", discrete: true, options: ["6", "12", "18", "24"], unit: " dB", help: "How far Master dim drops the output." },
    {
      key: "cvResponse", label: "Level CV response", default: "exponential", discrete: true, options: ["exponential", "linear"],
      help: "EXPONENTIAL (Rack's default) scales the fader's DECIBELS, so a CV sweep sounds like a fader move. LINEAR multiplies the sample after the fader, which is what a tremolo or a VCA-style envelope wants.",
    },
  ],
};

export const VCV_MANUAL_SPEC = {
  type: "audio_vcv_manual", module: "vcvManual", title: "MANUAL", family: "modulation",
  icon: "mdi:gesture-tap-button", readout: "trigger",
  help: "One button, eight identical gate outputs — the module that starts a patch. Its two subtleties are both about time: the output is held for at least 1 ms after the button goes low, so a single-frame press is still a usable trigger; and TRIGGER ON LOAD fires once 10 ms after the module starts, which is what makes a patch self-starting. RACK'S +10 V OUTPUT OPTION IS NOT HERE: a trigger port carries 0..1 (R7-UNITS clause 4 — logic is not level), so there is no voltage for that option to scale. See the kernels' deviation D11.",
  inputs: [],
  outputs: [1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({ key: `out${n}`, type: "trigger", label: `out ${n}` })),
  knobs: [
    { key: "trigger", label: "Trigger", default: 0, ...GATE, help: "THE BUTTON. In Rack it is a momentary press; here it is keyframable property state, so a press is a keyframe and a rendered video fires it at exactly the same frame every time. Anything at or above 0.2 counts as pressed." },
    { key: "triggerOnLoad", label: "Trigger on load", default: "on", discrete: true, options: OFF_ON, help: "Fire once, 10 ms after the module starts. ON is Rack's default and is what a self-starting patch needs; turn it off when the button is keyframed and an extra pulse at the top of the slide would be wrong." },
  ],
};

/**
 * EVERY VC-3a SPEC, sources first then modulation — the same ordering rule
 * core/audio_specs.AUDIO_SPECS follows, so the palette reads as one library
 * rather than as blocks that happen to be adjacent.
 *
 * THE BARREL LINES THIS NEEDS (the lead applies them; this block may not):
 * `core/audio_blocks.js`'s PORT_BLOCK_SPECS must spread this array and
 * `plugins/audio_index.js`'s `audioPlugins` must spread the matching plugin
 * array, or these modules exist in the engine and nowhere an author can reach.
 * tests/port_vc3a_test.js sweeps this array either way.
 */
export const BLOCK_SPECS = [
  VCV_FMOP_SPEC,
  VCV_BOG_LFO_SPEC, VCV_BOG_ADSR_SPEC, VCV_DADSRH_SPEC, VCV_ADDRSEQ_SPEC, VCV_EIGHTONE_SPEC,
  VCV_BOOL_SPEC, VCV_MIX4_SPEC, VCV_MANUAL_SPEC,
];
