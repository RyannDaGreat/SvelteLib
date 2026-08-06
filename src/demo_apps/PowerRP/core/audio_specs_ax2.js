/**
 * THE AX-2 MODULE SPECS — the ten ported Axoloti oscillator / LFO / noise nodes.
 *
 * ── WHAT THIS FILE IS ───────────────────────────────────────────────────────
 * core/audio_specs.js's vocabulary, applied to a second module set. Same record
 * shape, same rules, same reader (`core/audio_nodes.audioNodePlugin`): a spec is
 * the twelve values that make one module differ from its neighbours, and NOTHING
 * about how it sounds. The DSP is `synth/ax2_kernels.js`; the derivation record —
 * which Axoloti object, which `code.krate`/`code.srate` block, which recurrence,
 * which deviation — is that file's docblocks, and each `help` below points at it
 * rather than repeating it.
 *
 * ── WHY A SECOND FILE AND NOT MORE ROWS IN THE FIRST ────────────────────────
 * Five agents are writing ported module sets CONCURRENTLY (R7 Wave 3 Phase 3),
 * one block each. One shared file is one merge conflict per agent per save. The
 * barrel — `AUDIO_SPECS` in core/audio_specs.js — stays the single roster; this
 * array is spread into it. So "registered" is still one list you can read.
 *
 * ── THE SAME LAWS APPLY, AND TWO ARE WORTH RESTATING HERE ───────────────────
 * A port's declared TYPE decides which drops core/nodeflow.js permits, so it must
 * say what is true. Every knob's range must mirror what the kernel really clamps.
 * `tests/port_ax2_test.js` checks both against synth/ax2_kernels.js, which is
 * where a dependency on the engine belongs: THIS FILE MAY NOT IMPORT synth/**
 * (core must run in bare node), so the option lists below are RESTATED from the
 * kernels' own `OSC_WAVEFORMS` / `LFO_WAVEFORMS` / `NOISE_COLOURS` / `RAND_MODES`
 * and pinned against them by that test.
 *
 * ── UNITS: SEMITONES, HERTZ, CYCLES — NOT frac32 (kernels' deviation D9) ────
 * On hardware every wire is a frac32, so a `pitch` inlet of 1.0 means 64
 * semitones and a `phase` inlet of 1.0 means half a cycle. Those factors are
 * artefacts of having one wire type. Here a knob and its same-named input carry
 * the SAME units and sum on one AudioParam, which is already this project's
 * convention (OSCILLATOR_SPEC: knob `frequency` in Hz AND input `frequency` in
 * Hz). To transcribe a real Axoloti patch, multiply a frac32 pitch wire by 64.
 *
 * ── PITCH IS SEMITONES FROM E4, AND THAT IS NOT A TYPO ──────────────────────
 * Axoloti pitch 0 is MIDI 64 = E4 = 329.6276 Hz. Not A440, not C. Every `pitch`
 * knob below is in those semitones, so 5 is A440 and 12 is an octave above E4.
 * Keeping their origin is what lets a patch's dial numbers be copied across
 * unchanged, which is the entire point of porting rather than reimplementing.
 *
 * ── TWO CONTROLS ARE MODE-SCOPED, AND SAY SO ────────────────────────────────
 * `audio_ax_osc`'s `pw` and `phase` do nothing outside one waveform each, and the
 * spec vocabulary has no `when` clause to hide a row with (it has `derived` for a
 * knob with no leaf, and `construct` for a knob that rebuilds — neither fits).
 * The honest interim is a row whose `help` states its scope in its first clause.
 * THE PROPER FIX, for whoever owns core/audio_nodes.js next: a `when(state)`
 * predicate beside `derived`, so `audioKnobRows` can drop an inapplicable row —
 * "inapplicable-by-mode controls are HIDDEN" is a house rule this file can
 * currently only approximate.
 */

import { semitonesToHz } from "./audio_nodes.js";

// ── SHARED KNOB FRAGMENTS ───────────────────────────────────────────────────

/**
 * THE PITCH KNOB, restated per module because the DEFAULT differs while the
 * range is `MTOFEXTENDED`'s own clamp: `__SSAT(pitch, 29)` is ±2^28 raw, and a
 * semitone is 2^21 raw, so ±128 semitones is where the kernel saturates. A
 * narrower range here would be an Inspector that refuses a pitch the engine
 * accepts; a wider one would be a field whose top end does nothing.
 *
 * `hz` IS THE LEAD'S 2026-08-06 RULING, and it applies here for the same reason it
 * applies to AX-3's filters: these nodes are tuned in semitones (Axoloti sums pitch in
 * the pitch domain, so a modulation depth means the same interval wherever the knob is
 * parked), the rest of the library is tuned in hertz, and the divergence must be VISIBLE
 * rather than hidden. A card reading a bare `24 st` is a control the author cannot
 * reason about. Same law as AX-3's — hence the one shared `semitonesToHz`, not a copy.
 */
const PITCH = { min: -128, max: 128, step: 0.01, unit: " st", hz: semitonesToHz };

/** An LFO's rate is mtof/64, and the 64 is TWO factors rather than one magic number:
 *  their `Phase += freq>>2` contributes the 4, and advancing once per 16-sample control
 *  tick contributes the 16. Restated from synth/ax2_kernels' `LFO_INCREMENT_DIVISOR`
 *  and `KRATE_BUFSIZE` for the layering reason semitonesToHz explains; pinned against
 *  the shared conversion by tests/audio_nodes_test.js. */
const AX_LFO_INCREMENT_DIVISOR = 4;
const AX_LFO_CONTROL_TICK_SAMPLES = 16;
const AX_LFO_PITCH_DIVISOR = AX_LFO_INCREMENT_DIVISOR * AX_LFO_CONTROL_TICK_SAMPLES;

/**
 * THE SEED KNOB. Their noise reads the STM32 hardware RNG and is not
 * reproducible at all; ours is (kernels' deviation D4, and the project's
 * determinism law). Seed 0 reproduces their `code.init` constants exactly.
 */
const SEED = {
  key: "seed", label: "Seed", default: 0, min: 0, max: 65535, step: 1, construct: true,
  help: "CONSTRUCT-TIME: the generator's state is initialised once, so changing this rebuilds the module. THE REASON THIS KNOB EXISTS: Axoloti's noise reads the chip's hardware random generator and is not reproducible even on the same box, and a document that renders differently every time is not a document. Same seed, same noise, forever. 0 is their own initialiser constant.",
};

/** The `freq` (FM) input every accumulator-based node accepts, in HERTZ — added
 *  straight to the phase increment, per sample, so it is true through-zero FM. */
const FM_INPUT = { key: "freq", type: "number", label: "fm" };

// ── SOURCES ─────────────────────────────────────────────────────────────────

export const AX_OSC_SPEC = {
  type: "audio_ax_osc", module: "axOsc", title: "AX Oscillator", family: "source",
  icon: "mdi:sine-wave", readout: "waveform", w: 165,
  help: "Axoloti's five `osc/*` oscillators in one node — including the BAND-LIMITED saw and square, which are 4- and 8-voice minBLEP over the firmware's own 2048-entry step table. That is the difference you hear: a naive saw folds its high harmonics back down as inharmonic whistling when you play it high, and these do not.",
  inputs: [
    { key: "pitch", type: "number", label: "pitch" },
    { ...FM_INPUT },
    { key: "phase", type: "number", label: "phase" },
    { key: "pw", type: "number", label: "pw" },
  ],
  outputs: [{ key: "out", type: "audio", label: "wave" }],
  knobs: [
    { key: "pitch", label: "Pitch", default: 0, ...PITCH, help: "Semitones from E4 — Axoloti's origin, so 0 is 329.6276 Hz and 5 is A440. Fractional values are legal and are what a detuned pair is made of." },
    {
      key: "waveform", label: "Waveform", default: "saw", discrete: true,
      options: ["sine", "saw", "sawMedium", "square", "pwm"],
      help: "`sine` is their 4096-entry table (we use Math.sin; the difference is −123 dBFS, measured). `saw` is the 4-voice minBLEP, ±0.5. `sawMedium` is their cheap saw: one correction sample at the jump and ±0.125, which is 12 dB quieter ON PURPOSE — seven of them are what a supersaw is. `square` is the 8-voice minBLEP. `pwm` is that square with a movable falling edge.",
    },
    { key: "phase", label: "Phase", default: 0, min: -1, max: 1, step: 0.001, unit: " cyc", help: "SINE ONLY — phase modulation, the FM patch's other half. It is not applied to the band-limited waveforms because offsetting their read-out would move the correction away from the discontinuity it corrects, which is precisely the aliasing the minBLEP is there to remove." },
    { key: "pw", label: "Pulse width", default: 0, min: -1, max: 1, step: 0.01, help: "PWM ONLY — duty cycle, where 0 is 50% and ±1 collapses the pulse to nothing. It is LATCHED at each rising edge (their `pwmp = ((1<<27)+inlet_pw)<<4` sits inside the dispatch), so modulating it steps once per cycle instead of smearing the edge." },
  ],
};

export const AX_SUPERSAW_SPEC = {
  type: "audio_ax_supersaw", module: "axSupersaw", title: "AX Supersaw", family: "source",
  icon: "mdi:waveform", readout: "detune",
  help: "`osc/supersaw`: seven of their cheap saws, six detuned around the seventh. The spread is SQUARE-LAW, so the bottom half of the Detune knob barely moves and the top half opens right up — that curve is theirs and is why the knob feels the way it does.",
  inputs: [
    { key: "pitch", type: "number", label: "pitch" },
    { key: "detune", type: "number", label: "detune" },
  ],
  outputs: [{ key: "out", type: "audio", label: "wave" }],
  knobs: [
    { key: "pitch", label: "Pitch", default: -12, ...PITCH, help: "Semitones from E4. −12 is E3, an octave down, where a supersaw usually wants to sit." },
    { key: "detune", label: "Detune", default: 0.5, min: 0, max: 1, step: 0.01, help: "How far the six voices spread, SQUARED before it is applied (their `___SMMUL(det1,det1)`). At 1 they span about ±1.4 semitones. At 0 all seven collapse to one saw — and to the same PHASE within a few seconds, because nothing keeps them apart." },
  ],
};

export const AX_NOISE_SPEC = {
  type: "audio_ax_noise", module: "axNoise", title: "AX Noise", family: "source",
  icon: "mdi:grain", readout: "colour",
  help: "Their three `noise/*` generators at audio rate. Unlike ours, `gaussian` is a real distribution rather than a filter colour: eight independent generators summed, which is what gives it a bell-shaped amplitude histogram and a softer, less spiky sound than uniform at the same level.",
  inputs: [],
  outputs: [{ key: "out", type: "audio", label: "wave" }],
  knobs: [
    {
      key: "colour", label: "Colour", default: "pink", discrete: true,
      options: ["uniform", "pink", "gaussian"],
      help: "LIVE, unlike our own Noise node's colour: each colour is a different generator, but the kernel can swap one for another between samples, so this needs no ~40 ms rebuild and no rewire. `uniform` is flat per hertz and equally likely at every level. `pink` is their 7-octave Voss-McCartney tree, −3 dB per octave. `gaussian` is flat per hertz like uniform but bell-shaped in AMPLITUDE — same spectrum, different texture.",
    },
    { ...SEED },
  ],
};

export const AX_PHASOR_SPEC = {
  type: "audio_ax_phasor", module: "axPhasor", title: "AX Phasor", family: "source",
  icon: "mdi:ramp-left", readout: "pitch",
  help: "`osc/phasor compl`: a raw 0…1 ramp and its opposite, half a cycle apart. Not meant to be heard — it is the READ POSITION for a table, a grain window or a wavefolder, and the two outputs are what lets a crossfade hide the wrap.",
  inputs: [
    { key: "pitch", type: "number", label: "pitch" },
    { ...FM_INPUT },
  ],
  outputs: [
    { key: "phasor0", type: "audio", label: "0°" },
    { key: "phasor180", type: "audio", label: "180°" },
  ],
  knobs: [
    { key: "pitch", label: "Pitch", default: 0, ...PITCH, help: "Semitones from E4. THEIR INLET SAYS 'phase increment' AND THAT IS WRONG — the code runs it through MTOFEXTENDED, so it is a pitch. The label is corrected here rather than reproduced." },
  ],
};

export const AX_LFSR_BURST_SPEC = {
  type: "audio_ax_lfsr_burst", module: "axLfsrBurst", title: "AX LFSR Burst", family: "source",
  icon: "mdi:flash", readout: "polynomial",
  help: "`pulse/lfsrburst 8`: a 255-sample burst of a maximal-length 8-bit shift register — 5.3 ms of deterministic noise. This is a percussion EXCITER, not a noise source: hit a filter or a comb with it and you get the transient, not a hiss.",
  inputs: [{ key: "trig", type: "trigger", label: "trig" }],
  outputs: [{ key: "out", type: "audio", label: "out" }],
  knobs: [
    { key: "polynomial", label: "Polynomial", default: 142, min: 128, max: 255, step: 1, help: "The register's feedback taps, as an integer. Their menu offers only the sixteen MAXIMAL-LENGTH 8-bit values — 142, 149, 150, 166, 175, 177, 178, 180, 184, 195, 198, 212, 225, 231, 243, 250 (0x8E…0xFA) — and any of those visits all 255 states, so the burst never repeats inside itself. Anything else is legal and shorter, which is a different and duller sound rather than an error. A number rather than their dropdown so an equation can sweep it." },
  ],
};

// ── MODULATION ──────────────────────────────────────────────────────────────

export const AX_LFO_SPEC = {
  type: "audio_ax_lfo", module: "axLfo", title: "AX LFO", family: "modulation",
  icon: "mdi:wave", readout: "waveform",
  help: "Their `lfo/*` family, running at the hardware's real 3000 Hz control rate — its output is a STAIRCASE of 16-sample steps, not a smooth curve, and that texture is part of why an Axoloti patch sounds like one. Rate is pitch/64, so pitch 0 is 5.15 Hz.",
  inputs: [
    { key: "pitch", type: "number", label: "pitch" },
    { key: "reset", type: "trigger", label: "reset" },
    { key: "phase", type: "number", label: "phase" },
  ],
  outputs: [
    { key: "out", type: "audio", label: "wave" },
    { key: "sync", type: "audio", label: "sync" },
  ],
  knobs: [
    // `hz` IS OVERRIDDEN, and this is the one knob in the block where the shared
    // `PITCH` fragment would have LIED. The LFO's rate is mtof DIVIDED BY 64, so the
    // inherited conversion would put `0 st` at 330 Hz on the card when the oscillator
    // is running at 5.15. A wrong frequency is worse than none — it would be believed —
    // so the divisor is stated here beside the help that explains it.
    { key: "pitch", label: "Pitch", default: 0, ...PITCH, hz: (p) => semitonesToHz(p) / AX_LFO_PITCH_DIVISOR, help: "Semitones from E4, DIVIDED BY 64 — their `Phase += freq>>2` at 3000 Hz is exactly that. So 0 is 5.15 Hz, −24 is 1.29 Hz, and −60 is one cycle every 5.6 seconds." },
    {
      key: "waveform", label: "Waveform", default: "sine", discrete: true,
      options: ["sine", "saw", "square"],
      help: "THE THREE HAVE DIFFERENT RANGES, and that is theirs, not an oversight: `sine` is bipolar ±1, `saw` is a rising 0…1 ramp (`frac32.positive`), `square` is 0 or 1 and is high for the FIRST half of the cycle. Swapping waveform therefore changes a modulation's depth AND its centre, exactly as it does on the hardware.",
    },
    { key: "phase", label: "Reset phase", default: 0, min: 0, max: 1, step: 0.001, unit: " cyc", help: "Where the `reset` input restarts the cycle. Only `lfo/sine r` offers this on hardware; it is extended to all three waveforms here because a reset target is meaningful for any of them and an input that did nothing in two modes out of three would be a port that lies." },
  ],
};

export const AX_RAND_SPEC = {
  type: "audio_ax_rand", module: "axRand", title: "AX Random", family: "modulation",
  icon: "mdi:dice-5-outline", readout: "mode",
  help: "Their three `rand/uniform*` objects as one node: a random value at control rate, either free-running or held between triggers, either continuous or quantised to whole steps. Free + continuous is stepped noise; triggered + 8 steps is a random note chooser.",
  inputs: [
    { key: "trig", type: "trigger", label: "trig" },
    { key: "steps", type: "number", label: "steps" },
  ],
  outputs: [{ key: "out", type: "audio", label: "out" }],
  knobs: [
    {
      key: "mode", label: "Rate", default: "trig", discrete: true, options: ["free", "trig"],
      help: "`free` draws a new value every control tick (3000 times a second — this is noise, not a sequence). `trig` draws once on each rising edge of `trig` and HOLDS it, which is the sample-and-hold behaviour a sequencer wants.",
    },
    { key: "steps", label: "Steps", default: 0, min: 0, max: 65536, step: 1, help: "0 is their `uniform f`: a continuous value in [−1, 1). 1 or more is their `uniform i`: a whole number 0…steps−1, emitted through the platform's int32→frac32 coercion (`<<21`), so each step is 1/64 of full scale. STEPS ABOVE 64 THEREFORE EXCEED ±1 — that is their coercion, faithfully; keep it at or below 64 unless you are feeding something that wants the raw count." },
    { ...SEED },
  ],
};

export const AX_RAND_PINK_SPEC = {
  type: "audio_ax_rand_pink", module: "axRandPink", title: "AX Random Pink", family: "modulation",
  icon: "mdi:chart-bell-curve-cumulative", readout: "octaves",
  help: "`rand/pink oct`: pink noise at CONTROL rate, which is the most useful random modulator there is. Unlike white randomness it wanders — each new value is correlated with the last — so it drifts like a hand on a knob instead of jittering.",
  inputs: [],
  outputs: [{ key: "out", type: "audio", label: "out" }],
  knobs: [
    { key: "octaves", label: "Octaves", default: 7, min: 1, max: 7, step: 1, help: "How many halvings of rate the drift spans — fewer octaves is faster and shallower wandering. THEIR BUG, NOT REPRODUCED: below 7 their code scales the white term by the octave count while the buffers stay at 7, reaching eight times full scale; every term is scaled by 1/(octaves+1) here, which is byte-identical at 7." },
    { ...SEED },
  ],
};

export const AX_PULSE_DECAY_SPEC = {
  type: "audio_ax_pulse_decay", module: "axPulseDecay", title: "AX Decay", family: "modulation",
  icon: "mdi:chart-line-variant", readout: "decay",
  help: "`pulse/d`: an exponential decay from full scale on every trigger, computed at AUDIO rate — so unlike a control-rate envelope it can be short enough to be a click's shape rather than its amplitude. Wire it into a VCA gain, or into a pitch for a drum's blip.",
  inputs: [
    { key: "trig", type: "trigger", label: "trig" },
    { key: "decay", type: "number", label: "decay" },
  ],
  outputs: [{ key: "out", type: "audio", label: "env" }],
  knobs: [
    { key: "decay", label: "Decay rate", default: 0.05, min: 0, max: 1, step: 0.001, help: "A RATE, not a time, because that is what their `frac32.u.map` dial really controls: the envelope loses `decay/64` of itself every SAMPLE, so its time constant is −1/(sampleRate·ln(1 − decay/64)) seconds — about 0.4 ms at 1, 27 ms at 0.05, and forever at 0. Their dial reads 0…64; this reads 0…1 for the same span." },
  ],
};

export const AX_LFSR_SEQ_SPEC = {
  type: "audio_ax_lfsr_seq", module: "axLfsrSeq", title: "AX LFSR Sequencer", family: "modulation",
  icon: "mdi:shuffle-variant", readout: "polynomial",
  help: "`seq/lfsrseq`: a gate pattern that looks random and repeats EXACTLY. With a maximal-length tap the period is 2^bits − 1 steps — 511 for the default — so it never lands where a 16-step loop would, which is the whole trick of generative sequencing with one object.",
  inputs: [
    { key: "trig", type: "trigger", label: "clock" },
    { key: "reset", type: "trigger", label: "reset" },
    { key: "load", type: "trigger", label: "load" },
    { key: "lval", type: "number", label: "lval" },
  ],
  outputs: [{ key: "out", type: "audio", label: "gate" }],
  knobs: [
    { key: "polynomial", label: "Polynomial", default: 265, min: 1, max: 1023, step: 1, help: "The feedback taps as an integer; their menu lists 160 values from 0x9 (4-bit) to 0x3FC (10-bit). 265 (0x109) is a maximal-length 9-bit tap, period 511. A NON-maximal value is legal and gives a shorter pattern — and can walk the register to zero, where the output stays low until `reset`. That is their behaviour; `reset` is the way back." },
  ],
};

/**
 * EVERY AX-2 SPEC, sources first then modulation — the same ordering rule
 * core/audio_specs.AUDIO_SPECS follows, so the palette reads as one library
 * rather than as two lists that happen to be adjacent.
 *
 * THE BARREL LINE THIS NEEDS: `core/audio_specs.js`'s AUDIO_SPECS must spread
 * this array, and `plugins/audio_index.js`'s `audioPlugins` must spread the
 * matching plugin array, or these modules exist in the engine and nowhere the
 * author can reach — which is the half-registered failure that file's docblock
 * calls out. tests/port_ax2_test.js sweeps this array either way.
 */
export const BLOCK_SPECS = [
  AX_OSC_SPEC, AX_SUPERSAW_SPEC, AX_NOISE_SPEC, AX_PHASOR_SPEC, AX_LFSR_BURST_SPEC,
  AX_LFO_SPEC, AX_RAND_SPEC, AX_RAND_PINK_SPEC, AX_PULSE_DECAY_SPEC, AX_LFSR_SEQ_SPEC,
];
