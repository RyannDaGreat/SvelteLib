/**
 * THE VC-1 MODULE SPECS — the ported VCV Rack / Mutable Instruments nodes.
 *
 * ── WHAT THIS FILE IS ───────────────────────────────────────────────────────
 * core/audio_specs.js's vocabulary applied to the AudibleInstruments set. Same record
 * shape, same rules, same reader (`core/audio_nodes.audioNodePlugin`): a spec is the
 * values that make one module differ from its neighbours, and NOTHING about how it
 * sounds. The DSP is `synth/vc1_kernels.js`, whose docblocks carry the derivation record
 * — which C++ file, which function, the recurrence in float, and every deviation by
 * number — and each `help` below points at it rather than repeating it.
 *
 * A SECOND (well, fourth) specs file rather than more rows in the first, for the reason
 * `audio_specs_ax2.js` gives: several agents land ported module sets concurrently and one
 * shared file is one merge conflict per agent per save. The barrel stays one roster.
 *
 * **THIS FILE MAY NOT IMPORT synth/**** (core must run in bare node), so every option
 * list below is RESTATED from the kernels' own `CLOUDS_PLAYBACK_MODES` /
 * `CLOUDS_QUALITIES` / `RINGS_MODELS` and pinned against them by `tests/port_vc1_test.js`.
 *
 * ── UNITS: THE ONE DECISION, AND WHERE TO READ IT ───────────────────────────
 * `synth/vc1_kernels.js`'s deviation D1 states the voltage scaling once, in four clauses:
 * an `audio` wire is Rack volts / 5 (so our wire IS Mutable's internal float and both of
 * the wrapper's conversions vanish); a `number` CV wire is in the KNOB's OWN UNITS and
 * sums with the knob; a `number` PITCH wire is in SEMITONES (`12 · volts`); and a
 * gate/trigger port carries 0…1 rather than volts/5, because this project's trigger
 * convention predates the port. Every knob below is in those units.
 *
 * ── TWO SPELLINGS THAT LOOK LIKE MISTAKES AND ARE NOT ───────────────────────
 * 1. PORT KEYS COME FROM THE C++ `enum InputIds` / `enum OutputIds`, lowercased. So
 *    Rings' pitch port is `pitch` while its tuning knob is `frequency` (the enum says
 *    `PITCH_INPUT` and `FREQUENCY_PARAM`), and Branches' probability CV is `p1` because
 *    the enum says `P1_INPUT`. Keeping the enum's name is what lets a transcribed patch's
 *    cable list land without a translation table.
 * 3. PORT TYPES ARE DECIDED BY WHAT THE MODULE DOES WITH THE SIGNAL, not by what a cable
 *    carries, and the choice is LOAD-BEARING because `core/nodeflow.COERCIONS` has no
 *    `audio -> trigger` entry. So:
 *      - A clock or gate OUTPUT is `trigger` (Branches' four, Marbles' t1/t2/t3). That type
 *        reaches `trigger`, `number` AND `audio` inputs — three coercions — where `audio`
 *        reaches only two. Declaring them `audio` was a REAL DEFECT in the first version of
 *        this file: it made `Marbles[t2] -> Rings[strum]` an illegal drop, and that cable is
 *        in the canonical granular-ambient deck. A `trigger`-typed port is still an ordinary
 *        AudioNode in the engine (`TRIGGER_SPEC` and `synth/modules.triggerModule` are the
 *        precedent), so the type costs nothing and buys the reach.
 *      - A gate INPUT the module EDGE-DETECTS is `trigger`: Rings' `strum` (the wrapper
 *        computes `strum && !lastStrum`), Clouds' `trig` (latched then cleared per block),
 *        Branches' `in1`/`in2`.
 *      - A gate INPUT the module reads as a SUSTAINED LEVEL is `number`: Clouds' `freeze`
 *        and Supercell's `hold` are `p->freeze = … || voltage >= 1.0`, held for as long as
 *        the signal is high. A `number` input accepts every other type, which is right for
 *        something that is a state rather than an event.
 *      - A CV output is `audio` (Marbles' x1/x2/x3/y_out), because it is a continuous engine
 *        signal and `audio -> number` exists for whoever wants to read it as a value.
 * 4. MARBLES' Y OUTPUT IS SPELLED `y_out`, NOT `y`, AND THAT IS FORCED. An output port
 *    PUBLISHES A PROPERTY of its own name, and every item already stores `y` — its position.
 *    `tests/output_properties_test.js` catches the collision and its sentence is exactly
 *    right: "the output would silently shadow the stored value". The enum says `Y_OUTPUT`, so
 *    the port name would otherwise be `y`; `_out` is the smallest disambiguation that keeps
 *    the enum's letter, and the LABEL on the card still reads "y".
 * 2. WHERE A PORT AND A KNOB SHARE A NAME THEY SHARE A PARAM and sum on it, which is this
 *    project's convention (OSCILLATOR_SPEC's `frequency`). Where they would collide with
 *    DIFFERENT meanings the port keeps the enum's name and the knob is renamed: Rings'
 *    five attenuverters are `*_trim` knobs beside their `*_mod` CV ports, and each says so
 *    in its own `help` because the panel legend reads "Brightness CV".
 */

// ── SHARED KNOB FRAGMENTS ───────────────────────────────────────────────────

/**
 * THE SEED KNOB. Every "random" in this block is `stmlib::Random`, a pure LCG with no
 * hardware entropy — so unlike AX-2 this needed no substitution, only an initial state.
 * Rack seeds it once per plugin load and never again, which means a Rack patch is NOT
 * reproducible across launches and ours is (kernels' deviation D3).
 */
const SEED = {
  key: "seed", label: "Seed", default: 1, min: 0, max: 65535, step: 1, construct: true,
  help: "CONSTRUCT-TIME: the generator's state is set once, so changing this rebuilds the module. Mutable's own generator is `state = state·1664525 + 1013904223`, ported exactly — it reads no hardware, so this is the whole of it. Rack seeds it once at load and never again, so a Rack patch sounds different every launch; this one does not, which is the determinism law and also just better.",
};

/** A 0…1 CV input, in the same units as the knob it sums with (deviation D1 clause 2). */
const cv = (key, label) => ({ key, type: "number", label });

/**
 * Pure function. Rings' Frequency knob as hertz — for the readout, and DELIBERATELY NOT
 * `core/audio_nodes.semitonesToHz`.
 *
 * THE ORIGIN PROBLEM IS WORSE THAN TWO ORIGINS: it is one per module family. Axoloti's
 * semitone 0 is E4 (MIDI 64), which is what `semitonesToHz` implements; a VCV V/oct 0 V is
 * C4 (MIDI 60); and RINGS' knob is neither, because `Rings.cpp:154` computes
 * `tonic = 12 + knob` and `part.cc:504` then does `SemitonesToRatio(note − 69) · a3`. So the
 * knob is MIDI NOTE MINUS TWELVE and its default of 30 is MIDI 42, 92.4986 Hz. Reusing
 * either shared converter would put a wrong frequency on the card, and a wrong frequency is
 * worse than none because it would be believed.
 *
 * The knob keeps Mutable's origin rather than being re-based, because that is what lets a
 * harvested patch's dial number be copied across unchanged — which is the whole point of
 * porting rather than reimplementing.
 *
 * @param {number} knob - the Frequency knob, 0…60
 * @returns {number} hertz
 *
 * @example Math.abs(ringsKnobToHz(57) - 440) < 0.01 // true
 * @example Math.abs(ringsKnobToHz(30) - 92.4986) < 0.001 // true
 */
export function ringsKnobToHz(knob) {
  return 440 * Math.pow(2, (12 + knob - 69) / 12);
}

/** Ripples' frequency knob is stored as log2 of HERTZ (kernels' deviation P2), so its
 *  bounds are those two logs and not the frequencies. Restated here rather than imported
 *  because this file may not import synth/**; pinned by tests/port_vc1_test.js. */
export const RIPPLES_FREQ_KNOB_MIN = Math.log2(20);
export const RIPPLES_FREQ_KNOB_MAX = Math.log2(20000);

/**
 * Pure function. Ripples' Frequency knob as hertz, which for a log2-hertz knob is simply
 * `2^knob` — Rack renders it with `displayBase = 2` for the same reason.
 *
 * A FOURTH ORIGIN, and the simplest one: this knob is not in semitones at all, so it shares
 * nothing with `semitonesToHz` or with `ringsKnobToHz`. Stated because the origin problem in
 * this block is one converter per module family, not one per library.
 *
 * @param {number} knob - log2 of the cutoff in hertz
 * @returns {number} hertz
 *
 * @example Math.abs(ripplesKnobToHz(Math.log2(20)) - 20) < 1e-9 // true
 * @example Math.abs(ripplesKnobToHz(Math.log2(20000)) - 20000) < 1e-6 // true
 */
export function ripplesKnobToHz(knob) {
  return Math.pow(2, knob);
}

/**
 * THE WIDEST A PATCH-PLACEABLE NODE MAY BE. `core/audio_patches.js` lays a blueprint out on
 * a 210-unit column pitch and `tests/audio_patches_test.js` refuses a node wider than it —
 * a wider card overlaps its neighbour. My three knob-heavy modules all WANTED to be wider
 * (Supercell has 25 dials), and being wider is legal for a module a patch never places; but
 * Clouds, Marbles and Supercell are all placed by the selected decks, so the column wins.
 *
 * The knob band WRAPS instead, which is what the per-module floor in
 * `tests/node_resize_chrome_test.js` exists to accommodate: Supercell's own floor is 496,
 * and at or above it every dial is inside the card.
 */
const PATCH_COLUMN_W = 210;

/** An attenuverter trim: ±1, through `sign(x)·x²`, then ×3.3. That curve is Rack's
 *  `quadraticBipolar` and the 3.3 is the wrapper's own gain, so a trim at 0.3 passes
 *  about 30 % of a CV rather than 30 % of full scale. */
const TRIM = { min: -1, max: 1, step: 0.001, default: 0 };

// ── CLOUDS ──────────────────────────────────────────────────────────────────

export const VCV_CLOUDS_SPEC = {
  type: "audio_vcv_clouds", module: "vcvClouds", title: "VCV Clouds", family: "effect",
  icon: "mdi:cloud-outline", readout: "size", w: PATCH_COLUMN_W,
  help: "Mutable Instruments' granular processor, ported from its own DSP: a one-to-eight-second circular buffer, a pool of up to 57 grains each with its own playback rate, window and pan, an eight-allpass diffuser and a Griesinger reverb. NINE OF THE TWELVE SELECTED VCV DECKS ARE BUILT ON THIS. THE ONE THING TO KNOW BEFORE YOU TURN A KNOB: density is a V, not a ramp — 0.5 schedules NO grains at all, and the two halves reach the same density by different routes (deterministic below, probabilistic above).",
  inputs: [
    { key: "in_l", type: "audio", label: "L" },
    { key: "in_r", type: "audio", label: "R" },
    { key: "freeze", type: "number", label: "freeze" },
    { key: "trig", type: "trigger", label: "trig" },
    cv("position", "posn"),
    cv("size", "size"),
    { key: "pitch", type: "number", label: "pitch" },
    cv("density", "dens"),
    cv("texture", "text"),
    cv("blend", "blend"),
    cv("spread", "sprd"),
    cv("feedback", "fdbk"),
    cv("reverb", "verb"),
  ],
  outputs: [
    { key: "out_l", type: "audio", label: "L" },
    { key: "out_r", type: "audio", label: "R" },
  ],
  knobs: [
    { key: "position", label: "Position", default: 0.5, min: 0, max: 1, step: 0.001, help: "Where in the buffer grains are read from — 0 is the newest audio, 1 is the oldest. NOT the whole buffer: the reachable window shrinks as grain size and pitch grow, because a grain playing faster than the record head would otherwise overrun the newest audio and click once per buffer period." },
    { key: "size", label: "Grain size", default: 0.5, min: 0, max: 1, step: 0.001, help: "Grain length, `floor(1024·2^(4x))` samples at 32 kHz — 32 ms at the bottom, 512 ms at the top, four octaves in between. Short grains sound like texture, long ones like a slowed-down tape." },
    { key: "pitch", label: "Grain pitch", default: 0, min: -48, max: 48, step: 0.01, unit: " st", help: "Grain playback rate, in SEMITONES — Rack's knob is in OCTAVES over ±2, so MULTIPLY A STORED VCV VALUE BY 12 (kernels' deviation C2). The clamp at ±48 is the source's. This is the parameter a shimmer patch stands or falls on: +12 with feedback up is the whole trick." },
    { key: "inGain", label: "Input gain", default: 0.5, min: 0, max: 1, step: 0.001, help: "Level into the recording buffer, before anything else. It is also the buffer's exposure control: the buffer is 16-bit (or 8-bit µ-law at qualities 2 and 3), so recording quietly means recording noisily." },
    { key: "density", label: "Density", default: 0.5, min: 0, max: 1, step: 0.001, help: "A META-PARAMETER AND A V-SHAPE, which is the single most surprising thing about this module. 0.47…0.53 is a DEAD ZONE: no grains are scheduled except by `trig`. Below 0.47 grains are seeded by a strict phasor (regular, machine-like); above 0.53 by a coin (clustered, cloudlike). Both halves ramp density up from the gap, so turning past noon does not make it denser, it makes it RANDOM." },
    { key: "texture", label: "Texture", default: 0.5, min: 0, max: 1, step: 0.001, help: "TWO CONTROLS IN ONE, split at 0.75. Below it, the grain WINDOW: 0 is rectangular (each grain edge is an audible click) rising to a raised cosine at 0.75. Above it the window stays put and the DIFFUSER opens instead, smearing transients across eight allpasses. In looping-delay mode it is neither — there it is a tone control, a lowpass below noon and a highpass above." },
    { key: "blend", label: "Dry / wet", default: 0.5, min: 0, max: 1, step: 0.001, help: "Constant-power crossfade between the input and the processed signal. The table is nudged by 4 % at both ends so that 0 is really dry and 1 is really wet, which a plain sine fade would not be. Named `blend` because that is the panel's word and the CV port's enum name." },
    { key: "spread", label: "Stereo spread", default: 0, min: 0, max: 1, step: 0.001, help: "How far each grain's pan is randomised around centre. At 0 the two buffer channels are SUMMED into both outputs rather than passed through — so the image collapses toward mono, which is why a stereo source can sound narrower here than it went in." },
    { key: "feedback", label: "Feedback", default: 0, min: 0, max: 1, step: 0.001, help: "Sends the grain mixer's output back into the buffer, high-passed (20 Hz rising to 120) so a DC build-up cannot swing the whole buffer, and soft-limited. THE REVERB IS NOT FED BACK, deliberately. With FREEZE engaged this also drives the reverb amount up, which is what makes a frozen Clouds bloom instead of just holding." },
    { key: "reverb", label: "Reverb", default: 0, min: 0, max: 1, step: 0.001, help: "The Griesinger reverb after the grain mixer — four input allpasses then a figure-of-eight loop of two 2-allpass-plus-delay halves, with two slow LFOs smearing it. Its buffer is 12-BIT on purpose, so its tail has a floor you can hear; that is part of the sound and is reproduced rather than cleaned up." },
    {
      key: "playback", label: "Playback", default: "granular", discrete: true,
      options: ["granular", "loopingDelay"],
      help: "`granular` is the grain engine. `loopingDelay` is a delay whose time GLIDES toward Position at 0.00005 per sample (a seven-second slew — it sounds like tape, not like a jump), and which becomes a pitch-shiftable loop when frozen; there `trig` is a TAP, not a grain trigger. TWO OF THE FOUR MODES ARE MISSING AND THAT IS STATED RATHER THAN FAKED: `stretch` needs a WSOLA correlator and `spectral` needs a phase vocoder with an FFT, and neither was reached. A deck that selected one cannot be reproduced by this node.",
    },
    {
      key: "quality", label: "Quality", default: "stereo32k16bit", discrete: true, construct: true,
      options: ["stereo32k16bit", "mono32k16bit", "stereo16k8bit", "mono16k8bit"],
      help: "CONSTRUCT-TIME: it sizes the recording buffer, so changing it rebuilds the module. Buffer length and fidelity trade off exactly as on the hardware — 1 s stereo 16-bit, 2 s mono 16-bit, 4 s stereo 8-bit µ-law, 8 s mono 8-bit. The 8-bit settings also halve the engine's rate to 16 kHz and are NOT a lesser version of the first two: the µ-law crunch is what they are for.",
    },
    { ...SEED },
  ],
};

// ── SUPERCELL ───────────────────────────────────────────────────────────────

const SUPERCELL_CV = (key, label) => cv(`${key}_cv`, label);

export const VCV_SUPERCELL_SPEC = {
  type: "audio_vcv_supercell", module: "vcvSupercell", title: "VCV Supercell", family: "effect",
  icon: "mdi:cloud-braces", readout: "size", w: PATCH_COLUMN_W,
  help: "Grayscale's 'big Clouds': the SAME grain engine with a full control surface — the one blend knob split into four, an attenuverter on every CV input, input and output VCAs with mutes, and an internal random CV generator feeding the unpatched ones. **ITS SOURCE IS PROPRIETARY AND WAS NOT READ**; this is a documented parameter-superset built from the manual and the panel, and it reuses the Clouds engine rather than forking it. The consequence to know: a stored Supercell patch's knob values are positional and their index map is UNRESOLVED, so a Supercell deck must be re-dialled by ear rather than transcribed. The widely-repeated claim that Supercell has a bigger grain pool and per-grain reverb is WRONG — its pool and buffer are Clouds'.",
  inputs: [
    { key: "in_l", type: "audio", label: "L" },
    { key: "in_r", type: "audio", label: "R" },
    { key: "in_vca", type: "number", label: "in vca" },
    { key: "out_vca", type: "number", label: "out vca" },
    { key: "hold", type: "number", label: "hold" },
    { key: "trig", type: "trigger", label: "trig" },
    { key: "v_oct", type: "number", label: "v/oct" },
    SUPERCELL_CV("position", "posn"),
    SUPERCELL_CV("size", "size"),
    SUPERCELL_CV("pitch", "pitch"),
    SUPERCELL_CV("density", "dens"),
    SUPERCELL_CV("texture", "shape"),
    SUPERCELL_CV("feedback", "fdbk"),
    SUPERCELL_CV("pan", "pan"),
    SUPERCELL_CV("mix", "mix"),
    SUPERCELL_CV("space", "space"),
  ],
  outputs: [
    { key: "out_l", type: "audio", label: "L" },
    { key: "out_r", type: "audio", label: "R" },
  ],
  knobs: [
    { key: "position", label: "Position", default: 0.5, min: 0, max: 1, step: 0.001, help: "As Clouds'. Grayscale's panel calls it POSITION." },
    { key: "size", label: "Grain size", default: 0.5, min: 0, max: 1, step: 0.001, help: "Grain length, as Clouds' — 32 ms to 512 ms at 32 kHz over four octaves. Grayscale's panel calls it SIZE and it drives the same `lut_grain_size` table." },
    { key: "pitch", label: "Grain pitch", default: 0, min: -48, max: 48, step: 0.01, unit: " st", help: "Semitones, as Clouds'. Supercell splits pitch across TWO jacks: `v_oct` is exponential (semitones) and `pitch` is the linear one; both sum here." },
    { key: "density", label: "Density", default: 0.5, min: 0, max: 1, step: 0.001, help: "As Clouds', dead zone and all." },
    { key: "texture", label: "Shape", default: 0.5, min: 0, max: 1, step: 0.001, help: "Clouds' TEXTURE. Grayscale renames it SHAPE on the panel; the parameter is the same one." },
    { key: "mix", label: "Mix", default: 0.5, min: 0, max: 1, step: 0.001, help: "Clouds' dry/wet, on its own knob instead of behind a mode." },
    { key: "pan", label: "Pan", default: 0, min: 0, max: 1, step: 0.001, help: "Clouds' stereo spread, on its own knob." },
    { key: "feedback", label: "Feedback", default: 0, min: 0, max: 1, step: 0.001, help: "Clouds' feedback, on its own knob." },
    { key: "space", label: "Space", default: 0, min: 0, max: 1, step: 0.001, help: "Clouds' reverb, on its own knob. Grayscale calls it SPACE." },
    { key: "positionTrim", label: "Position CV", ...TRIM, help: "Attenuverter on the Position CV input. Supercell's defining addition over Clouds is that every CV input has one of these." },
    { key: "sizeTrim", label: "Size CV", ...TRIM, help: "Attenuverter on the Size CV input." },
    { key: "pitchTrim", label: "Pitch CV", ...TRIM, help: "Attenuverter on the linear Pitch CV input. Its result is multiplied by 12, so one wire unit through a fully-open trim is an octave." },
    { key: "densityTrim", label: "Density CV", ...TRIM, help: "Attenuverter on the Density CV input." },
    { key: "textureTrim", label: "Shape CV", ...TRIM, help: "Attenuverter on the Shape CV input." },
    { key: "mixTrim", label: "Mix CV", ...TRIM, help: "Attenuverter on the Mix CV input." },
    { key: "panTrim", label: "Pan CV", ...TRIM, help: "Attenuverter on the Pan CV input." },
    { key: "feedbackTrim", label: "Feedback CV", ...TRIM, help: "Attenuverter on the Feedback CV input." },
    { key: "spaceTrim", label: "Space CV", ...TRIM, help: "Attenuverter on the Space CV input." },
    { key: "inLevel", label: "Input level", default: 1, min: 0, max: 2, step: 0.01, help: "The input VCA's own level, multiplied by `1 + in vca` so the CV input is ADDITIVE (Grayscale's changelog 1.0.2 made it so). Park this at 0 to be driven by CV alone." },
    { key: "outLevel", label: "Output level", default: 1, min: 0, max: 2, step: 0.01, help: "The output VCA's level, additive with `out vca` the same way. Supercell runs 6 dB hotter than Clouds at unity, which is what the extra range is for." },
    { key: "inMute", label: "Input mute", default: 0, min: 0, max: 1, step: 1, help: "Silences the input to the engine. NOT the output: muting here lets a reverb tail ring out, which is what the manual says the output mute is for and is why it is implemented on this side." },
    { key: "outMute", label: "Output mute", default: 0, min: 0, max: 1, step: 1, help: "Silences the output VCA. Its counterpart on the input side is the one to reach for when you want a tail to ring out, since muting there leaves the reverb running — which is what Grayscale's manual says this pair is for." },
    { key: "randomEnabled", label: "Random CV", default: 0, min: 0, max: 1, step: 1, help: "The internal random CV generator, added to EVERY CV input before its attenuverter — which is how a Supercell plays itself with nothing patched. On the hardware it substitutes for an absent cable; a kernel cannot see cable presence, so it is a switch here (the same reasoning as Rings' three source knobs)." },
    { key: "randomFreq", label: "Random rate", default: 1, min: 1, max: 100, step: 0.1, unit: " Hz", help: "The random generator's step rate, over the manual's documented 1…100 Hz. It is a SEEDED sample-and-hold, not a wall clock, so a document renders the same wash every time." },
    { key: "playback", label: "Playback", default: "granular", discrete: true, options: ["granular", "loopingDelay"], help: "As Clouds'. Supercell's panel surfaces more modes than this port has; see Clouds' own note on the two that are missing." },
    { key: "quality", label: "Time", default: "stereo32k16bit", discrete: true, construct: true, options: ["stereo32k16bit", "mono32k16bit", "stereo16k8bit", "mono16k8bit"], help: "CONSTRUCT-TIME. Grayscale surfaces Clouds' hidden quality menu as a front-panel TIME switch reading 1 / 2 / 4 / 8 seconds; it is the same enum and the same four buffers." },
    { ...SEED },
  ],
};

// ── RINGS ───────────────────────────────────────────────────────────────────

export const VCV_RINGS_SPEC = {
  type: "audio_vcv_rings", module: "vcvRings", title: "VCV Rings", family: "filter",
  icon: "mdi:vibrate", readout: "frequency", w: 200,
  help: "Mutable Instruments' resonator: a bank of up to sixty band-pass modes, or a Karplus-Strong string, or a struck string with up to seven more ringing in sympathy. Feed it noise, a click, or anything at all. THE TWO OUTPUTS ARE NOT A STEREO PAIR — at polyphony 1 they are two PICKUPS on the same resonator, one reading the odd modes and one the even, measurably decorrelated (r = −0.001), which is why the canonical granular-ambient deck feeds them to Clouds as a stereo pair from a mono excitation. At polyphony 2 and 4 the same jacks carry alternating VOICES instead, and each carries `odd − even`: a different signal.",
  inputs: [
    { key: "in", type: "audio", label: "in" },
    { key: "strum", type: "trigger", label: "strum" },
    { key: "pitch", type: "number", label: "v/oct" },
    cv("frequency_mod", "freq"),
    cv("structure_mod", "struct"),
    cv("brightness_mod", "bright"),
    cv("damping_mod", "damp"),
    cv("position_mod", "posn"),
  ],
  outputs: [
    { key: "odd", type: "audio", label: "odd" },
    { key: "even", type: "audio", label: "even" },
  ],
  knobs: [
    { key: "frequency", label: "Frequency", default: 30, min: 0, max: 60, step: 0.01, unit: " st", hz: ringsKnobToHz, help: "The resonator's fundamental, as MIDI note − 12: the internal note is `12 + this + the v/oct wire`, so the default 30 is MIDI 42. That is Mutable's own origin and it is kept rather than re-based on C4, because keeping it is what lets a patch's dial number be copied across unchanged. QUANTISED TO WHOLE SEMITONES when Note source is `external`, so a tracked patch stays in tune while a free-running one can be swept." },
    { key: "structure", label: "Structure", default: 0.5, min: 0, max: 0.9995, step: 0.0001, help: "INHARMONICITY, and it feels like four different controls because it is four regions of one table. Below 0.25 the partials COMPRESS toward the fundamental (a membrane). 0.25…0.3 is exactly harmonic (a string). 0.3…0.9 stretches them exponentially (a stiff bar). Above 0.9 it sweeps to partials at whole multiples of two (a bell). For the string models it is DISPERSION instead, with its own dead zone at 0.24…0.26." },
    { key: "brightness", label: "Brightness", default: 0.5, min: 0, max: 1, step: 0.001, help: "How much high-frequency energy survives — it sets both the excitation filter's cutoff and how fast each successive mode's Q falls off. SQUARED before the modal bank sees it and not for the strings, which is the source's own asymmetry (`part.cc:319`)." },
    { key: "damping", label: "Damping", default: 0.5, min: 0, max: 0.9995, step: 0.0001, help: "Decay time, over FOUR DECADES of Q. The top 5 % is not merely a long tail: above 0.95 the string models crossfade to INFINITE decay, moving four coefficients together to get there, so it freezes rather than fading. The 0.9995 ceiling is the source's clamp." },
    { key: "position", label: "Position", default: 0.5, min: 0, max: 0.9995, step: 0.0001, help: "Where the resonator is struck and listened to, as a comb across the mode amplitudes. AT EXACTLY 0.5 THE EVEN OUTPUT IS SILENT — measured, and correct: the pickup sits at the midpoint, which is where even harmonics null. For the string models it also sets the plectrum's own comb." },
    { key: "frequencyTrim", label: "Frequency CV", ...TRIM, help: "Attenuverter on the freq CV input — the panel legend reads 'FM'. THIS ONE IS QUARTIC (`sign(x)·x⁴`) where the other four are quadratic, which is why it has such a long dead zone at the centre. Its result is ±48 semitones at full travel." },
    { key: "structureTrim", label: "Structure CV", ...TRIM, help: "Attenuverter on the struct CV input, through `sign(x)·x²` then ×3.3." },
    { key: "brightnessTrim", label: "Brightness CV", ...TRIM, help: "Attenuverter on the bright CV input, through `sign(x)·x²` then ×3.3." },
    { key: "dampingTrim", label: "Damping CV", ...TRIM, help: "Attenuverter on the damp CV input, through `sign(x)·x²` then ×3.3." },
    { key: "positionTrim", label: "Position CV", ...TRIM, help: "Attenuverter on the posn CV input, through `sign(x)·x²` then ×3.3." },
    {
      key: "model", label: "Resonator", default: "modal", discrete: true,
      options: ["modal", "sympathetic", "string"],
      help: "`modal` is the band-pass bank — bells, bars, bowls. `string` is one Karplus-Strong string with dispersion, a curved-bridge buzz and a noise wobble on the delay length. `sympathetic` is a struck string plus up to seven more tuned to a chord Structure selects, ringing by resonance rather than being struck. THESE ARE ALL THREE THE RACK MODULE HAS: its button cycles modulo 3, so no patch can store any of the firmware's other three, and none is offered here.",
    },
    {
      key: "polyphony", label: "Polyphony", default: "1", discrete: true, options: ["1", "2", "4"],
      help: "Voices, sharing the mode budget: the modal bank gets `64/voices − 4` modes each, so one voice is 60 modes and four are 12. IT ALSO CHANGES WHAT THE OUTPUTS MEAN — at 1 they are two pickups on one resonator, above 1 they are alternating voices carrying `odd − even`. Rack's button gives `1 << mode` for mode 0…2, which is why 3 is not an option.",
    },
    {
      key: "exciter", label: "Exciter", default: "internal", discrete: true, options: ["internal", "external"],
      help: "STANDS IN FOR CABLE PRESENCE, which an AudioParam cannot see. `internal` substitutes a pulse (modal) or a comb-filtered noise burst (strings) on every strum, and switches the excitation filter to track the note with a higher Q; `external` filters whatever is on `in` with a fixed cutoff instead. This is MORE expressive than the hardware, which picks by whether a cable is plugged in — here you can run both.",
    },
    {
      key: "strumSource", label: "Strum source", default: "external", discrete: true, options: ["internal", "external"],
      help: "`external` takes strums from the `strum` port. `internal` derives them from a change in the pitch wire (the note-change branch of the hardware's strummer), with a 10 ms inhibit window so one edge cannot fire twice. THE HARDWARE'S OTHER INTERNAL PATH IS NOT PORTED: it also strums on an audio transient via an onset detector, and that is missing (kernels' deviation R2).",
    },
    {
      key: "noteSource", label: "Note source", default: "external", discrete: true, options: ["internal", "external"],
      help: "`external` means the pitch wire is in use, which QUANTISES the Frequency knob to whole semitones so the resonator tracks in tune. `internal` leaves it continuous so it can be swept. It also selects which internal strum rule applies.",
    },
    { ...SEED },
  ],
};

// ── BRANCHES ────────────────────────────────────────────────────────────────

export const VCV_BRANCHES_SPEC = {
  type: "audio_vcv_branches", module: "vcvBranches", title: "VCV Branches", family: "modulation",
  icon: "mdi:call-split", readout: "p1",
  help: "A dual Bernoulli gate: every incoming trigger is routed to A or B by a coin toss whose bias you set. This is how a generative patch branches without a sequencer. IT HAS NO FIRMWARE TO PORT — well, it has one, and the Rack module CONTRADICTS it: the firmware's knob is the probability of A and Rack's is the probability of B. Rack wins, because Rack is what every patch in this set was made with.",
  inputs: [
    { key: "in1", type: "trigger", label: "in 1" },
    { key: "p1", type: "number", label: "p 1" },
    { key: "in2", type: "trigger", label: "in 2" },
    { key: "p2", type: "number", label: "p 2" },
  ],
  outputs: [
    { key: "out1a", type: "trigger", label: "1a" },
    { key: "out1b", type: "trigger", label: "1b" },
    { key: "out2a", type: "trigger", label: "2a" },
    { key: "out2b", type: "trigger", label: "2b" },
  ],
  knobs: [
    { key: "p1", label: "Channel 1 probability", default: 0.5, min: 0, max: 1, step: 0.001, help: "The probability that a trigger goes to B. Knob and CV sum on one param, which is why both carry the port's name. NOT CLAMPED, deliberately and per the source's own comment: the generator's range is [0,1), so at or above 1 every toss goes to B and at or below 0 none does — the comparison needs no clamp to behave." },
    { key: "p2", label: "Channel 2 probability", default: 0.5, min: 0, max: 1, step: 0.001, help: "As channel 1. The two channels are independent: Rack draws a fresh number for each, unlike the firmware, which took both from one 32-bit word and correlated them." },
    { key: "mode1", label: "Channel 1 mode", default: 0, min: 0, max: 1, step: 1, help: "0 is LATCH: the selected output follows the input gate's shape. 1 is TOGGLE: the selected output is held continuously HIGH and a successful toss FLIPS which one — a flip-flop, not a gate repeater. Exactly one of A/B is high in toggle mode, always (measured over 5000 samples). THE FIRMWARE HAS FOUR MODES AND RACK HAS TWO; the other two are unreachable in Rack and are not offered." },
    { key: "mode2", label: "Channel 2 mode", default: 0, min: 0, max: 1, step: 1, help: "As channel 1: 0 is LATCH (the selected output follows the gate) and 1 is TOGGLE (the selected output is held high and a successful toss flips which one). The two channels' modes are independent, and so are their coin tosses." },
    { ...SEED, help: `${SEED.help} A Bernoulli gate's audible property is its DISTRIBUTION rather than its stream, and measurement bears that out: B fires 0.2515 / 0.5030 / 0.7575 of 4000 triggers at probability 0.25 / 0.5 / 0.75.` },
  ],
};

// ── BLINDS ──────────────────────────────────────────────────────────────────

const BLINDS_CHANNELS = [1, 2, 3, 4];

export const VCV_BLINDS_SPEC = {
  type: "audio_vcv_blinds", module: "vcvBlinds", title: "VCV Blinds", family: "modulation",
  icon: "mdi:blinds-horizontal", readout: "gain1", w: 175,
  help: "A quad FOUR-QUADRANT VCA — which is to say a quad ring modulator. Each channel is one multiply, `gain · input`, and because the gain is bipolar and goes through zero under CV, patching audio into a CV input gives you a true ring mod. NO SATURATION AND NO OVERSAMPLING, so ring-modulating two audio-rate signals ALIASES; that is Rack's behaviour and it is reproduced rather than improved, because it is what a patch made with it sounds like. Blinds is purely analog on the hardware, so the Rack module is the only implementation there is.",
  inputs: BLINDS_CHANNELS.flatMap((n) => [
    { key: `in${n}`, type: "audio", label: `in ${n}` },
    { key: `cv${n}`, type: "audio", label: `cv ${n}` },
  ]),
  outputs: [
    ...BLINDS_CHANNELS.map((n) => ({ key: `out${n}`, type: "audio", label: `${n}` })),
    { key: "mix", type: "audio", label: "mix" },
  ],
  knobs: [
    ...BLINDS_CHANNELS.flatMap((n) => [
      { key: `gain${n}`, label: `Channel ${n} gain`, default: 0, min: -1, max: 1, step: 0.001, help: `Bipolar gain for channel ${n}. THE DEFAULT IS ZERO, so a fresh Blinds is silent — Rack's is too. The summed gain (knob plus attenuverted CV) is clamped to ±2, i.e. 6 dB of boost is reachable; the clamp is on the GAIN and not on the audio, so a full-scale input at gain 2 leaves at twice full scale, unclipped, exactly as in Rack.` },
      { key: `mod${n}`, label: `Channel ${n} CV amount`, default: 0, min: -1, max: 1, step: 0.001, help: `Attenuverter on channel ${n}'s CV input. LINEAR here, not quadratic — Blinds' trim is a plain multiply where Rings' are curved.` },
      { key: `offset${n}`, label: `Channel ${n} offset`, default: 1, min: 0, max: 1, step: 0.001, help: `Added to channel ${n}'s input before the gain. THIS IS WHY IT DEFAULTS TO 1: an unpatched Blinds input reads a constant +5 V on the hardware, which is what makes the module a bank of DC offset generators, and one wire unit IS 5 V. Set it to 0 for a pure VCA. A strict generalisation of a behaviour a kernel could not otherwise reach, since it cannot see whether a cable is plugged in.` },
    ]),
  ],
};

// ── SHADES ──────────────────────────────────────────────────────────────────

const SHADES_CHANNELS = [1, 2, 3];

export const VCV_SHADES_SPEC = {
  type: "audio_vcv_shades", module: "vcvShades", title: "VCV Shades", family: "modulation",
  icon: "mdi:tune-vertical", readout: "gain1",
  help: "A triple attenuverter and offset generator — the utility that makes every other module's CV the right size. Each channel scales its input by ±1 (attenuverter) or 0…1 (attenuator); with nothing patched it emits a DC offset instead, which is the module's other half. THE RACK MODULE HAS TWO SWITCH POSITIONS, NOT THREE: the hardware's third (a gain range) is simply absent from this build, so no patch can store it and none is offered here.",
  inputs: SHADES_CHANNELS.map((n) => ({ key: `in${n}`, type: "audio", label: `in ${n}` })),
  outputs: [
    ...SHADES_CHANNELS.map((n) => ({ key: `out${n}`, type: "audio", label: `${n}` })),
    { key: "mix", type: "audio", label: "mix" },
  ],
  knobs: [
    ...SHADES_CHANNELS.flatMap((n) => [
      { key: `gain${n}`, label: `Channel ${n} gain`, default: 0.5, min: 0, max: 1, step: 0.001, help: `Channel ${n}'s amount. IN ATTENUVERTER MODE THE DEFAULT OF 0.5 IS A GAIN OF ZERO — `+ "`k = 2·knob − 1`" + ` — so a fresh Shades is silent, and Rack's is too. In attenuator mode the same knob is `+ "`k = knob`" + `, a plain 0…1.` },
      { key: `mode${n}`, label: `Channel ${n} mode`, default: 1, min: 0, max: 1, step: 1, help: `0 is Attenuator (0…1), 1 is Attenuverter (±1). The default is 1, which is Rack's. There is no third position in this build.` },
      { key: `offset${n}`, label: `Channel ${n} offset`, default: 1, min: 0, max: 1, step: 0.001, help: `Added to channel ${n}'s input before the gain, defaulting to 1 because one wire unit is the +5 V an unpatched Shades input reads on the hardware. THIS IS THE OFFSET GENERATOR: with nothing patched, the channel emits `+ "`k`" + ` — ±1 in attenuverter mode, 0…1 in attenuator mode. Set it to 0 for a pure attenuator.` },
    ]),
  ],
};

// ── MARBLES ─────────────────────────────────────────────────────────────────

export const VCV_MARBLES_SPEC = {
  type: "audio_vcv_marbles", module: "vcvMarbles", title: "VCV Marbles", family: "modulation",
  icon: "mdi:dice-multiple-outline", readout: "tMode", w: PATCH_COLUMN_W,
  help: "Mutable Instruments' random source, and the reason a generative deck plays itself forever without repeating. TWO coupled generators sharing one register: **t** makes clocks (a master ramp, two slave ramps whose division one of seven models picks, and Beta-distributed jitter) and **X** makes voltages (three channels drawing from a Beta whose shape Spread and Bias set, quantised to a scale or slewed). DEJA VU IS THE WHOLE POINT: at 0.5 the loop plays back verbatim forever, at 0 it never repeats, and at 1 the loop's contents are frozen while its ORDER is shuffled — measured, with a repeat period of exactly the loop length at 0.5. ONE HONEST GAP: an EXTERNALLY clocked Marbles is approximate here, because Mutable's thirteen-predictor clock follower is not ported.",
  inputs: [
    { key: "t_clock", type: "trigger", label: "t clk" },
    { key: "x_clock", type: "trigger", label: "x clk" },
    cv("t_rate", "t rate"),
    cv("t_bias", "t bias"),
    cv("t_jitter", "t jit"),
    cv("deja_vu", "deja vu"),
    cv("x_spread", "x sprd"),
    cv("x_bias", "x bias"),
    cv("x_steps", "x step"),
  ],
  outputs: [
    { key: "t1", type: "trigger", label: "t1" },
    { key: "t2", type: "trigger", label: "t2" },
    { key: "t3", type: "trigger", label: "t3" },
    { key: "y_out", type: "audio", label: "y" },
    { key: "x1", type: "audio", label: "x1" },
    { key: "x2", type: "audio", label: "x2" },
    { key: "x3", type: "audio", label: "x3" },
  ],
  knobs: [
    { key: "dejaVu", label: "Deja vu", default: 0.5, min: 0, max: 1, step: 0.001, help: "A V-SHAPE, `p = (2x − 1)²`, symmetric in probability but ASYMMETRIC in effect. 0 writes a new random value every tick — unrepeating noise. 0.5 replays the register verbatim, FOREVER: the locked loop, and the setting the whole module exists for. 1 freezes the register's contents and randomises the ORDER it is read in. So the left half changes WHAT is in the loop and the right half changes the order; both ends are maximally random by different routes." },
    { key: "dejaVuLength", label: "Loop length", default: 0, min: 0, max: 1, step: 0.001, help: "The loop's length in steps, through a 36-entry ladder that reaches 1, 2, 3, 4, 5, 6, 7, 8, 10, 12, 14 and 16. NOTHING IS EVER ERASED BY SHORTENING IT: the register is 16 deep and the length only narrows the WINDOW onto its newest entries, so turning this up again reveals material you have already heard rather than fresh noise. The FIRMWARE uses a 73-entry ladder with a different curve; this is Rack's, which is what a stored knob value means." },
    { key: "tRate", label: "Clock rate", default: 0, min: -1, max: 1, step: 0.001, help: "The internal clock, ±60 semitones from the range's own base — so the 1× range spans about 0.06 Hz to 64 Hz. CLAMPED to ±120 semitones after CV, which the hardware does and Rack does not: unclamped, a large CV overflows the phase accumulator and every voltage output becomes NaN permanently (measured). Under an EXTERNAL clock this knob becomes a division/multiplication ratio instead, through nine steps from ÷4 to ×4." },
    { key: "tBias", label: "Gate bias", default: 0.5, min: 0, max: 1, step: 0.001, help: "What the t model does with its coin, and it means something different in each: for the Bernoulli models it is which output is favoured; for CLUSTERS its DISTANCE from centre is the pattern's strength (at exactly centre every pattern is unison); for DIVIDER it indexes the ratio pool directly, with unison at centre; for DRUMS below centre only the EVEN patterns are reachable, which is what makes the low half sparse." },
    { key: "tJitter", label: "Randomness", default: 0, min: 0, max: 1, step: 0.001, help: "Clock jitter, `x⁴ · 36` semitones of it, drawn from a Beta(2.83, 2.83) so small deviations are far likelier than large ones. IT DOES NOT DRIFT: the generator accumulates how far the jittered clock has wandered from the straight one and pulls it back, so jitter is a feel rather than a tempo change." },
    { key: "xSpread", label: "Probability distribution", default: 0.5, min: 0, max: 1, step: 0.001, help: "How PEAKED the voltage distribution is. At 0 it collapses to a constant at Bias; at 1 it becomes a coin flip landing on one end or the other with P(high) = Bias; in between it is a Beta whose shape this and Bias set together. Both extremes are crossfaded in rather than switched, which is why the ends are usable. In register mode this knob doubles as the shift register's CV input — that reuse is the Rack wrapper's, complete with its own `TODO Fix the scaling`." },
    { key: "xBias", label: "Distribution bias", default: 0.5, min: 0, max: 1, step: 0.001, help: "Where the voltage distribution's mass sits. It is WARPED before use, by an amount that depends on how peaked Spread already is — without that warp a bias near either end would collapse the distribution to a spike, and with it the knob stays musical across its whole travel." },
    { key: "xSteps", label: "Smoothness", default: 0.5, min: 0, max: 1, step: 0.001, help: "TWO CONTROLS ABOUT ITS CENTRE, and at exactly centre NEITHER. Below 0.5 it is a GLIDE: a one-pole crossfaded against a raised-cosine-warped ramp, so a long slew eases in and out like a hand on a knob. Above 0.5 it is the QUANTISER's selectivity, dropping the scale's lightly-weighted degrees first and ending on the root alone. At 0.5 the value is neither slewed nor quantised." },
    { key: "tDejaVu", label: "t deja vu", default: 0, min: 0, max: 1, step: 1, help: "Whether the t side's clock pattern follows the deja-vu register. Off passes zero, which is the register's 'never repeat' end rather than a bypass — so turning it off is the same as turning Deja vu to 0 for this side only." },
    { key: "xDejaVu", label: "X deja vu", default: 0, min: 0, max: 1, step: 1, help: "Whether the X side's voltages follow the deja-vu register. Same law as the t side's: off is 'never repeat', not 'disabled'." },
    { key: "tMode", label: "t model", default: "complementaryBernoulli", discrete: true, options: ["complementaryBernoulli", "clusters", "drums", "independentBernoulli", "divider", "threeStates", "markov"], help: "`complementaryBernoulli` fires exactly one of t1/t3 every tick. `clusters` draws a division pattern from a weighted pool. `drums` walks one of eighteen eight-step patterns. `independentBernoulli` tosses a separate coin per output, so both or neither may fire. `divider` is a straight ratio control off Gate bias. `threeStates` adds silence as a third outcome. `markov` weighs four rules over a sixteen-tick history — favour what played eight ticks ago, avoid simultaneous hits, favour sparseness, favour one channel echoing the other — and is the one model that learns its own groove. ALL SEVEN ARE HERE; the Rack front-panel button only cycles the first three, but its menu reaches them all and a patch can store any." },
    { key: "tRange", label: "Clock range", default: "1x", discrete: true, options: ["0.25x", "1x", "4x"], help: "The internal clock's base rate: 0.5, 2 or 8 Hz at rate 0. Under an external clock it instead multiplies the division ratio's numerator or denominator by four, which is how the same knob reaches ÷16 and ×16." },
    { key: "xMode", label: "X mode", default: "identical", discrete: true, options: ["identical", "bump", "tilt"], help: "How Spread, Bias and Steps are distributed across the three X channels. `identical` gives all three the same. `bump` inverts channels 1 and 3 around channel 2. `tilt` ramps from fully inverted on channel 1, through NEUTRAL on channel 2 (its spread, bias and steps pinned to centre), to fully positive on channel 3." },
    { key: "xRange", label: "Voltage range", default: "positive", discrete: true, options: ["narrow", "positive", "full"], help: "0…2 V, 0…5 V, or ±5 V — 0…0.4, 0…1 and ±1 on our wires. IT ALSO SETS Y's RANGE, because the Rack wrapper shares them (its own `TODO`); reproduced rather than split, since a patch was made against the shared behaviour. Register mode ignores this entirely and always spans ±5 V." },
    { key: "xScale", label: "Scale", default: "major", discrete: true, options: ["major", "minor", "pentatonic", "pelog", "bhairav", "shri"], help: "The quantiser's scale, as WEIGHTED degrees rather than a plain note set — which is what lets Smoothness drop the least important notes first. C minor's G♯ and A carry Rack's weights (16 and 96), not the firmware's (96 and 16); Rack's is what the patches were made against and the divergence is deliberate." },
    { key: "yDivider", label: "Y divider", default: "1/4", discrete: true, options: ["1/64", "1/48", "1/32", "1/24", "1/16", "1/12", "1/8", "1/6", "1/4", "1/3", "1/2", "1"], help: "Y's clock, as a division of the X2 clock. Y always draws a FRESH random value (its own deja-vu is fixed at zero and its loop length at one), so it is the one output that never repeats — a slow, unrepeating drift under everything else." },
    { key: "xClockSource", label: "X clock", default: "t1t2t3", discrete: true, options: ["t1t2t3", "t1", "t2", "t3"], help: "Which t output clocks the X channels. `t1t2t3` gives each channel its own clock AND its own independent deja-vu register. The other three drive all of X from one clock, which is when CHANNEL LOCKING engages: channel 1 runs live and channels 2 and 3 replay its history — decorrelated through a hash, or SHIFTED by one and two steps in register mode, which makes an analog shift register." },
    { key: "clockMode", label: "t clock source", default: "internal", discrete: true, options: ["internal", "external"], help: "STANDS IN FOR CABLE PRESENCE, which an AudioParam cannot see. `external` follows the `t clk` port. **THE FOLLOWER IS APPROXIMATE** — Mutable runs thirteen concurrent period predictors so it locks to a swung or patterned clock and anticipates the next edge; ours measures the interval between rising edges. On a steady clock they agree; on a changing one ours follows a period late, and on a rhythmically patterned one it does not learn the pattern at all." },
    { key: "xClockMode", label: "X clock source", default: "internal", discrete: true, options: ["internal", "external"], help: "As the t side's, for the `x clk` port. Note the source's own quirk, reproduced: for sixteen blocks after switching to the external X clock the X outputs are MUTED — a hardware normalisation artefact Rack inherits, and eighty samples of silence is easier to explain than to debug." },
    { key: "registerMode", label: "Register mode", default: "internal", discrete: true, options: ["internal", "external"], help: "`external` turns the X side into a shift register fed from a CV instead of a random source, which is what makes Marbles a quantised sample-and-hold or an ASR. It bypasses the voltage range and always spans ±5 V, and it is the mode in which channel locking becomes a literal shift." },
    { ...SEED },
  ],
};

// ── RIPPLES ─────────────────────────────────────────────────────────────────

export const VCV_RIPPLES_SPEC = {
  type: "audio_vcv_ripples", module: "vcvRipples", title: "VCV Ripples", family: "filter",
  icon: "mdi:waves", readout: "frequency", w: 175,
  help: "Mutable Instruments' analog filter, as a CIRCUIT-LEVEL MODEL rather than a biquad — four integrator cells solved with midpoint Runge-Kutta at 3x oversampling through a twelfth-order elliptic anti-alias filter. THERE IS NO MUTABLE DSP TO PORT: the real Ripples is analog, so the Rack module is an original simulation by Tyler Coy and is the only implementation there is. Two nonlinearities give it its character: the resonance path closes through a transconductance that is in HARD SATURATION for any real signal, so resonance self-limits and self-oscillates instead of blowing up; and each cell's slew rate carries a one-percent-per-volt distortion that generates even harmonics. All three linear outputs are INVERTING and the VCA output is not.",
  inputs: [
    { key: "in", type: "audio", label: "in" },
    { key: "res", type: "number", label: "res" },
    { key: "freq", type: "number", label: "freq" },
    { key: "fm", type: "number", label: "fm" },
    { key: "gain", type: "number", label: "gain" },
  ],
  outputs: [
    { key: "bp2", type: "audio", label: "bp2" },
    { key: "lp2", type: "audio", label: "lp2" },
    { key: "lp4", type: "audio", label: "lp4" },
    { key: "lp4vca", type: "audio", label: "vca" },
  ],
  knobs: [
    { key: "frequency", label: "Frequency", default: RIPPLES_FREQ_KNOB_MAX, min: RIPPLES_FREQ_KNOB_MIN, max: RIPPLES_FREQ_KNOB_MAX, step: 0.001, unit: " log2Hz", hz: ripplesKnobToHz, help: "Cutoff, STORED AS log2 OF HERTZ exactly as Rack stores it — 4.321928 is 20 Hz and 14.287712 is 20 kHz — so a harvested patch's value lands unchanged. The DEFAULT IS THE MAXIMUM, i.e. wide open, which is Rack's. The cutoff has a HARD CEILING at 20 kHz and no floor at all: that asymmetry is the model's." },
    { key: "resonance", label: "Resonance", default: 0, min: 0, max: 1, step: 0.001, help: "Feedback around the four-cell ladder, tapping the FOURTH cell through the transconductance. It self-oscillates near the top rather than clipping, because the tanh approximant saturates at about 0.19 V of differential input — which is to say almost immediately. IT CANNOT BE DRIVEN NEGATIVE: the CV converter's output current is floored at zero, so a negative resonance CV shuts resonance off rather than inverting it." },
    { key: "fmTrim", label: "FM amount", default: 0, min: -1, max: 1, step: 0.001, help: "Attenuverter on the fm input, LINEAR here rather than curved. The fm and freq inputs are separate on purpose: freq is a straight 1 V/oct and this one is the attenuated modulation path." },
    { key: "gainPatched", label: "VCA source", default: 0, min: 0, max: 1, step: 1, help: "STANDS IN FOR CABLE PRESENCE on the gain input, which an AudioParam cannot see. At 0 the VCA sees a fixed 12 V through a larger resistor — the source's normalling, and what makes the vca output usable with nothing patched, at about 4.5x the lp4 output saturating near 25 V. At 1 the gain input drives it instead." },
    { ...SEED, help: "CONSTRUCT-TIME. Ripples adds half a microvolt of dither to its input, and that is REQUIRED rather than decorative: without it a fully-resonant filter never starts oscillating from silence, because zero is the ladder's only equilibrium. Rack's dither comes from a global generator seeded at load; this one is seeded here, so a document renders identically twice." },
  ],
};

/**
 * EVERY VC-1 SPEC — the two granular processors, then the resonator, then the three
 * utilities, which is core/audio_specs.AUDIO_SPECS' own ordering rule (sources and
 * processors before modulation) so the palette reads as one library.
 *
 * THE BARREL LINES THIS NEEDS (report to the lead; this file may not apply them):
 *   `core/audio_blocks.js`   must spread this array into `PORT_BLOCK_SPECS`
 *   `plugins/audio_index.js` must spread `BLOCK_PLUGINS` from `audio_index_vc1.js`
 * Without both, these modules exist in the engine and nowhere an author can reach them —
 * the half-registered failure `plugins/audio_index.js`'s docblock calls out.
 * `tests/port_vc1_test.js` sweeps this array either way.
 */
export const BLOCK_SPECS = [
  VCV_CLOUDS_SPEC, VCV_SUPERCELL_SPEC, VCV_RINGS_SPEC,
  VCV_MARBLES_SPEC, VCV_RIPPLES_SPEC, VCV_BRANCHES_SPEC, VCV_BLINDS_SPEC, VCV_SHADES_SPEC,
];
