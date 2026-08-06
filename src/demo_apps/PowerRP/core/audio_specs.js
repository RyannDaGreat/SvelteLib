/**
 * THE AUDIO MODULE SPECS — one declarative record per engine module, all 23.
 *
 * ── WHAT A SPEC IS ──────────────────────────────────────────────────────────
 * Everything that makes one audio node differ from another, and nothing else. The
 * SHAPE of an audio node plugin lives in core/audio_nodes.js; this file is the
 * twenty-three sets of values that shape is instantiated with. Splitting them means
 * a new module is a record here plus a two-line plugin file, and it means the
 * question "what ports does the reverb have?" has exactly one answer to read.
 *
 * ── THE PORT TYPES ARE THE ENGINE'S TRUTH, NOT A CONVENIENCE ────────────────
 * A port's declared type decides which drops core/nodeflow.js permits, so a spec
 * that flatters a module — declaring `number` on something that is really an
 * audio-rate input — would make the editor invite a connection that then sounds
 * wrong rather than refusing it. The rule applied throughout:
 *
 *   `audio`   — the port is an AudioNode carrying a signal. Every module output is
 *               audio, including the sequencer's `pitch` and `gate`: they are
 *               control SIGNALS on AudioNodes, not numbers the document can read.
 *   `number`  — the port is an AudioParam a wire can drive at control rate. These
 *               are the modulation inputs (a filter's `frequency`, a VCA's `gain`)
 *               and they are what an LFO is FOR. They accept audio too, by the
 *               coercion table.
 *   `trigger` — a gate: a rising edge means something happens (the ADSR's `gate`).
 *
 * `feedbackSafe` appears on exactly ONE port in this file. See DELAY_SPEC.
 *
 * ── RANGES ARE THE ENGINE'S CLAMPS, RESTATED ────────────────────────────────
 * Every numeric knob's min/max mirrors what synth/dsp.js clampParam actually
 * enforces (MIN_AUDIBLE_HZ/MAX_AUDIBLE_HZ, MIN_BPM/MAX_BPM, and the per-param
 * clamps in synth/modules.js). tests/audio_nodes_test.js asserts each declared
 * default is inside its own declared range, and that every declared knob is a param
 * the engine really has — a range that drifted from the clamp would be an Inspector
 * that lets you type a number the engine silently discards, which is the exact
 * "silent failure" the project forbids.
 *
 * ── `construct: true` — THE KNOB THAT CANNOT BE TURNED, SAID OUT LOUD ───────
 * Some module settings are fixed when the AudioNode is BUILT and have no setter at
 * all: a noise buffer's colour (the samples are generated once), a bell's preset
 * (it selects an FM recipe baked into the voice), a pad's reverb impulse response,
 * a clock's BPM (the engine exposes the derived `frequency` AudioParam instead), a
 * sequencer's step count. The cross-check below found every one of these by
 * comparing this file against synth/modules.js, and the honest options were three:
 *
 *   (a) drop the knob — but then the author cannot choose pink vs white noise at all;
 *   (b) declare it as an ordinary knob — but setParam would throw, or worse, the
 *       engine would accept it and nothing would happen, which is the silent
 *       failure this project forbids outright;
 *   (c) declare it AND declare that changing it REBUILDS the module.
 *
 * (c) is what `construct: true` means. The mirror reads it: a change to a
 * construct-time knob tears the module down and recreates it with the new value,
 * accepting the ~40 ms rewire and the loss of anything the old node was mid-way
 * through. That is honest — turning a noise node from pink to white genuinely IS a
 * new noise source — and it keeps the Inspector row truthful, because the row does
 * what it says. The alternative that was NOT taken: pretending these are live
 * knobs and letting the value diverge from the sound.
 *
 * Zero PowerRP-runtime and zero synth imports: this is data. The test that checks
 * it against the engine imports both, which is where a dependency on the engine
 * belongs — and it is what caught all six of these in the first place.
 */

// ── SOURCES ─────────────────────────────────────────────────────────────────
// Modules that generate signal from nothing. Every patch starts with one.

/** Frequency, the knob nearly every source has. Restated per module because the
 *  DEFAULT differs (an LFO's 2 Hz and an oscillator's 220 Hz are the same knob with
 *  very different homes) while the range is the engine's one audible clamp. */
const HZ = { min: 20, max: 20000, unit: " Hz" };
/** A level/gain knob: 0 to 1, the engine's universal amplitude convention. */
const LEVEL = { key: "level", label: "Level", default: 0.5, min: 0, max: 1, step: 0.01, help: "Output amplitude, 0 to 1. Every module's final gain — the honest place to quiet one voice without touching the patch." };

export const OSCILLATOR_SPEC = {
  type: "audio_oscillator", module: "oscillator", title: "Oscillator", family: "source",
  icon: "mdi:sine-wave", readout: "frequency",
  help: "A single-voice tone generator — the primitive every subtractive patch starts from. Wire its output into a filter to shape it.",
  inputs: [
    { key: "frequency", type: "number", label: "freq" },
    { key: "detune", type: "number", label: "detune" },
    { key: "level", type: "number", label: "level" },
  ],
  outputs: [{ key: "out", type: "audio", label: "out" }],
  knobs: [
    { key: "frequency", label: "Frequency", default: 220, ...HZ, help: "Pitch in hertz. 220 is A3; an octave up is double." },
    { key: "detune", label: "Detune", default: 0, min: -1200, max: 1200, step: 1, unit: "¢", help: "Offset in cents (100 = one semitone). Two oscillators a few cents apart beat against each other, which is what makes a tone sound thick rather than sterile." },
    { key: "waveform", label: "Waveform", default: "sine", discrete: true, options: ["sine", "triangle", "sawtooth", "square"], help: "Sine is a pure tone with no harmonics; sawtooth has every harmonic and is the classic subtractive starting point; square has odd harmonics only (hollow, clarinet-like)." },
    { ...LEVEL },
  ],
};

export const SUPERSAW_SPEC = {
  type: "audio_supersaw", module: "supersaw", title: "Supersaw", family: "source",
  icon: "mdi:waveform", readout: "frequency",
  help: "Many detuned sawtooth voices at once — the wide, shimmering pad oscillator. Its width comes from the voices beating against each other, so Spread is the knob that matters.",
  inputs: [{ key: "level", type: "number", label: "level" }],
  outputs: [{ key: "out", type: "audio", label: "out" }],
  knobs: [
    { key: "frequency", label: "Frequency", default: 110, ...HZ, help: "The centre pitch every voice detunes around." },
    { key: "spread", label: "Spread", default: 0.5, min: 0, max: 1, step: 0.01, help: "How far the voices detune apart. At 0 they collapse into one plain saw; the shimmer IS the disagreement." },
    { ...LEVEL, default: 0.35 },
  ],
};

export const NOISE_SPEC = {
  type: "audio_noise", module: "noise", title: "Noise", family: "source",
  icon: "mdi:grain", readout: "color",
  help: "Broadband noise — the raw material for wind, waves, whooshes and percussion. On its own it is static; swept through a filter it becomes weather.",
  inputs: [{ key: "level", type: "number", label: "level" }],
  outputs: [{ key: "out", type: "audio", label: "out" }],
  knobs: [
    { key: "color", label: "Colour", default: "pink", discrete: true, construct: true, options: ["white", "pink"], help: "CONSTRUCT-TIME: the noise buffer is generated once, so changing this REBUILDS the module. White has equal energy per hertz and sounds hissy and bright. Pink falls 3 dB per octave, matching how human hearing weights frequency — which is why pink is what surf, wind and rain actually sound like." },
    { ...LEVEL },
  ],
};

export const SAMPLER_SPEC = {
  type: "audio_sampler", module: "sampler", title: "Sampler", family: "source",
  icon: "mdi:file-music-outline", readout: "rate",
  help: "Plays an audio buffer on a seamless loop. The user's 'audio files should also be able to be looped' — a bed of recorded sound under a synthesised patch.",
  inputs: [{ key: "level", type: "number", label: "level" }],
  outputs: [{ key: "out", type: "audio", label: "out" }],
  knobs: [
    { key: "rate", label: "Rate", default: 1, min: 0.25, max: 4, step: 0.01, unit: "×", help: "Playback speed, which also shifts pitch — halving the rate drops an octave. There is no separate time-stretch: this is a tape speed knob, honestly." },
    { ...LEVEL, default: 0.6 },
  ],
};

export const DING_SPEC = {
  type: "audio_ding", module: "ding", title: "Ding", family: "source",
  icon: "mdi:bell-outline", readout: "preset",
  help: "The FM bell voice — the user's 'little metallic ding or dong ... or a pip or a pop or a clank'. It makes a sound when TRIGGERED, so it wants a clock or a sequencer upstream.",
  inputs: [
    // A METHOD PORT, not an AudioNode input. The engine's bell has no `gate`
    // AudioParam — striking it calls `engine.trigger(id, "gate", …)`, which builds a
    // fresh FM voice each time, because a struck bell is a new transient rather than
    // a continuously-running node being gated. The mirror routes a `method: true`
    // trigger port to that call instead of to a wire; the port still EXISTS on the
    // card so a clock can be patched to it, which is the whole point.
    { key: "gate", type: "trigger", label: "trig", method: true },
    // THE PITCH PORT (wave 3), and the reason a pitched-percussion patch is
    // possible at all. It is a real AudioParam input, so a sequencer's `pitch`
    // output wires straight into it and SUMS with the knob — the knob is an
    // OFFSET, exactly as it is on every other modulatable param in the engine.
    // Sampled at STRIKE time, not audio-rate: a bell's inharmonic partials are
    // fixed when it is struck (synth/modules.js dingModule states the full
    // reasoning), which is what preserves the per-strike voice semantics.
    { key: "frequency", type: "number", label: "pitch" },
    { key: "level", type: "number", label: "level" },
  ],
  outputs: [{ key: "out", type: "audio", label: "out" }],
  knobs: [
    // NOT the shared HZ range: this knob's floor is 0, not 20 Hz. It is an OFFSET
    // the `pitch` input sums into, and 0 ("the wire alone names the note") is its
    // most useful value in a sequenced patch — a 20 Hz floor would silently detune
    // every note by 20 Hz with nothing to see. Unwired it is still just the pitch,
    // and the strike itself clamps to the audible band where it really is one.
    { key: "frequency", label: "Frequency", default: 880, min: 0, max: 20000, unit: " Hz", help: "The bell's fundamental, and the OFFSET the `pitch` input adds to — wire a sequencer in and this transposes it, so set it to 0 to hear the sequence as written; leave it unwired and this is simply the pitch. Struck metal is inharmonic, so this is the pitch you hear rather than a harmonic series root." },
    { key: "preset", label: "Character", default: "ding", discrete: true, construct: true, options: ["ding", "pip", "clank", "gong"], help: "CONSTRUCT-TIME (the preset selects an FM recipe baked into the voice, so changing it rebuilds the module). Four FM bell recipes, from the short bright pip to the long inharmonic gong. They differ in modulator ratio and decay, which is what makes one read as glass and another as metal." },
    { ...LEVEL, default: 0.42 },
  ],
};

export const PAD_SPEC = {
  type: "audio_pad", module: "pad", title: "Ambience Pad", family: "source",
  icon: "mdi:cloud-outline", readout: "frequency", w: 165,
  help: "A WHOLE SYNTH IN ONE MODULE (the user's 'You can have a module that's just an entire synth'): detuned voices, a sub octave, a slow filter sweep and its own reverb. Patch it straight to an output and the slide already sounds like space.",
  inputs: [
    { key: "level", type: "number", label: "level" },
    { key: "cutoff", type: "number", label: "cutoff" },
  ],
  outputs: [{ key: "out", type: "audio", label: "out" }],
  knobs: [
    { key: "frequency", label: "Frequency", default: 82.41, ...HZ, help: "The root. 82.41 is E2 — low enough to sit under speech, which is what makes a pad ambience rather than melody." },
    { key: "cutoff", label: "Cutoff", default: 900, ...HZ, help: "The internal filter's centre. The pad's own slow LFO sweeps around this, so it sets where the motion happens." },
    { key: "motion", label: "Motion", default: 0.06, min: 0.001, max: 2, step: 0.001, unit: " Hz", help: "Speed of that internal sweep. 0.06 Hz is one pass every 17 seconds — slow enough to feel like drift rather than like an effect." },
    { key: "reverb", label: "Reverb", default: 0.5, min: 0, max: 1, step: 0.01, help: "Wet level of the pad's built-in space." },
    { key: "space", label: "Space", default: "deepSpace", discrete: true, construct: true, options: ["hall", "plate", "deepSpace"], help: "CONSTRUCT-TIME: the impulse response is convolved into the pad's own reverb at build, so changing it rebuilds the module. Which space the pad sits in." },
    { ...LEVEL, default: 0.4 },
  ],
};

/**
 * THE VOICE-COUNT RANGE, RESTATED — synth/voices.js is the definition and this
 * is its echo, for the same reason every other range in this file echoes a
 * clampParam: THIS FILE MAY NOT IMPORT synth/** (stated at the top — it is data,
 * and core/ must run in bare node without an AudioContext anywhere in its import
 * graph). tests/poly_voices_test.js asserts the two agree, which is what makes
 * the restatement checkable rather than a second opinion waiting to drift.
 */
const POLY_VOICES_DEFAULT = 8;
const POLY_VOICES_MIN = 1;
const POLY_VOICES_MAX = 16;

/**
 * THE POLYPHONIC PAD — the module a keyboard plays.
 *
 * ── WHY IT IS SEPARATE FROM PAD_SPEC ────────────────────────────────────────
 * "Polyphonic demos are important" (user, 2026-08-03). The Ambience Pad is a
 * DRONE: one `frequency` knob, sounding from the moment it is patched, which is
 * what SPACEY_PAD_DRONE relies on. This module has no frequency knob at all and
 * is SILENT at rest — it has a `pitch` input and a `gate`, and it sounds only
 * what is played into it. Those are different instruments that share a timbre.
 *
 * `gate` is a METHOD port, exactly like the ding's: a note is engine.noteOn /
 * engine.noteOff, not an AudioNode connection, because a voice ALLOCATION is a
 * decision (which slot, who is stolen) and a wire carries no decisions. `pitch`
 * is an ordinary number input and is READ AT NOTE-ON, the same seam and the same
 * reasoning as the ding's frequency: a held chord whose voices all glide when the
 * pitch input moves is a siren, not a chord.
 *
 * `voices` is CONSTRUCT-TIME because every voice is built eagerly (see
 * synth/modules.js polyPadModule — a voice built inside the note-on handler
 * would allocate on the gesture path), so changing the count genuinely is a new
 * instrument.
 */
export const POLY_PAD_SPEC = {
  type: "audio_poly_pad", module: "polyPad", title: "Poly Pad", family: "source",
  icon: "mdi:piano", readout: "voices", w: 165,
  // POLY: this module takes NOTES (engine.noteOn/noteOff with a voice pool
  // behind them), not strikes. core/live_control.noteRoutes reads this to decide
  // whether a keyboard's gate becomes a note or a one-shot trigger, and
  // tests/control_nodes_test.js asserts the flag agrees with the engine module
  // actually declaring noteOn — a spec claiming polyphony the module cannot
  // deliver would be a chord that plays one note with nothing to explain it.
  poly: true,
  help: "A POLYPHONIC pad — several notes at once. It makes no sound on its own: wire a Keyboard's pitch and gate into it and play. When more keys are held than it has voices, the OLDEST sounding note is stolen.",
  inputs: [
    { key: "pitch", type: "number", label: "pitch" },
    { key: "gate", type: "trigger", label: "gate", method: true },
    { key: "level", type: "number", label: "level" },
    { key: "cutoff", type: "number", label: "cutoff" },
  ],
  outputs: [{ key: "out", type: "audio", label: "out" }],
  knobs: [
    { key: "voices", label: "Voices", default: POLY_VOICES_DEFAULT, min: POLY_VOICES_MIN, max: POLY_VOICES_MAX, step: 1, construct: true, help: "How many notes may sound at once. CONSTRUCT-TIME: every voice is built up front, so changing this rebuilds the module. Press more keys than this and the oldest note is stolen." },
    { key: "cutoff", label: "Cutoff", default: 1400, ...HZ, help: "The shared filter's corner. One filter for the whole instrument, not one per voice — a chord already moves." },
    { key: "motion", label: "Motion", default: 0.09, min: 0.001, max: 2, step: 0.001, unit: " Hz", help: "Speed of the shared filter sweep." },
    { key: "attack", label: "Attack", default: 0.12, min: 0.001, max: 4, step: 0.001, unit: " s", construct: true, help: "How long a note takes to reach full level. CONSTRUCT-TIME: read when the voice envelope is scheduled from the module's own build parameters." },
    { key: "release", label: "Release", default: 0.45, min: 0.01, max: 8, step: 0.01, unit: " s", construct: true, help: "How long a released note takes to fade. CONSTRUCT-TIME, as attack." },
    { ...LEVEL, default: 0.3 },
  ],
};

// ── FILTERS ─────────────────────────────────────────────────────────────────
// Modules that shape a spectrum which already exists.

export const FILTER_SPEC = {
  type: "audio_filter", module: "filter", title: "Filter", family: "filter",
  icon: "mdi:filter-variant", readout: "frequency",
  help: "The workhorse. Wire an LFO into its `freq` input and the sweep is the whoosh — that is the patch, not a module.",
  inputs: [
    { key: "in", type: "audio", label: "in" },
    { key: "frequency", type: "number", label: "freq" },
    { key: "Q", type: "number", label: "Q" },
  ],
  outputs: [{ key: "out", type: "audio", label: "out" }],
  knobs: [
    { key: "frequency", label: "Cutoff", default: 800, ...HZ, help: "The corner frequency — where the filter starts working." },
    { key: "Q", label: "Resonance", default: 1, min: 0.0001, max: 30, step: 0.1, help: "Emphasis at the corner. High Q makes the filter ring, which is what turns a sweep from a tone change into a vocal 'wow'." },
    { key: "type", label: "Type", default: "lowpass", discrete: true, options: ["lowpass", "highpass", "bandpass", "notch", "peaking", "lowshelf", "highshelf"], help: "Lowpass keeps the lows (the default for taming anything bright); highpass keeps the highs; bandpass keeps a slice, which is the one that makes noise sound like wind through a gap." },
  ],
};

export const EQ3_SPEC = {
  type: "audio_eq3", module: "eq3", title: "EQ3", family: "filter",
  icon: "mdi:tune-vertical", readout: "mid", w: 165,
  help: "Three-band shelving EQ: low shelf, mid peak, high shelf. The user's draggable parametric EQ GRAPH node is wave 3; this is the honest three-knob version of it.",
  inputs: [{ key: "in", type: "audio", label: "in" }],
  outputs: [{ key: "out", type: "audio", label: "out" }],
  knobs: [
    { key: "low", label: "Low", default: 0, min: -30, max: 30, step: 0.5, unit: " dB", help: "Low shelf gain." },
    { key: "mid", label: "Mid", default: 0, min: -30, max: 30, step: 0.5, unit: " dB", help: "Mid peak gain." },
    { key: "high", label: "High", default: 0, min: -30, max: 30, step: 0.5, unit: " dB", help: "High shelf gain." },
    { key: "lowFrequency", label: "Low Freq", default: 250, ...HZ, help: "Where the low shelf turns over." },
    { key: "midFrequency", label: "Mid Freq", default: 1000, ...HZ, help: "Centre of the mid peak." },
    { key: "highFrequency", label: "High Freq", default: 4000, ...HZ, help: "Where the high shelf turns over." },
    { key: "midQ", label: "Mid Q", default: 1, min: 0.1, max: 10, step: 0.1, help: "Width of the mid peak — low Q is a broad tilt, high Q is a surgical notch." },
  ],
};

export const BITCRUSH_SPEC = {
  type: "audio_bitcrush", module: "bitcrush", title: "Bitcrush", family: "filter",
  icon: "mdi:grid", readout: "bits",
  help: "Quantises amplitude and throws away sample rate — digital destruction. The artefacts are ALIASING, which is why a crushed sine grows harmonics that were never in it.",
  inputs: [
    { key: "in", type: "audio", label: "in" },
    { key: "bits", type: "number", label: "bits" },
    { key: "reduction", type: "number", label: "rate" },
  ],
  outputs: [{ key: "out", type: "audio", label: "out" }],
  knobs: [
    { key: "bits", label: "Bits", default: 8, min: 1, max: 16, step: 1, help: "Amplitude resolution. 16 is transparent; below about 6 the quantisation noise becomes the sound." },
    { key: "reduction", label: "Rate Divide", default: 4, min: 1, max: 64, step: 1, unit: "×", help: "Sample-and-hold factor. 1 passes through; higher values hold each sample longer, folding high frequencies down as aliases." },
  ],
};

export const QUANTIZE_SPEC = {
  type: "audio_quantize", module: "quantize", title: "Quantize", family: "filter",
  icon: "mdi:stairs", readout: "range",
  help: "Snaps a CONTROL signal to a musical scale. Put it between a random source and a pitch input and the noise becomes a melody that cannot play a wrong note.",
  inputs: [{ key: "in", type: "audio", label: "in" }],
  outputs: [{ key: "out", type: "audio", label: "out" }],
  knobs: [
    { key: "range", label: "Range", default: 24, min: 1, max: 60, step: 1, unit: " st", help: "How many semitones the incoming 0..1 signal spans." },
    { key: "scale", label: "Scale", default: "pentatonic", discrete: true, options: ["chromatic", "major", "minor", "pentatonic", "wholeTone"], help: "Which degrees are legal. Pentatonic is the honest generative-music trick: every note is consonant with every other, so a random pattern cannot go sour." },
  ],
};

// ── EFFECTS ─────────────────────────────────────────────────────────────────
// Modules that act on time and space rather than on spectrum.

export const DELAY_SPEC = {
  type: "audio_delay", module: "delay", title: "Delay", family: "effect",
  icon: "mdi:altimeter", readout: "time",
  help: "Ping-pong echo with damping — each repeat is darker than the last, the way a real reflection loses its highs.",
  inputs: [
    // ── THE ONE feedbackSafe PORT IN THE WHOLE FILE ─────────────────────────
    // NF-CORE refuses a connection that would close a directed cycle, because a
    // cycle in a PULL-BASED value evaluator means either an infinite loop or a
    // frame-N-1 dependency, and frame-N-1 state is what the determinism law
    // disqualifies. It reserved `feedbackSafe` as the declared escape hatch for the
    // case where a cycle is MEANINGFUL, and this is that case.
    //
    // WHY IT IS SOUND HERE AND NOWHERE ELSE SO FAR: a delay line's feedback loop is
    // a cycle in the AUDIO domain, where the graph is PUSH-based and this module
    // interposes a real time delay of at least one render quantum. The signal
    // arriving back at `in` is not "this frame's value computed circularly" — it is
    // a signal from measurably earlier, which is the entire point of an echo. No
    // value the document evaluates travels this edge, so nothing about property
    // state or Δt = 0 reproducibility is touched: the value evaluator still sees an
    // acyclic graph because audio ports carry no values through it at all.
    //
    // THE BAR FOR A FUTURE PORT TO DECLARE IT: the module must interpose an actual
    // delay of >= one render quantum in the audio path. A reverb qualifies in
    // principle (its impulse response is long) but does not need it, because nobody
    // patches a reverb's output back to its own input as a design. Declaring this on
    // a zero-delay module would create a real feedback explosion, which is a defect
    // in the sound rather than in the document, and therefore one no test here can
    // catch for you.
    //
    // THE BAR HAS NOW BEEN APPLIED ONCE, AND IT HELD (2026-08-06, R7-17 AX-3). The
    // ported `filter/fdbkcomb` declared this flag on the reasoning that a feedback
    // comb IS a feedback structure. It was removed, for two reasons worth keeping
    // because they generalise to the other ~300 nodes still to be ported:
    //   • A RECURSION INSIDE A MODULE IS NOT A CYCLE IN THE GRAPH. The comb's loop
    //     runs against a buffer its own AudioWorkletProcessor owns; nothing travels
    //     a wire, so there was never a refusal to be exempt from. `feedbackSafe`
    //     licenses an EXTERNAL patch back into the port, which is a claim about the
    //     graph and not about the DSP. Ask which loop the flag would permit.
    //   • THE BAR IS THE KNOB'S FLOOR, NOT ITS DEFAULT. The comb's delay defaults to
    //     1000 samples but reaches 1, so "it interposes a real delay line" is true of
    //     the default and false of the range. A module clears this bar only if EVERY
    //     reachable setting does.
    // Pinned by tests/audio_nodes_test.js's "declared on the delay's input and
    // NOWHERE else", which is what caught it.
    { key: "in", type: "audio", label: "in", feedbackSafe: true },
    { key: "time", type: "number", label: "time" },
    { key: "feedback", type: "number", label: "fb" },
  ],
  outputs: [{ key: "out", type: "audio", label: "out" }],
  knobs: [
    { key: "time", label: "Time", default: 0.32, min: 0.001, max: 4, step: 0.001, unit: " s", help: "Delay of the first repeat. Under about 30 ms it stops being an echo and becomes a comb filter." },
    { key: "feedback", label: "Feedback", default: 0.4, min: 0, max: 0.95, step: 0.01, help: "How much of the output returns to the input. Capped below 1 on purpose: at 1 the echo never decays and the level climbs until it clips." },
    { key: "damping", label: "Damping", default: 3000, ...HZ, help: "Lowpass inside the feedback loop. Each repeat loses highs, which is why a damped delay sits behind a mix instead of fighting it." },
    { key: "wet", label: "Wet", default: 0.4, min: 0, max: 1, step: 0.01, help: "Level of the delayed signal." },
    { key: "dry", label: "Dry", default: 1, min: 0, max: 1, step: 0.01, help: "Level of the untouched signal." },
  ],
};

export const REVERB_SPEC = {
  type: "audio_reverb", module: "reverb", title: "Reverb", family: "effect",
  icon: "mdi:blur", readout: "character",
  help: "Convolution reverb with GENERATED impulse responses. 'deepSpace' is the one the user's spacey-ambience brief is about.",
  inputs: [
    { key: "in", type: "audio", label: "in" },
    { key: "wet", type: "number", label: "wet" },
  ],
  outputs: [{ key: "out", type: "audio", label: "out" }],
  knobs: [
    { key: "character", label: "Character", default: "hall", discrete: true, options: ["hall", "plate", "deepSpace"], help: "Hall is a room; plate is the dense bright studio classic; deepSpace is a very long diffuse tail with no early reflections — nothing to tell you how big the room is, which is what makes it read as space rather than as a place." },
    { key: "wet", label: "Wet", default: 0.4, min: 0, max: 1, step: 0.01, help: "Level of the reverberated signal." },
    { key: "dry", label: "Dry", default: 0.8, min: 0, max: 1, step: 0.01, help: "Level of the untouched signal." },
    { key: "preDelay", label: "Pre-delay", default: 0.02, min: 0, max: 0.5, step: 0.001, unit: " s", help: "Gap before the tail starts. A few tens of milliseconds keeps the dry sound legible in front of a big reverb." },
  ],
};

// ── MODULATION ──────────────────────────────────────────────────────────────
// The control plane: modules that drive other modules rather than being heard.

export const LFO_SPEC = {
  type: "audio_lfo", module: "lfo", title: "LFO", family: "modulation",
  icon: "mdi:wave", readout: "frequency",
  help: "A sub-audio oscillator for MODULATING things. Its output into a filter's `freq` is the single most useful patch in the whole library.",
  inputs: [
    { key: "frequency", type: "number", label: "rate" },
    { key: "depth", type: "number", label: "depth" },
  ],
  outputs: [{ key: "out", type: "audio", label: "out" }],
  knobs: [
    { key: "frequency", label: "Rate", default: 0.2, min: 0.001, max: 40, step: 0.001, unit: " Hz", help: "Cycles per second. Below ~0.1 Hz it reads as drift; above ~20 Hz it stops being modulation and becomes a tone." },
    { key: "depth", label: "Depth", default: 200, min: 0, max: 10000, step: 1, help: "How far the output swings. The units are the TARGET's units — patched to a cutoff this is hertz, patched to a gain it is amplitude, so a depth that is right for one target is wrong for another." },
    { key: "waveform", label: "Waveform", default: "sine", discrete: true, options: ["sine", "triangle", "sawtooth", "square"], help: "Sine and triangle sweep smoothly; square jumps between two values, which is how you get an on/off gate out of an LFO." },
  ],
};

export const ADSR_SPEC = {
  type: "audio_adsr", module: "adsr", title: "Envelope", family: "modulation",
  icon: "mdi:chart-bell-curve", readout: "attack",
  help: "Attack/Decay/Sustain/Release with proper retrigger. Wire a gate in and its output into a VCA's `gain` — that is how a sound gets a shape instead of just switching on.",
  inputs: [
    { key: "gate", type: "trigger", label: "gate" },
    { key: "attack", type: "number", label: "A" },
    { key: "decay", type: "number", label: "D" },
    { key: "sustain", type: "number", label: "S" },
    { key: "release", type: "number", label: "R" },
  ],
  outputs: [{ key: "out", type: "audio", label: "out" }],
  knobs: [
    { key: "attack", label: "Attack", default: 0.01, min: 0.001, max: 10, step: 0.001, unit: " s", help: "Time to reach full level. A few milliseconds is a pluck; several seconds is a pad swelling in." },
    { key: "decay", label: "Decay", default: 0.2, min: 0.001, max: 10, step: 0.001, unit: " s", help: "Time to fall from full to the sustain level." },
    { key: "sustain", label: "Sustain", default: 0.6, min: 0, max: 1, step: 0.01, help: "The level held while the gate stays high. This is a LEVEL, not a time — the one ADSR stage that is." },
    { key: "release", label: "Release", default: 0.4, min: 0.001, max: 20, step: 0.001, unit: " s", help: "Time to fall to silence after the gate drops." },
    { key: "retrigger", label: "Retrigger", default: 1, min: 0, max: 1, step: 1, help: "1 restarts the envelope from its current level on a new gate (legato-safe); 0 ignores gates while one is already running." },
  ],
};

export const VCA_SPEC = {
  type: "audio_vca", module: "vca", title: "VCA", family: "modulation",
  icon: "mdi:volume-medium", readout: "gain",
  help: "A voltage-controlled amplifier: signal in, gain in, product out. The module that turns an envelope into a sound's shape.",
  inputs: [
    { key: "in", type: "audio", label: "in" },
    { key: "gain", type: "number", label: "gain" },
  ],
  outputs: [{ key: "out", type: "audio", label: "out" }],
  knobs: [{ key: "gain", label: "Gain", default: 1, min: 0, max: 4, step: 0.01, help: "Multiplier applied to the input. Above 1 amplifies, which can clip — the output limiter catches it, but quieter sources sound better than a caught one." }],
};

export const MIXER_SPEC = {
  type: "audio_mixer", module: "mixer", title: "Mixer", family: "modulation",
  icon: "mdi:tune", readout: "level1",
  help: "Four inputs summed, each with its own level. The honest way to combine voices — and note that an OUTPUT module already sums everything patched to it, so this is for controlling the balance, not for making summing possible.",
  inputs: [
    { key: "in1", type: "audio", label: "1" }, { key: "level1", type: "number", label: "lv1" },
    { key: "in2", type: "audio", label: "2" }, { key: "level2", type: "number", label: "lv2" },
    { key: "in3", type: "audio", label: "3" }, { key: "level3", type: "number", label: "lv3" },
    { key: "in4", type: "audio", label: "4" }, { key: "level4", type: "number", label: "lv4" },
  ],
  outputs: [{ key: "out", type: "audio", label: "out" }],
  knobs: [
    { key: "level1", label: "Level 1", default: 1, min: 0, max: 2, step: 0.01, help: "Channel 1 gain." },
    { key: "level2", label: "Level 2", default: 1, min: 0, max: 2, step: 0.01, help: "Channel 2 gain." },
    { key: "level3", label: "Level 3", default: 1, min: 0, max: 2, step: 0.01, help: "Channel 3 gain." },
    { key: "level4", label: "Level 4", default: 1, min: 0, max: 2, step: 0.01, help: "Channel 4 gain." },
    { key: "master", label: "Master", default: 1, min: 0, max: 2, step: 0.01, help: "Gain applied to the sum, after the four channels." },
  ],
};

export const CLOCK_SPEC = {
  type: "audio_clock", module: "clock", title: "Clock", family: "modulation",
  icon: "mdi:metronome", readout: "bpm",
  help: "A tempo pulse. The user's 'when a clock goes from low to high, it triggers some event' — patch it into a Trigger or a Ding's gate.",
  inputs: [],
  outputs: [{ key: "out", type: "audio", label: "out" }],
  knobs: [{ key: "bpm", label: "Tempo", default: 90, min: 20, max: 300, step: 1, unit: " BPM", construct: true, help: "CONSTRUCT-TIME: the engine exposes the DERIVED `frequency` AudioParam rather than a bpm setter, so a tempo change rebuilds the clock. Beats per minute. The engine's shared scheduler runs on the AUDIO clock, not a JS timer, so this stays sample-accurate while the page does other work." }],
};

export const SEQUENCER_SPEC = {
  type: "audio_sequencer", module: "sequencer", title: "Sequencer", family: "modulation",
  icon: "mdi:view-grid-outline", readout: "stepCount", w: 165,
  help: "A 16-step pattern emitting PITCH and GATE. The piano-roll editing surface the user asked for is wave 3; this is the module underneath it.",
  inputs: [],
  outputs: [
    { key: "pitch", type: "audio", label: "pitch" },
    { key: "gate", type: "audio", label: "gate" },
  ],
  knobs: [
    { key: "stepCount", label: "Steps", default: 16, min: 1, max: 32, step: 1, construct: true, help: "CONSTRUCT-TIME: the step array is sized at build, so changing the count rebuilds the sequencer. Pattern length. Lengths that do not divide evenly into the bar are how a sequence stops sounding like a loop." },
  ],
};

export const SAMPLE_HOLD_SPEC = {
  type: "audio_sample_hold", module: "sampleHold", title: "Sample & Hold", family: "modulation",
  icon: "mdi:stairs-up", readout: null,
  help: "Samples its input whenever it is triggered and HOLDS that value until the next trigger. Noise into sample-and-hold is the classic random-stepped-voltage source.",
  inputs: [
    { key: "in", type: "audio", label: "in" },
    { key: "trigger", type: "trigger", label: "trig" },
  ],
  outputs: [{ key: "out", type: "audio", label: "out" }],
  knobs: [],
};

export const TRIGGER_SPEC = {
  type: "audio_trigger", module: "trigger", title: "Trigger", family: "modulation",
  icon: "mdi:flash-outline", readout: "pulseMs",
  help: "Rising-edge detector with Schmitt hysteresis. Turns any signal crossing a threshold into a clean pulse — the user's 'every time it goes from low to high triggers'.",
  inputs: [{ key: "in", type: "audio", label: "in" }],
  outputs: [{ key: "out", type: "trigger", label: "trig" }],
  knobs: [
    { key: "pulseMs", label: "Pulse", default: 5, min: 1, max: 200, step: 1, unit: " ms", help: "Width of the emitted pulse. The HYSTERESIS is why this module exists rather than a bare comparison: a signal wobbling around one threshold would fire dozens of times, so the rising and falling thresholds differ." },
  ],
};

// ── ANALYSIS ────────────────────────────────────────────────────────────────
// Modules that MEASURE without changing. Both pass their input straight through,
// so inserting one is always safe. These are the two nodes with LIVE OVERLAYS.

export const METER_SPEC = {
  type: "audio_meter", module: "meter", title: "Level", family: "analysis",
  icon: "mdi:signal", readout: null, overlay: "meter", w: 120,
  help: "A level meter that passes its input through untouched. The user's 'audio nodes that show volume that bounce up and down like level indicators' — its bar is LIVE while audio runs and a static scale when it does not.",
  inputs: [{ key: "in", type: "audio", label: "in" }],
  outputs: [{ key: "out", type: "audio", label: "out" }],
  knobs: [],
};

/**
 * THE LEGAL BIN COUNTS, powers of two — Web Audio's `fftSize` range (32…32768)
 * halved, because `frequencyBinCount` is `fftSize / 2` and BINS are what the
 * author is choosing ("num freqs", R7-19).
 *
 * A `discrete` row rather than a number with a step, because the set really is
 * discrete: an FFT of a non-power-of-two size is not a slower FFT, it is a
 * different algorithm, and Web Audio simply refuses one. A number row would
 * invite typing 1000 and then explain itself with an error.
 *
 * RESTATED HERE rather than imported from synth/spectrum.js, which owns the
 * clamp: this file may not import synth/** (see the header — it is data, and
 * core/ must run in bare node). tests/audio_nodes_test.js checks every option
 * against the engine's own gate, which is where a dependency on the engine
 * belongs. The floor starts at 64 rather than at the engine's 16 because a
 * 16-bin spectrogram has fewer bins than the display has rows.
 */
const SPECTRUM_BIN_OPTIONS = ["64", "128", "256", "512", "1024", "2048", "4096", "8192", "16384"];

/**
 * THE WINDOW FUNCTIONS, restated from synth/spectrum.js SPECTRUM_WINDOWS for the
 * same reason and under the same cross-check.
 */
const SPECTRUM_WINDOW_OPTIONS = ["rectangular", "hann", "hamming", "blackman", "blackmanHarris"];

export const SPECTRUM_SPEC = {
  type: "audio_spectrum", module: "spectrum", title: "Spectrum", family: "analysis",
  icon: "mdi:chart-histogram", readout: null, overlay: "spectrum", w: 200,
  help: "A flowing spectrogram of whatever passes through it — the user's 'spectrogram analyzers that can visualize the audio coming out of some node'. Frequency runs bottom to top, time scrolls right to left.",
  inputs: [{ key: "in", type: "audio", label: "in" }],
  outputs: [{ key: "out", type: "audio", label: "out" }],
  // ── TWO KNOBS, AND THEY ARE THE **MEASUREMENT** (R7-19) ─────────────────────
  // The other half of that requirement — the colour map, the scroll speed, the
  // frequency axis and the dB window — is NOT here, because none of it reaches
  // the engine. Those are declared in core/analysis_display.js beside the drawing
  // they modify; a knob that is not an engine param would fail this file's own
  // contract (tests/audio_nodes_test.js: "every declared knob is a param the
  // engine module really exposes") and be a phantom leaf.
  knobs: [
    { key: "bins", label: "Frequency bins", default: "1024", discrete: true, construct: true, options: SPECTRUM_BIN_OPTIONS, help: "CONSTRUCT-TIME: an analyser's transform size cannot change without resizing its buffers, so this rebuilds the module and the waterfall restarts. How finely the spectrum is measured — the FFT is twice this many points. MORE BINS IS NOT SIMPLY BETTER: it buys frequency resolution by spending TIME resolution, because each transform needs twice as many samples, so a fast run of notes smears. 1024 at 48 kHz resolves about 23 Hz per bin over a 43 ms window. The cost also grows: 16384 bins is roughly sixteen times the work of the default." },
    { key: "window", label: "Window", default: "blackman", discrete: true, construct: true, options: SPECTRUM_WINDOW_OPTIONS, help: "CONSTRUCT-TIME (the weights are tabulated once, at the transform's size). How the sample slice is tapered before the transform. An FFT assumes its input repeats forever; a slice that does not join up with itself sprays energy across every bin, and the taper is what stops it. 'rectangular' is NO taper — the sharpest peaks and the worst smear. 'hann' is the general-purpose choice, 'hamming' is better right beside a peak and worse far from it, 'blackman' is what the browser's own analyser hard-wires (hence the default), and 'blackmanHarris' is for finding something quiet next to something very loud." },
  ],
};

// ── OUTPUT ──────────────────────────────────────────────────────────────────

export const OUTPUT_SPEC = {
  type: "audio_output", module: "output", title: "Output", family: "output",
  icon: "mdi:speaker", readout: "volume",
  help: "Where sound leaves, through a limiter. MULTIPLE OUTPUTS SUM (user ruling, ADDENDUM 10: 'If we have multiple audio outputs by the way, we'll just add them all together') — N of these coexist and are never an error.",
  inputs: [{ key: "in", type: "audio", label: "in" }],
  outputs: [],
  knobs: [{ key: "volume", label: "Volume", default: 0.7, min: 0, max: 1, step: 0.01, help: "Master level for this output, before the limiter." }],
};

/**
 * EVERY SPEC, in the order a patch is usually built: sources, then things that
 * shape them, then the things that watch, then the way out.
 *
 * This array is what plugins/index.js registers from and what
 * tests/audio_nodes_test.js sweeps, so a module that is written but not listed here
 * simply does not exist — which is the intended failure mode (a half-registered
 * module that appears in one place and not another is worse).
 */
import { PORT_BLOCK_SPECS } from "./audio_blocks.js"; // the ported-node blocks (R7-17); see the PORT-BLOCK CONTRACT there

export const AUDIO_SPECS = [
  ...PORT_BLOCK_SPECS,
  OSCILLATOR_SPEC, SUPERSAW_SPEC, NOISE_SPEC, SAMPLER_SPEC, DING_SPEC, PAD_SPEC, POLY_PAD_SPEC,
  FILTER_SPEC, EQ3_SPEC, BITCRUSH_SPEC, QUANTIZE_SPEC,
  DELAY_SPEC, REVERB_SPEC,
  LFO_SPEC, ADSR_SPEC, VCA_SPEC, MIXER_SPEC, CLOCK_SPEC, SEQUENCER_SPEC, SAMPLE_HOLD_SPEC, TRIGGER_SPEC,
  METER_SPEC, SPECTRUM_SPEC,
  OUTPUT_SPEC,
];
