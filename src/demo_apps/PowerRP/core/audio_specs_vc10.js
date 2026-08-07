/**
 * THE VC-10 MODULE SPECS — the fifteen ported squinkylabs / Vult / Instruō nodes.
 *
 * ── WHAT THIS FILE IS ───────────────────────────────────────────────────────
 * core/audio_specs.js's vocabulary applied to another module set. Same record
 * shape, same rules, same reader (`core/audio_nodes.audioNodePlugin`): a spec is
 * the values that make one module differ from its neighbours, and NOTHING about
 * how it sounds. The DSP is `synth/vc10_kernels.js`, and THE DERIVATION RECORD —
 * which source, which function, which commit, the recurrence in float, every
 * named deviation — is that file's docblocks. Each `help` below points at it
 * rather than repeating it.
 *
 * ── THREE FIDELITY TIERS, AND EVERY NODE SAYS WHICH IT IS ───────────────────
 * This block is unusual: only a third of it is ported from published code.
 *   SOURCE                Super, F2, Filt, Frequency Shifter, WVCO — squinkylabs
 *                         is open C++ and these are line-by-line ports.
 *   DSP-SOURCE + MODEL    Tangents, Unstabile, Lateralus, Bleak, Basal, Vessek,
 *                         Caudal — the Vult Rack modules are CLOSED, but their
 *                         author publishes the DSP primitives in the Vult
 *                         language and each module's manual names its topology.
 *                         The cores are real; the assembly is a model.
 *   BEHAVIOUR ONLY        øchd, athrú, saïch — Instruō is closed with no
 *                         published DSP at all. Derived from the vendor manuals.
 * A node's tier is in its `help`'s FIRST sentences, not buried, because an
 * author choosing between two filters deserves to know which one is a
 * transcription. `tests/port_vc10_test.js` asserts every spec declares one.
 *
 * ── WHY A SEPARATE FILE ─────────────────────────────────────────────────────
 * Several agents write ported module sets CONCURRENTLY (R7 Wave 3 Phase 3), one
 * block each. One shared file is one merge conflict per agent per save. The
 * barrel — `PORT_BLOCK_SPECS` in core/audio_blocks.js — stays the single roster;
 * this array is spread into it.
 *
 * ── THIS FILE MAY NOT IMPORT synth/** ───────────────────────────────────────
 * core/ must run in bare node, so every option list below is RESTATED from the
 * kernels' own setters and every range from the roster's own AudioParam bounds.
 * `tests/port_vc10_test.js` pins both against `synth/worklets/processors_vc10.js`
 * and `synth/vc10_kernels.js`, which is where a dependency on the engine belongs.
 *
 * ── UNITS ON A WIRE: R7-UNITS, ALL FOUR CLAUSES, AS THEY LAND HERE ──────────
 *   LEVEL ports  ±1 IS ±5 V. Every audio inlet and every bipolar CV.
 *   PITCH ports  carry SEMITONES (`12 × volts`), and THIS BLOCK HAS THREE
 *                ORIGINS. squinkylabs is C4 = 261.626 Hz (both Super and WVCO
 *                write `log2(261.626)` themselves). Vult is C1 = 32.703 Hz —
 *                measured from `Util.cvToPitch` and confirmed by Vessek's own
 *                manual. Basal and Bleak are the SAME Vult DSP with a documented
 *                two-octave panel offset, so their 0 is C3. Instruō publishes no
 *                origin and saïch assumes C4, which its `help` says.
 *   GATE ports   carry 0…1 LOGIC, mapped to Rack's 10 V gate.
 *
 * ── UNITS ON A KNOB: REAL ONES, NOT RACK KNOB POSITIONS ─────────────────────
 * A Rack knob is often 0…1 with a display formula behind it. Here a knob carries
 * the unit its READOUT would have shown — hertz for a cutoff, semitones for a
 * pitch — and each kernel inverts the mapping at its own boundary so the
 * arithmetic downstream is byte-identical to the original. A 0…1 knob survives
 * only where the original's own display is also a bare percentage.
 *
 * TWO FAMILIES KEEP THEIR OWN DOMAIN AND SAY WHY. F2's Q and R are 0…10 because
 * the Q a given position produces DEPENDS ON THE TOPOLOGY (`2^(q/1.5)` with one
 * stage, `2^(q/2.5)` with two) — a knob labelled in Q would silently mean two
 * different things. Filt's six ±5 controls are the same case: every one of them
 * is scaled against the others through `makeScalerWithBipolarAudioTrim`, and
 * relabelling one in isolation would break the relationship the panel encodes.
 *
 * ── EVERY ATTENUVERTER DEFAULTS TO UNITY (kernels' D6) ──────────────────────
 * Rack's default 0. VC-3a's finding, generalised: a 0 default means a patched
 * cable does nothing, and this block exists to make twenty silent demo patches
 * audible. A trim of 0 is still reachable and still means "ignore the CV". The
 * one exception is athrú's Symmetry Bias, whose centre the manual calls
 * "calibrated to 0 V" — there zero IS the documented neutral.
 */

/** The three sources this block was read at, pinned to a commit apiece. */
export const SQUINKY_SOURCE = "github.com/squinkylabs/SquinkyVCV-main @ 8b0411e2d1b5a11ffa11280cca00253813212dc7";
export const VULT_SOURCE = "github.com/vult-dsp/vult @ cc56038e06ae4745b17bcd7e611e7b21d87ea51c";
export const VULT_MANUAL_SOURCE = "github.com/modlfo/VultModules @ 99629d35103eaba67acf35f1b906c4b5bcfb22ff";
export const INSTRUO_SOURCE = "instruomodular.com manuals, read 2026-08-06";

/** The three fidelity tiers, as machine-checkable values. */
export const VC10_TIERS = Object.freeze(["source", "dspSourcePlusModel", "behaviourOnly"]);

/**
 * Pure function. One node's derivation INDEX — deliberately an index and NOT a
 * copy of the record, for the reason VC-3b's `derivedFrom` gives: the RECURRENCE
 * belongs beside the arithmetic it describes, and the SOURCE, the TIER and the
 * DEVIATION LIST need to be machine-checkable so a block cannot ship without one.
 *
 * `tests/port_vc10_test.js` asserts every `kernel` names a real exported class,
 * every `tier` is one of the three, and every deviation id really appears in
 * synth/vc10_kernels.js — so the index and the record cannot drift apart.
 *
 * @param {string} source - one of the four SOURCE constants above
 * @param {string[]} files - the files the port was read from
 * @param {string} kernel - the exported kernel class holding the full record
 * @param {string} tier - one of VC10_TIERS
 * @param {string[]} deviations - the deviation ids that record must name
 * @returns {{source: string, files: string[], kernel: string, tier: string, deviations: string[]}}
 *
 * @example derivedFrom(SQUINKY_SOURCE, ["composites/F2_Poly.h"], "F2Kernel", "source", ["D0"]).tier // "source"
 * @example derivedFrom(SQUINKY_SOURCE, ["composites/F2_Poly.h"], "F2Kernel", "source", ["D0"]).source.includes("8b0411e") // true
 */
export function derivedFrom(source, files, kernel, tier, deviations) {
  return { source, files, kernel, tier, deviations };
}

/** The deviations that bind EVERY node in this block — the voltage law, the
 *  semitone pitch law, the audio-typed CV inlets and the mono wire. Named once
 *  so fifteen rows cannot list three of the four. */
const BLOCK_WIDE_DEVIATIONS = ["D0", "D1", "D3", "D8"];

const SEMITONES_PER_OCTAVE = 12;

/** `rack::dsp::FREQ_C4`, which F2 uses where Super and WVCO use their own
 *  261.626 — see the kernels' D1 on why both numbers live in one block. */
const RACK_FREQ_C4_HZ = 261.6256;

/** squinkylabs' own C4, to the six digits both Super and WVCO spell as
 *  `log2(261.626)`. NOT Rack's `dsp::FREQ_C4` (261.6256) — porting means porting
 *  their number, and F2, which DOES use Rack's, gets Rack's. */
const SQUINKY_C4_HZ = 261.626;

/** Vult's own zero: `Util.cvToPitch(0)` is MIDI 24, which is C1. */
const VULT_MIDI_ROOT_HZ = 8.175798915643707;
const VULT_ZERO_VOLT_MIDI = 24;

/** Basal's and Bleak's manuals put 0 V at C3 for the same DSP. */
const VULT_C3_PANEL_OFFSET_SEMITONES = 24;

/**
 * Pure function. Semitones from C4 to hertz — the `hz` display field for the
 * squinkylabs pitch knobs, and the reason it is written here rather than
 * imported: core/ may not import synth/, and the E4-origin `semitonesToHz` in
 * core/audio_nodes.js would be four semitones wrong for a VCV module.
 *
 * @param {number} semitones - semitones from C4, which is 0
 * @returns {number} hertz
 *
 * @example squinkySemitonesToHz(0) // 261.626
 * @example squinkySemitonesToHz(12) // 523.252
 */
export function squinkySemitonesToHz(semitones) {
  return SQUINKY_C4_HZ * Math.pow(2, semitones / SEMITONES_PER_OCTAVE);
}

/**
 * Pure function. Semitones from Vult's own C1 to hertz.
 *
 * @param {number} semitones - semitones above C1, which is 0
 * @returns {number} hertz
 *
 * @example Math.abs(vultSemitonesToHz(0) - 32.7031956) < 1e-6 // true
 * @example Math.abs(vultSemitonesToHz(36) - 261.6255653) < 1e-6 // true
 */
export function vultSemitonesToHz(semitones) {
  return VULT_MIDI_ROOT_HZ * Math.pow(2, (VULT_ZERO_VOLT_MIDI + semitones) / SEMITONES_PER_OCTAVE);
}

/**
 * Pure function. The same, for Basal and Bleak, whose panels sit two octaves up.
 *
 * @param {number} semitones - semitones above C3, which is 0
 * @returns {number} hertz
 *
 * @example Math.abs(vultC3SemitonesToHz(0) - 130.8127826) < 1e-6 // true
 */
export function vultC3SemitonesToHz(semitones) {
  return vultSemitonesToHz(semitones + VULT_C3_PANEL_OFFSET_SEMITONES);
}

/** F2's cutoff knob is in HERTZ and its span is exactly what their 0…10 V
 *  control reaches, `FREQ_C4 · 2^(v − 4)`. Written as the same arithmetic the
 *  roster writes, so the two cannot round apart. */
const F2_FC_MIN_HZ = RACK_FREQ_C4_HZ / 16;
const F2_FC_MAX_HZ = RACK_FREQ_C4_HZ * 64;
const F2_FC_DEFAULT_HZ = RACK_FREQ_C4_HZ * 2;

/** Every Vult filter's cutoff span: the bottom is their own 0 CV (C1) and the
 *  top is `ladder.vult`'s own 20 kHz clip. Same reason for the shared spelling. */
const VULT_FC_MIN_HZ = vultSemitonesToHz(0);
const VULT_FC_MAX_HZ = 20000;
const VULT_FC_DEFAULT_HZ = 1000;

// ── SHARED FRAGMENTS ────────────────────────────────────────────────────────

/** The two-value on/off option every boolean switch in this block uses. */
const ON_OFF = ["off", "on"];

/** An attenuverter row. D6: unity by default. */
const trimKnob = (key, label, subject, defaultValue = 1) => ({
  key, label, default: defaultValue, min: -1, max: 1, step: 0.01,
  help: `How much the ${subject} inlet moves ${subject}, and in which direction — negative inverts. RACK DEFAULTS THIS TO ZERO AND THIS DEFAULTS IT TO ${defaultValue === 0 ? "ZERO TOO" : "ONE"}: ${defaultValue === 0 ? "the module's own manual calls the centre position calibrated to 0 V, so zero is the documented neutral here rather than a dead cable." : "a zero default makes a patched cable do nothing, which is how a ported patch ends up looking wired and sounding static. Turn it to 0 to ignore the CV."}`,
});

/** The SEED knob Super and Caudal share. Their randomness is already seeded —
 *  squinkylabs writes `std::default_random_engine generator{57}` — so this is
 *  not repairing nondeterminism so much as EXPOSING the constant. */
const seedKnob = (defaultValue, what) => ({
  key: "seed", label: "Seed", default: defaultValue, min: 0, max: 65535, step: 1, construct: true,
  help: `CONSTRUCT-TIME: the generator's state is initialised once, so changing this rebuilds the module. ${what} The default is the source's own constant, so seed ${defaultValue} reproduces the original exactly. A Lehmer generator's 0 is a fixed point, so 0 is mapped to the default rather than producing all zeros.`,
});

// ═══════════════════════════════════════════════════════════════════════════
// SOURCES
// ═══════════════════════════════════════════════════════════════════════════

export const VCV_SUPER_SPEC = {
  derivation: derivedFrom(SQUINKY_SOURCE, ["composites/Super.h", "composites/SuperDsp.h", "dsp/filters/StateVariable4PHP.h", "dsp/utils/IIRDecimator.h"], "SuperKernel", "source", [...BLOCK_WIDE_DEVIATIONS, "D2", "D4", "D5", "D6", "D9", "D-WRAP", "D-DECIM"]),
  type: "audio_vcv_super", module: "vcvSuper", title: "VCV Super", family: "source",
  icon: "mdi:waveform", readout: "detune", w: 185,
  help: "PORTED FROM SOURCE (squinkylabs' open C++, line by line). Seven sawtooths, six detuned around the seventh — the classic supersaw, with the two things that make theirs sound like a JP-8000 rather than like seven detuned saws. FIRST: the detune curve is a measured sixteen-point table, not a straight line, so the bottom half of the knob barely moves and the top opens right up. SECOND: the seven levels move TOGETHER on one Mix knob along a fitted quadratic, so the centre saw fades as the sides come up and the sound thickens instead of just getting louder.",
  inputs: [
    { key: "pitch", type: "audio", label: "pitch" },
    { key: "trigger", type: "audio", label: "trig" },
    { key: "detune_cv", type: "audio", label: "det cv" },
    { key: "mix_cv", type: "audio", label: "mix cv" },
    { key: "fm", type: "audio", label: "fm" },
  ],
  outputs: [
    { key: "left", type: "audio", label: "L" },
    { key: "right", type: "audio", label: "R" },
  ],
  knobs: [
    { key: "octave", label: "Octave", default: 0, min: -5, max: 4, step: 1, help: "Transposition in octaves, ROUNDED before use (`roundf(octaveParam)`), so a fractional value from an equation snaps rather than detuning. A TRANSPOSITION, so it carries no frequency readout — there is no absolute pitch to show." },
    { key: "semi", label: "Semitone", default: 0, min: -11, max: 11, step: 1, unit: " st", help: "Transposition in semitones, added as `semi/12` volts. Eleven either way, because twelve is the Octave knob's job." },
    { key: "fine", label: "Fine", default: 0, min: -1, max: 1, step: 0.01, unit: " st", help: "Fine tune, ±1 semitone. Fractional values are the point: two Supers a few hundredths apart beat at a rate you can hear." },
    { key: "detune", label: "Detune", default: 0, min: -5, max: 5, step: 0.01, help: "How far the six outer saws spread, through their sixteen-point measured curve (`SawtoothDetuneCurve`). The curve is why this knob feels the way it does: nearly flat until three quarters up, then a jump to 1.0 at the very top where all six fly apart. Their own domain, ±5, because everything on this panel is scaled against everything else." },
    { ...trimKnob("detuneTrim", "Detune CV trim", "detune") },
    { key: "mix", label: "Mix", default: 0, min: -5, max: 5, step: 0.01, help: "The balance between the centre saw and the six sides, along two polynomials fitted by their author: the centre falls linearly and the sides rise on a downward parabola. At the bottom you hear one saw; at the top the centre is nearly gone and the six sides ARE the sound." },
    { ...trimKnob("mixTrim", "Mix CV trim", "mix") },
    { key: "fm", label: "FM depth", default: 0, min: 0, max: 1, step: 0.01, help: "How much the `fm` inlet moves the pitch, SQUARED before use (`quadraticBipolar`) — so the bottom of the knob is a vibrato and the top is a scream, with very little in between. Theirs." },
    {
      // NOT `construct: true` — the worklet lists it under `options`, not `construct`
      // (`processors_vc10.js:175`: `construct: ["seed"], options: ["aliasMode", …]`), so it
      // is delivered by postMessage and really does change live. `seed` beside it IS
      // construct-time and correctly flagged. The module's own docblock claims aliasMode is
      // construct too; that sentence is stale and the code is the authority.
      key: "aliasMode", label: "Alias suppression", default: "classic", discrete: true, options: ["classic", "clean", "clean2"],
      help: "CONSTRUCT-TIME: it sizes the oversampling buffers, so changing it rebuilds the module. `classic` runs at the host rate with a four-pole high-pass on the output — the cheapest and the one the module shipped with. `clean` is 4× oversampled through a six-pole Butterworth decimator, `clean2` is 16×. Their own CPU figures are 14, 30 and 85 — the top setting is six times the cost of the bottom, for aliasing you will only hear on high notes.",
    },
    { key: "hardPan", label: "Hard pan", default: "off", discrete: true, options: ON_OFF, help: "STEREO ONLY. `off` spreads the seven saws across the field with overlapping gains, so each side hears most of them. `on` sends alternate saws hard left and hard right with only the centre saw in both — a much wider, hollower image that collapses badly to mono, which is exactly why it is a switch and not the default." },
    { key: "stereo", label: "Stereo", default: "on", discrete: true, options: ON_OFF, help: "THIS IS A KNOB BECAUSE A WORKLET CANNOT SEE AN UNCONNECTED OUTPUT (kernels' D9). The original decides between its mono and stereo paths by asking whether BOTH output jacks are patched; nothing in the AudioWorklet API can answer that, so the decision is yours. `off` is their mono path — one saw sum through one high-pass, copied to both outputs. `on` is the stereo path, where the two channels have different per-saw gains and their own filters." },
    { ...seedKnob(57, "It picks the phases every `trig` redraws.") },
  ],
};

export const VCV_WVCO_SPEC = {
  derivation: derivedFrom(SQUINKY_SOURCE, ["composites/WVCO.h", "dsp/generators/WVCODsp.h", "composites/ADSR16.h", "dsp/SimdBlocks.h"], "WvcoKernel", "source", [...BLOCK_WIDE_DEVIATIONS, "D2", "D4", "D7", "D10", "D-OFFSETLAG", "D-SNAP2", "D-PATCHVER"]),
  type: "audio_vcv_wvco", module: "vcvWvco", title: "VCV WVCO", family: "source",
  icon: "mdi:sine-wave", readout: "waveform", w: 200,
  help: "PORTED FROM SOURCE. squinkylabs' \"Kitchen Sink\": a through-zero FM operator with its OWN four-stage envelope routed to four destinations, hard sync located to sub-sample resolution, and phase feedback. One of these is a complete FM voice; two of them are a DX7 operator pair. The sine is their own quartic approximation and NOT `Math.sin` — it is about 0.1% off, and that error is a fixed harmonic colour rather than noise, so replacing it would change the instrument.",
  inputs: [
    { key: "voct", type: "audio", label: "v/oct" },
    { key: "fm", type: "audio", label: "fm" },
    { key: "linear_fm", type: "audio", label: "lin fm" },
    { key: "gate", type: "audio", label: "gate" },
    { key: "sync", type: "audio", label: "sync" },
    { key: "shape", type: "audio", label: "shape" },
    { key: "linear_fm_depth", type: "audio", label: "lfm cv" },
    { key: "feedback", type: "audio", label: "fbk cv" },
  ],
  outputs: [{ key: "main", type: "audio", label: "out" }],
  knobs: [
    { key: "octave", label: "Octave", default: 4, min: 0, max: 10, step: 1, help: "Transposition in octaves, ROUNDED, with their `−4` offset already applied — so 4 puts a 0 V `v/oct` at C4 = 261.626 Hz. A TRANSPOSITION, so no frequency readout." },
    { key: "frequencyMultiplier", label: "Ratio", default: 1, min: 1, max: 16, step: 1, help: "An INTEGER frequency ratio, rounded. This is the operator-ratio knob an FM patch lives on: set two WVCOs to 1 and 3 and the second is a perfect twelfth above, locked, forever. Non-integer ratios are what make FM inharmonic, and this knob deliberately cannot produce one." },
    { key: "fineTune", label: "Fine tune", default: 0, min: -12, max: 12, step: 0.01, unit: " st", help: "±1 octave of continuous detune, added as `fine/12` volts." },
    { key: "fmDepth", label: "FM depth", default: 0, min: 0, max: 100, step: 1, unit: " %", help: "How much the `fm` inlet moves the PITCH — exponential FM, so it detunes as depth rises. Their audio taper is on this knob, so the bottom quarter is nearly linear and the top three quarters are exponential." },
    { key: "linearFmDepth", label: "Linear FM", default: 0, min: 0, max: 100, step: 1, unit: " %", help: "How much the `lin fm` inlet offsets the PHASE — through-zero FM, so the timbre stays in tune as depth rises. THIS is the one an FM patch wants; the exponential one above is for vibrato." },
    { key: "waveshapeGain", label: "Shape", default: 0, min: 0, max: 100, step: 1, unit: " %", help: "How far the waveform is pushed from a sine, and it means something different per waveform: in `fold` it is the wavefolder's drive (audio-tapered), in `sawTri` it is the morph between a triangle and a saw (linear), and in `sine` it does nothing at all." },
    {
      key: "waveform", label: "Waveform", default: "sine", discrete: true, options: ["sine", "fold", "sawTri"],
      help: "`sine` is the pure operator. `fold` runs that sine into a triangle wavefolder — West-Coast timbre from an FM oscillator. `sawTri` is a two-segment ramp whose corner Shape moves from the middle (triangle) to either end (saw), which is a completely different, buzzier voice. Each has its own output normalisation and its own DC offset, so switching does not jump the level.",
    },
    { key: "feedback", label: "Feedback", default: 0, min: 0, max: 100, step: 1, unit: " %", help: "How much of the oscillator's own last output is fed back into its phase. This is the operator-feedback knob: at low settings it thickens a sine towards a saw, and past about half it breaks into noise — which is a documented FM sound, not a fault." },
    { key: "outputLevel", label: "Level", default: 100, min: 0, max: 100, step: 1, unit: " %", help: "Output level before the per-waveform normalisation. At 100 a sine leaves at ±5 V." },
    { key: "attack", label: "Attack", default: 50, min: 0, max: 100, step: 1, unit: " %", help: "The internal envelope's attack, exponential across 0.5 ms to 10 s. The envelope aims PAST full scale and stops when it arrives, which is what gives it a curve rather than an asymptote." },
    { key: "decay", label: "Decay", default: 50, min: 0, max: 100, step: 1, unit: " %", help: "Decay, same exponential span." },
    { key: "sustain", label: "Sustain", default: 50, min: 0, max: 100, step: 1, unit: " %", help: "Sustain level." },
    { key: "release", label: "Release", default: 50, min: 0, max: 100, step: 1, unit: " %", help: "Release, same exponential span." },
    { key: "snap", label: "Snap", default: "off", discrete: true, options: ["off", "soft", "hard"], help: "Clips the envelope at `sustain + k(1 − sustain)` and multiplies it back up. The endpoints do not move — the ATTACK does, getting steeper as k falls. `hard` is a percussive thwack from the same four knobs that make a pad." },
    { key: "adsrToShape", label: "Env → shape", default: "off", discrete: true, options: ON_OFF, help: "Routes the envelope to the Shape control, so the timbre opens with the note. On an FM operator this is the single most useful modulation there is." },
    { key: "adsrToFeedback", label: "Env → feedback", default: "off", discrete: true, options: ON_OFF, help: "Routes the envelope to Feedback — a transient that starts noisy and settles into a tone." },
    { key: "adsrToLevel", label: "Env → level", default: "off", discrete: true, options: ON_OFF, help: "Routes the envelope to the output level, which is what makes this module a whole voice rather than an oscillator." },
    { key: "adsrToFm", label: "Env → linear FM", default: "off", discrete: true, options: ON_OFF, help: "Routes the envelope to the linear FM depth — the classic FM bell, where the modulator's index decays faster than the carrier." },
  ],
};

export const VCV_BLEAK_SPEC = {
  derivation: derivedFrom(VULT_MANUAL_SOURCE, ["bleak/index.html", "examples/util/util.vult"], "BleakKernel", "dspSourcePlusModel", [...BLOCK_WIDE_DEVIATIONS, "D-BLEP", "D-VULTMOD"]),
  type: "audio_vcv_bleak", module: "vcvBleak", title: "VCV Bleak", family: "source",
  icon: "mdi:triangle-wave", readout: "wave", w: 175,
  help: "VULT DSP + BEHAVIOUR MODEL. Vult's Rack modules are closed source; their author's own DSP primitives are open and the manual names the topology, so the TUNING here is measured from his published `Util.cvToPitch` and the shapes and controls are from the manual — but the antialiaser is PolyBLEP and is not his (he uses EPTR/minBLEP), so the aliasing floor differs from the original's. One oscillator morphing continuously saw → pulse → triangle, with a pulse width that means something in all three: a double saw, a duty cycle, and an asymmetry.",
  inputs: [
    { key: "v_oct", type: "audio", label: "v/oct" },
    { key: "pw", type: "audio", label: "pw" },
    { key: "wave", type: "audio", label: "wave" },
  ],
  outputs: [{ key: "out", type: "audio", label: "out" }],
  knobs: [
    { key: "tune", label: "Tune", default: 0, min: -12, max: 12, step: 0.01, unit: " st", hz: vultC3SemitonesToHz, help: "Offsets the V/OCT input one octave up or down (the manual's own words). ZERO IS C3 = 130.813 Hz, which is Vult's C1 origin plus the two-octave panel offset Basal and Bleak's manuals both document — see the kernels' D1 for how that was measured rather than assumed." },
    { key: "oct", label: "Octave", default: 0, min: -3, max: 3, step: 1, help: "Offsets the V/OCT input three octaves up and down. A TRANSPOSITION, so no frequency readout." },
    { key: "pw", label: "Pulse width", default: 0.5, min: 0, max: 1, step: 0.01, help: "Duty cycle for the pulse. For the SAW it produces a double saw — two ramps a fraction of a cycle apart, which is one oscillator sounding like two. For the TRIANGLE it moves the peak, so the shape runs from a rising ramp through a symmetric triangle to a falling one." },
    { key: "wave", label: "Wave", default: 0.514, min: 0, max: 1, step: 0.001, help: "Morphs continuously between the three: full left is saw, centre is pulse, full right is triangle. It is a CROSSFADE, so the midpoints are real intermediate shapes and not a switch." },
  ],
};

export const VCV_BASAL_SPEC = {
  derivation: derivedFrom(VULT_MANUAL_SOURCE, ["basal/index.html", "examples/util/util.vult"], "BasalKernel", "dspSourcePlusModel", [...BLOCK_WIDE_DEVIATIONS, "D-MODEL"]),
  type: "audio_vcv_basal", module: "vcvBasal", title: "VCV Basal", family: "source",
  icon: "mdi:sine-wave", readout: "mod2", w: 175,
  help: "BEHAVIOUR MODEL over Vult's published tuning. The manual says Basal is \"designed for creating smooth sounds with low harmonic content\" with two controls that add harmonics — Mod 1 \"by distorting the phase\", Mod 2 by \"increasing the number of harmonics\". The tuning is his measured `Util.cvToPitch`; THE TWO MODULATION LAWS ARE A MODEL of those two sentences and will not match the original's spectrum. With both at zero it is a clean sine, which is the one thing the manual pins exactly.",
  inputs: [
    { key: "v_oct", type: "audio", label: "v/oct" },
    { key: "mod1", type: "audio", label: "mod1" },
    { key: "mod2", type: "audio", label: "mod2" },
  ],
  outputs: [{ key: "out", type: "audio", label: "out" }],
  knobs: [
    { key: "tune", label: "Tune", default: 0, min: -12, max: 12, step: 0.01, unit: " st", hz: vultC3SemitonesToHz, help: "Offsets the V/OCT input one octave up or down. Zero is C3 = 130.813 Hz, per the manual and the kernels' D1." },
    { key: "oct", label: "Octave", default: 0, min: -3, max: 3, step: 1, help: "Offsets the V/OCT input three octaves up and down. A transposition, so no frequency readout." },
    { key: "mod1", label: "Mod 1", default: 0, min: -1, max: 1, step: 0.01, help: "PHASE DISTORTION: the phase is warped by up to half a cycle of its own sine, which bunches the waveform towards one side and grows even harmonics. Bipolar, so the two directions lean opposite ways. The inlet is ±10 V for a full sweep, as the manual states." },
    { key: "mod2", label: "Mod 2", default: 0, min: 0, max: 1, step: 0.01, help: "HARMONIC COUNT: crossfades the pure sine towards a windowed resonant sine that completes up to eight cycles inside one period — a formant that climbs as the knob rises. At 0 the crossfade is complete and the output is EXACTLY the sine, so the manual's \"low harmonic content\" is preserved at the bottom of the knob rather than approximated." },
  ],
};

export const VCV_VESSEK_SPEC = {
  derivation: derivedFrom(VULT_MANUAL_SOURCE, ["vessek/index.html", "examples/util/util.vult", "examples/effects/saturate_soft.vult"], "VessekKernel", "dspSourcePlusModel", [...BLOCK_WIDE_DEVIATIONS, "D2", "D-BLEP", "D-VULTMOD", "D-MASTERTUNE", "D-MODEL"]),
  type: "audio_vcv_vessek", module: "vcvVessek", title: "VCV Vessek", family: "source",
  icon: "mdi:waveform", readout: "mix", w: 230,
  help: "BEHAVIOUR MODEL over Vult's published saturator and tuning. Vessek is a whole analogue-modelled voice: two oscillators with FM, AM and variable sync between them, a shaper with an asymmetry offset, a gate-triggered fade envelope and a glide. Its manual is unusually detailed and IS the specification for the routing here — but the module is closed, so every depth law below is a model and the timbre will not match. The one thing that is his and is exact is `saturate_soft`, the tanh limiter the shaper ends in.",
  inputs: [
    { key: "v_oct", type: "audio", label: "v/oct" },
    { key: "gate", type: "audio", label: "gate" },
    { key: "ext", type: "audio", label: "ext" },
    { key: "pw_cv", type: "audio", label: "pw cv" },
    { key: "wave_cv", type: "audio", label: "wav cv" },
    { key: "fm_cv", type: "audio", label: "fm cv" },
    { key: "mix_cv", type: "audio", label: "mix cv" },
  ],
  outputs: [
    { key: "out", type: "audio", label: "out" },
    { key: "fade", type: "audio", label: "fade" },
  ],
  knobs: [
    { key: "tune", label: "Tune", default: 0, min: -1, max: 1, step: 0.001, help: "Offsets both oscillators, over the range the Tune Mode switch selects. A transposition, so no frequency readout — and its meaning changes with the switch, which is why it is a bare ±1 rather than semitones." },
    { key: "tuneMode", label: "Tune mode", default: "coarse", discrete: true, options: ["fine", "coarse", "semi"], help: "What the Tune knob's ±1 means: `fine` is one semitone either way, `coarse` is one octave, `semi` is one octave QUANTIZED to semitones — the setting that lets a modulated Tune knob arpeggiate in tune." },
    { key: "oct", label: "Octave", default: 0, min: -3, max: 3, step: 1, help: "Offsets both oscillators three octaves up and down. The manual suggests modulating it: \"you'll get some nice arpeggios\"." },
    { key: "detuneB", label: "Detune B", default: 0, min: -12, max: 12, step: 0.01, unit: " st", help: "How far oscillator B sits from A, in semitones. Small values beat; an interval makes the pair a chord; and it is what the FM and sync controls act across." },
    { key: "pwA", label: "PW A", default: 0.5, min: 0, max: 1, step: 0.01, help: "Oscillator A's pulse width — a duty cycle on the pulse, a double saw on the saw, an asymmetry on the triangle." },
    { key: "waveA", label: "Wave A", default: 0, min: 0, max: 1, step: 0.01, help: "Oscillator A's shape: saw at 0, pulse at 0.5, triangle at 1, crossfaded." },
    { key: "pwB", label: "PW B", default: 0.5, min: 0, max: 1, step: 0.01, help: "Oscillator B's pulse width." },
    { key: "waveB", label: "Wave B", default: 0, min: 0, max: 1, step: 0.01, help: "Oscillator B's shape." },
    { key: "mix", label: "Mix", default: 0.5, min: 0, max: 1, step: 0.01, help: "The balance between the two oscillators: 0 is A alone, 1 is B alone. Everything A does to B — FM, AM, sync — is audible at any mix, because it happens before this." },
    { key: "fm", label: "FM", default: 0, min: 0, max: 1, step: 0.01, help: "How hard A modulates B's frequency. Exponential, so an interval of modulation is the same interval wherever B is parked. The manual: \"adds some nice harmonics\" — and inharmonic ones, until you raise Sync." },
    { key: "am", label: "AM", default: 0, min: 0, max: 1, step: 0.01, help: "How hard A modulates B's amplitude. At full depth B is gated by A's positive half, which is ring-modulation territory." },
    { key: "sync", label: "Sync", default: 0, min: 0, max: 1, step: 0.01, help: "A's wrap resets B, and the knob is HOW MUCH: at the bottom it nudges B's phase, at the top it is a hard reset. The manual's own reason to care: \"using Sync, the inharmonic sounds produced by the FM become more harmonic\"." },
    { key: "shaper", label: "Shaper", default: 0, min: 0, max: 1, step: 0.01, help: "Drives the mixed pair into `saturate_soft`, the author's own tanh limiter. Its character depends on Offset — a symmetric signal folds symmetrically and adds odd harmonics; an offset one adds even ones." },
    { key: "offset", label: "Offset", default: 0, min: -1, max: 1, step: 0.01, help: "DC added BEFORE the shaper, up to ±5 V, to make the distortion asymmetric. On its own it does nothing audible; with Shaper up it changes which harmonics appear." },
    { key: "fade", label: "Fade", default: 0.2, min: 0, max: 1, step: 0.01, help: "The decay time of the envelope the `gate` inlet triggers, up to four seconds. Its output is on the `fade` jack — and if `ext` is patched, the envelope is a VCA on that signal instead, which is how the manual gets percussive timbre changes out of one module." },
    { key: "glide", label: "Glide", default: 0, min: 0, max: 1, step: 0.01, help: "Portamento on the `v/oct` inlet, up to one second. Zero is off, exactly." },
    { key: "glideMode", label: "Glide mode", default: "skipGate", discrete: true, options: ["skipGate", "always"], help: "`skipGate` suppresses the glide when the pitch changes at the same moment as a gate, so a re-triggered note jumps and a legato one slides — which is how a monosynth is supposed to behave. `always` slides regardless." },
  ],
};

export const VCV_SAICH_SPEC = {
  derivation: derivedFrom(INSTRUO_SOURCE, ["saïch-Manual.pdf", "library.vcvrack.com/Instruo/saich"], "SaichKernel", "behaviourOnly", [...BLOCK_WIDE_DEVIATIONS, "D6", "D-BLEP", "D-MODEL"]),
  type: "audio_vcv_saich", module: "vcvSaich", title: "Instruo saich", family: "source",
  icon: "mdi:waveform", readout: "mixProfile", w: 205,
  help: "BEHAVIOUR ONLY — Instruō's modules are closed with no published DSP, so this is derived from the vendor manual and WILL NOT sound like the original. What is faithful is the ARCHITECTURE: four oscillators, one mixed output, a global coarse and fine, per-voice detune on voices 2–4, and a Scan fader that sweeps a chosen \"mix profile\" across the four voices' VCAs. The seven profiles are named by the manual; their curves are not published and are defined here. THE TUNING ORIGIN IS ASSUMED (C4) — the manual gives none.",
  inputs: [
    { key: "voct1", type: "audio", label: "v/oct 1" },
    { key: "voct2", type: "audio", label: "v/oct 2" },
    { key: "voct3", type: "audio", label: "v/oct 3" },
    { key: "voct4", type: "audio", label: "v/oct 4" },
    { key: "pwm", type: "audio", label: "pwm" },
    { key: "cv", type: "audio", label: "cv" },
    { key: "scan", type: "audio", label: "scan" },
  ],
  outputs: [{ key: "out", type: "audio", label: "out" }],
  knobs: [
    { key: "coarse", label: "Coarse", default: 0, min: -36, max: 36, step: 0.01, unit: " st", hz: squinkySemitonesToHz, help: "Global coarse frequency for all four voices, three octaves either way. THE ORIGIN IS ASSUMED: the manual documents no tuning reference, so this uses C4 = 261.626 Hz. If the original turns out to sit elsewhere, this is the one number to change." },
    { key: "fine", label: "Fine", default: 0, min: -1, max: 1, step: 0.01, unit: " st", help: "Global fine frequency, ±1 semitone." },
    { key: "detune2", label: "Detune 2", default: 0, min: -1, max: 1, step: 0.01, unit: " st", help: "Voice 2's own detune, ±1 semitone (the figure Instruō gave for the hardware). Voice 1 has none — it is the reference the other three are tuned against." },
    { key: "detune3", label: "Detune 3", default: 0, min: -1, max: 1, step: 0.01, unit: " st", help: "Voice 3's detune, ±1 semitone." },
    { key: "detune4", label: "Detune 4", default: 0, min: -1, max: 1, step: 0.01, unit: " st", help: "Voice 4's detune, ±1 semitone. Set the three a few cents apart and the four voices are a unison; set them to intervals and they are a chord from one gate." },
    { key: "scan", label: "Scan", default: 0.5, min: 0, max: 1, step: 0.01, help: "The Fader. It sweeps whatever the Mix Profile selects — this is the module's macro control, and the reason the manual calls the mixer \"automation-styled\"." },
    { ...trimKnob("cvAtten", "CV attenuverter", "scan") },
    { key: "pw", label: "Pulse width", default: 0.5, min: 0, max: 1, step: 0.01, help: "VOICE 1 ONLY, and only in `pulse` mode: voices 2–4 generate ramps and nothing else, which is the manual's own division of labour." },
    { key: "wave", label: "Wave", default: "ramp", discrete: true, options: ["ramp", "saw", "pulse"], help: "Voice 1's shape. `ramp` and `saw` differ only in sign — which matters when four voices are summed, because an inverted voice subtracts where the others add." },
    { key: "sub", label: "Sub", default: "fundamental", discrete: true, options: ["fundamental", "sub1", "sub2", "subMix"], help: "Voice 1's sub-octave. `fundamental` is the plain ramp; `sub1` is the manual's \"inverted sawtooth dropped one octave\". `sub2` and `subMix` continue the pattern down and are A GUESS — the manual documents only the first two." },
    {
      key: "mixProfile", label: "Mix profile", default: "basicVca", discrete: true,
      options: ["basicVca", "cascadeCrossfade", "oddsToEvens", "smartPairs", "constantRoot", "voiceSubtraction", "voiceArpeggiator"],
      help: "How the Scan fader distributes level across the four voices. `basicVca` opens all four together. `cascadeCrossfade` walks a window along them. `oddsToEvens` swaps 1&3 for 2&4. `smartPairs` swaps the first pair for the second. `constantRoot` keeps voice 1 up and fades the rest in. `voiceSubtraction` drops them one at a time. `voiceArpeggiator` selects exactly one. THE NAMES ARE THE MANUAL'S; THE CURVES ARE NOT PUBLISHED and are defined in the kernel.",
    },
  ],
};

// ═══════════════════════════════════════════════════════════════════════════
// FILTERS
// ═══════════════════════════════════════════════════════════════════════════

export const VCV_F2_SPEC = {
  derivation: derivedFrom(SQUINKY_SOURCE, ["composites/F2_Poly.h", "dsp/filters/StateVariableFilter2.h", "dsp/utils/Limiter.h", "dsp/filters/MultiLag2.h"], "F2Kernel", "source", [...BLOCK_WIDE_DEVIATIONS, "D4", "D6", "D10", "D-CVCACHE", "D-VU"]),
  type: "audio_vcv_f2", module: "vcvF2", title: "VCV F2", family: "filter",
  icon: "mdi:filter-variant", readout: "fc", w: 185,
  help: "PORTED FROM SOURCE. TWO state-variable peaks, 4× oversampled, with a Spread control that pushes them apart and four ways to combine them: one alone, in series, summed, or SUBTRACTED. The subtraction is the interesting one — two peaks a little apart, one inverted, is a notch you can sweep with resonance on both sides of it. Ported from `F2_Poly.h`, NOT from `F2.h`: that file's whole body is inside `#if 0` and its own first line says \"don't include this file!\".",
  inputs: [
    { key: "audio", type: "audio", label: "in" },
    { key: "fc_cv", type: "audio", label: "fc" },
    { key: "q_cv", type: "audio", label: "q" },
    { key: "r_cv", type: "audio", label: "r" },
  ],
  outputs: [{ key: "audio", type: "audio", label: "out" }],
  knobs: [
    { key: "fc", label: "Cutoff", default: F2_FC_DEFAULT_HZ, min: F2_FC_MIN_HZ, max: F2_FC_MAX_HZ, step: 1, unit: " Hz", help: "The centre frequency, in HERTZ — their own 0…10 V control is `261.6256 · 2^(v − 4)`, and this knob is that function's output so the number on the card is the frequency you get. The `fc` inlet carries SEMITONES and composes in the PITCH domain, so twelve on the wire is an octave wherever the knob sits." },
    { key: "q", label: "Resonance", default: 2, min: 0, max: 10, step: 0.01, help: "Their own 0…10 control, kept in their domain ON PURPOSE: the Q it produces depends on the TOPOLOGY (`2^(q/1.5)` with one stage, `2^(q/2.5)` with two), so a knob labelled in Q would mean two different things depending on a different knob. At the default of 2 a single peak is Q ≈ 2." },
    { key: "r", label: "Spread", default: 0, min: 0, max: 10, step: 0.01, help: "How far the two peaks separate, and it only does anything in the three two-stage topologies. Their law kinks at 3: below it the knob is halved (\"make less sensitive for low value\"), above it it is offset. At 0 the two peaks are on top of each other." },
    { key: "volume", label: "Volume", default: 50, min: 0, max: 100, step: 1, unit: " %", help: "Output level, through their audio taper and a `4√2` scale. 50 is their default and lands near unity for a nominal input." },
    { ...trimKnob("fcTrim", "Cutoff CV trim", "cutoff") },
    { ...trimKnob("qTrim", "Resonance CV trim", "resonance") },
    { ...trimKnob("rTrim", "Spread CV trim", "spread") },
    {
      key: "topology", label: "Topology", default: "single", discrete: true, options: ["single", "series", "parallel", "parallelInv"],
      help: "`single` is one 2-pole peak. `series` runs both, one into the other, for a 4-pole slope with two corners. `parallel` SUMS them — two resonant peaks at once, which is a formant pair. `parallelInv` subtracts the second, which puts a notch between the peaks and is the reason this module exists.",
    },
    {
      key: "mode", label: "Mode", default: "lowpass", discrete: true, options: ["lowpass", "bandpass", "highpass", "notch"],
      help: "Which node of the state-variable core each stage reports. `notch` is `low + high` from the same core, so it tracks the cutoff exactly.",
    },
    { key: "limiter", label: "Limiter", default: "on", discrete: true, options: ON_OFF, help: "ON, a peak limiter catches the resonance so a sweep at high Q stays put. OFF, a computed makeup gain (`1/√Q`, or a Spread-dependent blend with two stages) is applied instead — quieter and cleaner, but a high-Q sweep will jump at you. Their default is on." },
    { key: "altLimiter", label: "Fast limiter", default: "on", discrete: true, options: ON_OFF, help: "Switches the limiter's own constants: `on` is 3 ms attack, 20 ms release and 20× input gain; `off` is 1 ms / 100 ms / 4×. The fast one grabs transients and pumps; the slow one rides the level. Their default is on." },
  ],
};

export const VCV_FILT_SPEC = {
  derivation: derivedFrom(SQUINKY_SOURCE, ["composites/Filt.h", "composites/LadderFilterBank.h", "dsp/filters/LadderFilter.h", "dsp/filters/TrapezoidalLowpass.h"], "FiltKernel", "source", [...BLOCK_WIDE_DEVIATIONS, "D4", "D6", "D7", "D9", "D-QCOMP", "D-ASYM", "D-LEDS", "D-POLYMODE"]),
  type: "audio_vcv_filt", module: "vcvFilt", title: "VCV Filt", family: "filter",
  icon: "mdi:filter", readout: "type", w: 225,
  help: "PORTED FROM SOURCE, and it is the deepest port in this block. A Moog-style four-pole ladder, 4× oversampled, with FIFTEEN tap configurations (four lowpass slopes, bandpasses, highpasses, a notch and a phaser — all from the same four poles), FIVE saturator voicings, a continuous Slope crossfade between the lowpass taps, a per-stage Edge gain that moves where the distortion happens, and a capacitor Spread that pulls the four poles apart. The feedback runs through a measured stability ceiling, which is why a resonance sweep here does not blow up.",
  inputs: [
    { key: "l_audio", type: "audio", label: "L in" },
    { key: "r_audio", type: "audio", label: "R in" },
    { key: "cv1", type: "audio", label: "fc 1" },
    { key: "cv2", type: "audio", label: "fc 2" },
    { key: "q_cv", type: "audio", label: "q cv" },
    { key: "drive_cv", type: "audio", label: "drv cv" },
    { key: "slope_cv", type: "audio", label: "slp cv" },
    { key: "edge_cv", type: "audio", label: "edg cv" },
  ],
  outputs: [
    { key: "l_audio", type: "audio", label: "L out" },
    { key: "r_audio", type: "audio", label: "R out" },
  ],
  knobs: [
    { key: "fc", label: "Cutoff", default: 0, min: -5, max: 5, step: 0.01, help: "Their own ±5 V control — `10 · 2^(v + 6)` hertz, so the default of 0 is 640 Hz and the top is 40 kHz (clamped by Nyquist). KEPT IN THEIR DOMAIN because every control on this panel is scaled against the others through one shared attenuverter law; relabelling one in isolation would break the relationship." },
    { key: "q", label: "Resonance", default: -5, min: -5, max: 5, step: 0.01, help: "Feedback around the four poles. Their law kinks at the middle so the top half reaches self-oscillation without the bottom half being unusable, and the result runs through a measured per-cutoff ceiling — which is the whole reason a fast sweep here stays stable." },
    { key: "drive", label: "Drive", default: -5, min: -5, max: 5, step: 0.01, help: "Input gain into the saturators, `0.15 + 4·audioTaper`. This is the knob that decides whether the Voicing is audible at all: at the bottom the ladder is nearly linear whatever voicing is selected." },
    { key: "edge", label: "Edge", default: 0, min: -5, max: 5, step: 0.01, help: "Redistributes gain BETWEEN the four stages, keeping their product constant — so the same total drive lands mostly on the first stage or mostly on the last. It changes WHERE the distortion happens rather than how much, and it is read through a 20-bin table whose step at the halfway point is part of the sound (kernels' D7)." },
    { key: "slope", label: "Slope", default: 5, min: -5, max: 5, step: 0.01, help: "4-POLE LOWPASS ONLY: a CONTINUOUS crossfade between the 1-, 2-, 3- and 4-pole taps, so you can sit between 12 and 18 dB per octave. Every other type ignores it, because their tap vectors are fixed." },
    { key: "spread", label: "Capacitor", default: 0, min: 0, max: 1, step: 0.01, help: "Pulls the four poles' frequencies apart geometrically about their product — the digital equivalent of mismatched capacitors. It smears the corner and takes the edge off the resonance, which is most of what makes a real ladder sound unlike an ideal one." },
    { key: "bassMakeup", label: "Bass makeup", default: 0, min: 0, max: 1, step: 0.01, help: "Adds `1 + amount·resonance` of output gain, compensating the low end a resonant ladder loses. At 0 you hear the classic bass suck; at 1 the level holds as you open the resonance." },
    { key: "masterVolume", label: "Volume", default: 0.5, min: 0, max: 1, step: 0.01, help: "Output level, squared and scaled by four — so 0.5 is unity." },
    { ...trimKnob("fc1Trim", "Cutoff CV 1 trim", "cutoff") },
    { ...trimKnob("fc2Trim", "Cutoff CV 2 trim", "cutoff") },
    { ...trimKnob("qTrim", "Resonance CV trim", "resonance") },
    { ...trimKnob("driveTrim", "Drive CV trim", "drive") },
    { ...trimKnob("slopeTrim", "Slope CV trim", "slope") },
    { ...trimKnob("edgeTrim", "Edge CV trim", "edge") },
    {
      key: "type", label: "Type", default: "lp4", discrete: true,
      options: ["lp4", "lp3", "lp2", "lp1", "bp2", "hp2lp1", "hp3lp1", "bp4", "lpNotch", "ap3lp1", "hp3", "hp2", "hp1", "notch", "phaser"],
      help: "Which mixture of the four pole outputs leaves the module — their panel names are 4P LP, 3P LP, 2P LP, 1P LP, 2P BP, 2HP+1LP, 3HP+1LP, 4P BP, LP+Notch, 3AP+1LP, 3P HP, 2P HP, 1P HP, Notch and Phaser. Every one of them is the SAME four lowpass poles with different tap weights, which is the trick a ladder makes possible; the five highpass-ish ones additionally park the first pole wide open.",
    },
    {
      key: "voicing", label: "Voicing", default: "transistor", discrete: true, options: ["transistor", "asymClip", "fold", "asymFold", "clean"],
      help: "The nonlinearity in each of the four stages. `transistor` is `2·tanh(x/2)` — the classic ladder. `asymClip` clips alternate stages on alternate halves, which generates even harmonics. `fold` and `asymFold` replace clipping with wave FOLDING, which is a completely different and much more aggressive sound. `clean` is linear, and is the one to pick when you want the filter and not the distortion.",
    },
  ],
};

export const VCV_TANGENTS_SPEC = {
  derivation: derivedFrom(VULT_SOURCE, ["examples/filters/svf.vult", "examples/util/util.vult", "examples/effects/saturate_soft.vult", "tangents/index.html"], "TangentsKernel", "dspSourcePlusModel", [...BLOCK_WIDE_DEVIATIONS, "D6", "D-SP3", "D-MODEL", "D-NOSELFOSC"]),
  type: "audio_vcv_tangents", module: "vcvTangents", title: "VCV Tangents", family: "filter",
  icon: "mdi:filter-variant", readout: "cutoff", w: 185,
  help: "VULT DSP + BEHAVIOUR MODEL. The filter CORE is a transcription of the author's own published `svf.vult` and `cubic_clipper`; the module around it is from the manual, which says Tangents is \"based on the Steiner-Parker structure\" and \"leaves exposed three inputs (LP, BP and HP)\" mixed to one output. THREE THINGS DIFFER FROM THE ORIGINAL AND ARE WORTH KNOWING: the three inputs run in separate cores here, so they do not interact through a shared resonance path; the paid version's three models are not ported; and the resonance does NOT reach self-oscillation, because a zero-delay-feedback core is unconditionally stable.",
  inputs: [
    { key: "lp_in", type: "audio", label: "lp in" },
    { key: "bp_in", type: "audio", label: "bp in" },
    { key: "hp_in", type: "audio", label: "hp in" },
    { key: "cutoff", type: "audio", label: "fc" },
  ],
  outputs: [{ key: "out", type: "audio", label: "out" }],
  knobs: [
    { key: "cutoff", label: "Cutoff", default: VULT_FC_DEFAULT_HZ, min: VULT_FC_MIN_HZ, max: VULT_FC_MAX_HZ, step: 1, unit: " Hz", help: "The corner, in HERTZ over the span their own 0…1 control covers — `Util.cvToPitch` puts its bottom at C1 = 32.703 Hz and `tune` clips its top at 20 kHz. The `fc` inlet carries SEMITONES and composes in the pitch domain, which is what the manual means by \"controlled with a 1V/Oct signal\"." },
    { ...trimKnob("cutoffAtten", "Cutoff CV trim", "cutoff") },
    { key: "resonance", label: "Resonance", default: 0.3, min: 0, max: 1, step: 0.01, help: "Boosts around the cutoff, exponentially — gentle across the bottom half, sharp at the top. IT DOES NOT SELF-OSCILLATE, unlike the original: the core is a zero-delay-feedback structure, which is unconditionally stable at any Q. Measured, and recorded as D-NOSELFOSC in the kernel." },
    { key: "drive", label: "Drive", default: 0, min: 0, max: 1, step: 0.01, help: "How hard the inputs hit the core before the cubic clipper in the feedback path — the manual's \"increasing the drive will cause the filter to saturate which adds interesting harmonics\"." },
  ],
};

export const VCV_UNSTABILE_SPEC = {
  derivation: derivedFrom(VULT_SOURCE, ["examples/filters/svf.vult", "examples/util/util.vult", "examples/effects/saturate_soft.vult", "unstabile/index.html"], "UnstabileKernel", "dspSourcePlusModel", [...BLOCK_WIDE_DEVIATIONS, "D6", "D-DRIVE", "D-NOSELFOSC"]),
  type: "audio_vcv_unstabile", module: "vcvUnstabile", title: "VCV Unstabile", family: "filter",
  icon: "mdi:filter-variant", readout: "cutoff", w: 185,
  help: "VULT DSP + BEHAVIOUR MODEL. The core is his published `svf.vult`; the \"circuit bent\" character the manual describes — \"nonlinearities that can occur when the circuit is fed with low voltage\" — is modelled as his own `cubic_clipper` on the filter's two integrator STATES, which is what bounds the resonance instead of letting it diverge. Four outputs: lowpass, bandpass, highpass, and a SEM-style blend whose centre position is a notch at the cutoff. It does not quite self-oscillate; see Resonance.",
  inputs: [
    { key: "in", type: "audio", label: "in" },
    { key: "cutoff", type: "audio", label: "fc" },
  ],
  outputs: [
    { key: "lp", type: "audio", label: "lp" },
    { key: "bp", type: "audio", label: "bp" },
    { key: "hp", type: "audio", label: "hp" },
    { key: "sem", type: "audio", label: "sem" },
  ],
  knobs: [
    { key: "cutoff", label: "Cutoff", default: VULT_FC_DEFAULT_HZ, min: VULT_FC_MIN_HZ, max: VULT_FC_MAX_HZ, step: 1, unit: " Hz", help: "The corner, in hertz over the span their 0…1 control covers. The `fc` inlet carries SEMITONES and is 1 V/oct, per the manual." },
    { ...trimKnob("cutoffAtten", "Cutoff CV trim", "cutoff") },
    { key: "resonance", label: "Resonance", default: 0.44, min: 0, max: 1, step: 0.01, help: "Exponential, and it rings hard at the top — but IT DOES NOT SELF-OSCILLATE where the original does. A zero-delay-feedback core's loop gain cannot exceed one at any Q, so it decays. Measured at 0.18 V from a 10 mV excitation at the top of the knob, and recorded as D-NOSELFOSC." },
    { key: "semblance", label: "Semblance", default: 0.5, min: 0, max: 1, step: 0.01, help: "SEM OUTPUT ONLY: blends lowpass into highpass. At 0 the SEM jack is the lowpass, at 1 the highpass, and at the CENTRE it is `low + high`, which is a notch sitting exactly on the cutoff — the manual's own description, and the reason the blend is doubled rather than averaged." },
    { key: "drive", label: "Drive", default: 0, min: 0, max: 1, step: 0.01, help: "Input gain into `saturate_soft` before the filter. Wider than Tangents', because the manual calls this one the module that \"makes everything sound big and distorted\"." },
  ],
};

export const VCV_LATERALUS_SPEC = {
  derivation: derivedFrom(VULT_SOURCE, ["examples/filters/ladder.vult", "examples/util/util.vult", "lateralus/index.html"], "LateralusKernel", "dspSourcePlusModel", [...BLOCK_WIDE_DEVIATIONS, "D6", "D-DRIVE"]),
  type: "audio_vcv_lateralus", module: "vcvLateralus", title: "VCV Lateralus", family: "filter",
  icon: "mdi:filter", readout: "cutoff", w: 185,
  help: "VULT DSP + BEHAVIOUR ASSEMBLY, and the highest-fidelity Vult port in this block. The manual says Lateralus is \"a detailed simulation model based on my own diode ladder filter\", and `examples/filters/ladder.vult` IS that filter, published by the same author — so the four poles, the cubic clipper between them and the HEUN predictor-corrector integrator are all transcribed rather than modelled. Heun is why this ladder stays stable at resonances an Euler one screams at. All four slopes are on jacks, which costs nothing: the four poles ARE the four slopes.",
  inputs: [
    { key: "in", type: "audio", label: "in" },
    { key: "cutoff", type: "audio", label: "fc" },
  ],
  outputs: [
    { key: "out_24db", type: "audio", label: "24 dB" },
    { key: "out_18db", type: "audio", label: "18 dB" },
    { key: "out_12db", type: "audio", label: "12 dB" },
    { key: "out_6db", type: "audio", label: "6 dB" },
  ],
  knobs: [
    { key: "cutoff", label: "Cutoff", default: VULT_FC_DEFAULT_HZ, min: VULT_FC_MIN_HZ, max: VULT_FC_MAX_HZ, step: 1, unit: " Hz", help: "The corner, in hertz. `ladder.vult`'s own `tune` clips at 20 kHz, which is why that is the top rather than Nyquist." },
    { ...trimKnob("cutoffAtten", "Cutoff CV trim", "cutoff") },
    { key: "resonance", label: "Resonance", default: 0.4, min: 0, max: 1, step: 0.01, help: "The ladder's feedback, `4·res` around four poles — his own scaling. The cubic clipper in the loop is what keeps the top of the knob musical instead of divergent, and it is his too." },
    { key: "drive", label: "Drive", default: 0, min: 0, max: 1, step: 0.01, help: "Input gain into `saturate_soft` before the ladder. The manual's suggestion for the 18 dB output — \"use this output and some drive to get some nice distorted sounds\" — is the one to try first." },
  ],
};

// ═══════════════════════════════════════════════════════════════════════════
// EFFECTS AND MODULATION
// ═══════════════════════════════════════════════════════════════════════════

export const VCV_FREQSHIFTER_SPEC = {
  derivation: derivedFrom(SQUINKY_SOURCE, ["composites/FrequencyShifter.h", "dsp/filters/HilbertFilterDesigner.cpp", "dsp/generators/SinOscillator.h", "src/BootyModule.cpp"], "FreqShifterKernel", "source", [...BLOCK_WIDE_DEVIATIONS, "D6", "D7", "D-ALLPASS", "D-STEREO"]),
  type: "audio_vcv_freqshifter", module: "vcvFreqShifter", title: "VCV Frequency Shifter", family: "effect",
  icon: "mdi:swap-horizontal", readout: "range", w: 195,
  help: "PORTED FROM SOURCE. A true single-sideband frequency shifter — squinkylabs' \"Booty Shifter\". It ADDS hertz rather than multiplying them, so harmonic ratios are destroyed and everything turns bell-like, metallic, or (at a few hertz) into a slow phasey drift. BOTH SIDEBANDS ARE ON THEIR OWN JACKS, which is what makes it usable rather than a black box — and WHICH JACK IS WHICH WAS MEASURED, not read off a panel: `sin` carries the UP-shifted sideband and `cos` the DOWN-shifted one, with about 55 dB between them. The port KEYS keep their source names (`SIN_OUTPUT`, `COS_OUTPUT`) and the labels say what came out. Underneath is a six-section all-pass network per side whose phase responses stay 90° apart from 4 Hz to 4 kHz — that pair is the whole trick, and their pole values are ported verbatim.",
  inputs: [
    { key: "audio", type: "audio", label: "in L" },
    { key: "cv", type: "audio", label: "cv" },
    { key: "audio_r", type: "audio", label: "in R" },
  ],
  outputs: [
    { key: "sin", type: "audio", label: "up L" },
    { key: "cos", type: "audio", label: "down L" },
    { key: "sin_r", type: "audio", label: "up R" },
    { key: "cos_r", type: "audio", label: "down R" },
  ],
  knobs: [
    { key: "pitch", label: "Shift", default: 0, min: -5, max: 5, step: 0.01, help: "How far the spectrum moves, as a fraction of whatever the Range switch selects — at Range 5 Hz this knob is ±5 Hz, at 5 kHz it is ±5 kHz. Kept in their own ±5 domain BECAUSE ITS UNIT CHANGES WITH THE SWITCH: a hertz label would be right in one position and wrong in four. The `cv` inlet adds to it in volts, and the sum is clamped to ±5 before use." },
    {
      key: "range", label: "Range", default: "5hz", discrete: true, options: ["5hz", "50hz", "500hz", "5khz", "exp"],
      help: "What full knob travel means. The four LINEAR settings are what a frequency shifter is for — 5 Hz is a slow beat against the original, 5 kHz is unrecognisable. `exp` is different in kind: it makes the knob 1 V/octave over 2 Hz to 2 kHz, which is a shift you can PLAY. This is their `dataToJson` field, so it is a knob here rather than a hidden variable (R7-11).",
    },
  ],
};

export const VCV_ATHRU_SPEC = {
  derivation: derivedFrom(INSTRUO_SOURCE, ["Athru-Manual-A5.pdf"], "AthruKernel", "behaviourOnly", [...BLOCK_WIDE_DEVIATIONS, "D2", "D6", "D-MODEL", "D-THRU"]),
  type: "audio_vcv_athru", module: "vcvAthru", title: "Instruo athru", family: "effect",
  icon: "mdi:waves", readout: "fold", w: 190,
  help: "BEHAVIOUR ONLY — Instruō publishes no DSP, so this is derived from the vendor manual and will not match the original's harmonics. What is faithful is the STRUCTURE the manual describes: a West-Coast timbre wavefolder whose depth runs through an EXPONENTIAL VCA, a symmetry bias that either sums a second signal in or adds DC (a switch), a Strike input that momentarily opens the folder, and an overdrive toggle. Folding inverts the signal each time it passes a threshold, so it ADDS partials to a simple wave rather than removing them from a complex one.",
  inputs: [
    { key: "in", type: "audio", label: "in" },
    { key: "fold_cv", type: "audio", label: "fold cv" },
    { key: "symmetry_cv", type: "audio", label: "sym" },
    { key: "strike", type: "audio", label: "strike" },
  ],
  outputs: [
    { key: "out", type: "audio", label: "out" },
    { key: "thru", type: "audio", label: "thru" },
  ],
  knobs: [
    { key: "fold", label: "Wavefold", default: 0.5, min: 0, max: 1, step: 0.01, help: "The fader. Exponential, per the manual's \"depth CV runs through an exponential response VCA\" — so the bottom is a real attenuator (\"fully downwards … results in near-silence\") and the top is many folds deep." },
    { ...trimKnob("foldAtten", "Wavefold CV trim", "wavefold") },
    { ...trimKnob("symmetryAtten", "Symmetry bias", "symmetry", 0) },
    { key: "symmetryMode", label: "Symmetry mode", default: "sum", discrete: true, options: ["sum", "bias"], help: "The switch beside the Symmetry Bias attenuverter. `sum` treats that jack as an external SIGNAL input summed ahead of the folder — the manual's own \"Summed Wavefolder\" patch, and how you fold two oscillators together. `bias` turns the attenuverter into a DC offset instead, which makes the folding asymmetric and brings out even harmonics." },
    { key: "strikeDecay", label: "Strike decay", default: 0.5, min: 0, max: 1, step: 0.01, help: "How long the Strike input's momentary opening lasts, up to two seconds. The manual gives a behaviour and a \"50% default position\" and no number, so the span is a model." },
    { key: "drive", label: "Drive", default: "off", discrete: true, options: ON_OFF, help: "The overdrive toggle. Adds a soft clip after the folder, normalised so unity stays unity — so it changes the shape without changing the level." },
  ],
};

export const VCV_OCHD_SPEC = {
  derivation: derivedFrom(INSTRUO_SOURCE, ["Ochd-Manual-A5.pdf", "instruomodular.com/product/ochd/"], "OchdKernel", "behaviourOnly", [...BLOCK_WIDE_DEVIATIONS, "D6", "D-MODEL", "D-EXPANDER", "D-STALL"]),
  type: "audio_vcv_ochd", module: "vcvOchd", title: "Instruo ochd", family: "modulation",
  icon: "mdi:wave", readout: "rate", w: 175,
  help: "BEHAVIOUR ONLY — closed source, derived from the vendor manual. Eight free-running triangle LFOs from ONE Rate knob, at ratios that never re-lock, so the eight outputs drift in and out of relationship forever. That is the entire module and it is why it is worth having: patch four of them at four destinations and a static patch breathes. The RATIO FAMILY here is the golden ratio and the knob's 13-octave span is FORCED by the manual's own two endpoints — 160 Hz at the fastest core's top, a 25-minute cycle at the slowest core's bottom.",
  inputs: [{ key: "rate_cv", type: "audio", label: "rate cv" }],
  outputs: [
    { key: "out1", type: "audio", label: "1" },
    { key: "out2", type: "audio", label: "2" },
    { key: "out3", type: "audio", label: "3" },
    { key: "out4", type: "audio", label: "4" },
    { key: "out5", type: "audio", label: "5" },
    { key: "out6", type: "audio", label: "6" },
    { key: "out7", type: "audio", label: "7" },
    { key: "out8", type: "audio", label: "8" },
  ],
  knobs: [
    { key: "rate", label: "Rate", default: 0.2375, min: 0, max: 1, step: 0.001, help: "Sets all eight cores at once, exponentially across thirteen octaves. Output 1 is the fastest and reaches 160 Hz at the top — audio rate, which is deliberate; output 8 is the slowest and reaches a 25-minute cycle at the bottom. The CV can push past both ends." },
    { ...trimKnob("rateAtten", "Rate CV trim", "rate") },
  ],
};

export const VCV_CAUDAL_SPEC = {
  derivation: derivedFrom(VULT_MANUAL_SOURCE, ["caudal/index.html"], "CaudalKernel", "dspSourcePlusModel", [...BLOCK_WIDE_DEVIATIONS, "D2", "D5", "D-MODEL"]),
  type: "audio_vcv_caudal", module: "vcvCaudal", title: "VCV Caudal", family: "modulation",
  icon: "mdi:pendulum", readout: "speed", w: 235,
  help: "BEHAVIOUR MODEL. Caudal is a chaotic modulation source shaped like a hanging four-segment pendulum, and twelve outputs report each segment's X, Y and angle. Its author built the original in SystemModeler and published none of it, so THE DYNAMICS HERE ARE NOT HIS — this is a coupled-pendulum chain integrated by semi-implicit Euler, which is the same FAMILY of system (chaotic, with segments that are correlated but never repeat) and will not reproduce his trajectories. Everything the module is USED for survives: twelve related, wandering, never-quite-repeating modulations from one seed.",
  inputs: [
    { key: "hit", type: "audio", label: "hit" },
    { key: "rev", type: "audio", label: "rev" },
    { key: "store", type: "audio", label: "store" },
    { key: "recall", type: "audio", label: "recall" },
    { key: "speed", type: "audio", label: "spd cv" },
    { key: "energy", type: "audio", label: "eng cv" },
  ],
  outputs: [
    { key: "x_1", type: "audio", label: "x1" }, { key: "y_1", type: "audio", label: "y1" }, { key: "a_1", type: "audio", label: "a1" },
    { key: "x_2", type: "audio", label: "x2" }, { key: "y_2", type: "audio", label: "y2" }, { key: "a_2", type: "audio", label: "a2" },
    { key: "x_3", type: "audio", label: "x3" }, { key: "y_3", type: "audio", label: "y3" }, { key: "a_3", type: "audio", label: "a3" },
    { key: "x_4", type: "audio", label: "x4" }, { key: "y_4", type: "audio", label: "y4" }, { key: "a_4", type: "audio", label: "a4" },
  ],
  knobs: [
    { key: "speed", label: "Speed", default: 0, min: 0, max: 1, step: 0.01, help: "How fast the chain swings, exponentially from a drift of tens of seconds to a flutter of a few hertz. It scales the integration step, so it does not change the SHAPE of the motion — the same trajectory plays faster." },
    { key: "energy", label: "Energy", default: 0, min: 0, max: 1, step: 0.01, help: "Gravity, which the manual describes as \"some of the properties of the model, for example the gravity and mass\". Low energy is a lazy swing; high energy is a chain that goes over the top, and going over the top is where the chaos comes from." },
    { ...seedKnob(1, "It picks the positions and velocities every `hit` redraws, so a document renders the same chaos every time.") },
  ],
};

/**
 * EVERY VC-10 SPEC, sources first then filters then effects and modulation —
 * the same ordering rule core/audio_specs.AUDIO_SPECS follows, so the palette
 * reads as one library rather than as three lists that happen to be adjacent.
 *
 * THE BARREL LINES THIS NEEDS (report to the lead; this file may not apply them):
 *   core/audio_blocks.js     `PORT_BLOCK_SPECS` must spread this array
 *   plugins/audio_index.js   must spread `BLOCK_PLUGINS` from audio_index_vc10.js
 * tests/port_vc10_test.js sweeps this array either way.
 */
export const BLOCK_SPECS = [
  VCV_SUPER_SPEC, VCV_WVCO_SPEC, VCV_BLEAK_SPEC, VCV_BASAL_SPEC, VCV_VESSEK_SPEC, VCV_SAICH_SPEC,
  VCV_F2_SPEC, VCV_FILT_SPEC, VCV_TANGENTS_SPEC, VCV_UNSTABILE_SPEC, VCV_LATERALUS_SPEC,
  VCV_FREQSHIFTER_SPEC, VCV_ATHRU_SPEC, VCV_OCHD_SPEC, VCV_CAUDAL_SPEC,
];
