/**
 * THE VC-3b MODULE SPECS — the twelve ported Bogaudio nodes.
 *
 * ── WHAT THIS FILE IS ───────────────────────────────────────────────────────
 * core/audio_specs.js's vocabulary applied to a fifth module set. Same record
 * shape, same rules, same reader (`core/audio_nodes.audioNodePlugin`): a spec is
 * the values that make one module differ from its neighbours, and NOTHING about
 * how it sounds. The DSP is `synth/vc3b_kernels.js`, and THE DERIVATION RECORD —
 * which Bogaudio module, which C++ file and function, which commit, the
 * recurrence in float, every named deviation — is that file's docblocks. Each
 * `help` below points at it rather than repeating it.
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
 * `tests/port_vc3b_test.js` pins both against `synth/worklets/processors_vc3b.js`
 * and `synth/vc3b_kernels.js`, which is where a dependency on the engine belongs.
 *
 * ── UNITS: REAL ONES, NOT RACK KNOB POSITIONS (kernels' D13) ────────────────
 * A Rack knob is almost always 0…1 with a display formula behind it: PEQ's
 * frequency knob is `position² · 20000 Hz`, Pressor's attack is
 * `position² · 500 ms`, its threshold is `position · 30 − 24 dB`. Those positions
 * are an artefact of a panel where every knob is the same knob.
 *
 * Here a knob carries the unit its READOUT would have shown — hertz, milliseconds,
 * decibels — and each kernel inverts the mapping at its own boundary so the
 * arithmetic downstream is byte-identical to the C++. The reason is the house
 * rule that a control the author cannot reason about is not a control: "0.2236"
 * is not a cutoff, "1000 Hz" is. A 0…1 knob survives only where the original's
 * own display is also a bare percentage (a level, a bandwidth, a mix).
 *
 * ── UNITS ON A WIRE: R7-UNITS, ALL FOUR CLAUSES, AS THEY LAND HERE ──────────
 * Every CV law in the `help` sentences below is written in VOLTS, because that is
 * what these modules are calibrated in. The conversion to a wire is per PORT KIND
 * and happens in exactly one file (`synth/worklets/processors_vc3b.js`):
 *
 *   LEVEL ports  ±1 IS ±5 V. A ±5 V Rack LFO is ±1.0 here, and Rack's ±10 V
 *                headroom is ±2.0 — legal on a float bus.
 *   PITCH ports  carry SEMITONES (`12 × volts`), origin C4. `pitch` on the VCO and
 *                the VCF, and ALL FOUR of Stack's ports.
 *   GATE ports   carry 0…1 LOGIC, mapped to Rack's 10 V gate. SampleHold's two
 *                triggers, Walk's `jump`, Switch's `gate`.
 *
 * The VCO's `sync` is deliberately a LEVEL port and not a gate: it drives a
 * positive-zero-crossing detector on an audio signal (their threshold is 0.01 V),
 * so an oscillator's own output is the intended source.
 *
 * ── THE PITCH ORIGIN IS THIS MODULE FAMILY'S OWN, AND IT IS NOT E4 ──────────
 * A pitch knob must show the frequency it means (a bare `0 st` is a control nobody
 * can reason about), and the converter is the one THIS family's tuning implies —
 * `dsp/pitch.hpp`'s `cvToFrequency`, i.e. `261.626 · 2^(st/12)`. Note the SIX
 * digits: Bogaudio spells C4 as 261.626 where Rack's own `dsp::FREQ_C4` is
 * 261.6256, and porting means porting their number. `core/audio_nodes.semitonesToHz`
 * is E4-origin (Axoloti's) and using it here would put every card four semitones
 * out, so `bogaudioSemitonesToHz` below is a deliberate restatement — pinned
 * against the DSP's own `bogSemitonesToHz` by tests/port_vc3b_test.js.
 *
 * A knob that is a TRANSPOSITION rather than an absolute tuning gets no frequency
 * beside it at all: Stack's Semitones, Octaves and Fine shift whatever arrives, so
 * a hertz readout there would be a confident lie.
 *
 * ── EVERY CV INLET IS AN `audio` PORT, INCLUDING THE GATES (kernels' D3) ────
 * Two reasons, and the second is not obvious. First, Bogaudio's CV laws branch on
 * whether a cable is present, which only a real audio input can answer. Second,
 * a gate inlet is declared `audio` rather than `trigger` DELIBERATELY: these
 * inlets are Schmitt-triggered audio inlets in the original (1 V up, 0.1 V down),
 * and `core/nodeflow.js` has no `audio -> trigger` coercion on purpose — so
 * typing them `trigger` would REFUSE an LFO or an oscillator as a clock source,
 * which is an ordinary thing to patch. `trigger -> audio` exists, so a real
 * trigger output still drives them.
 */

// ── THE DERIVATION INDEX ────────────────────────────────────────────────────

/**
 * THE ONE SOURCE THIS BLOCK IS PORTED FROM, and the commit it was read at.
 * R7-17: the record exists FOR DEBUGGING ("it's so we can debug shit and find
 * flaws in the emulation"), so it pins a commit rather than naming a project.
 */
export const BOGAUDIO_SOURCE = "github.com/bogaudio/BogaudioModules @ 656eaae458e045602dc974bae82e15a11e104958";

/**
 * Pure function. One node's derivation INDEX — deliberately an index and NOT a
 * copy of the record.
 *
 * ── WHY THIS IS NOT THE WHOLE RECORD ────────────────────────────────────────
 * AX-1 and AX-3 put a structured `derivation` on each spec; AX-2 put the record
 * in its kernel docblocks, which is what the Phase-3 brief asks for ("in the
 * kernel's docblock, with `help` pointing at it"). Both are right about something:
 * the RECURRENCE and the reasoning belong beside the arithmetic they describe (one
 * copy, next to the code a wrong sound is diffed against), and the SOURCE and the
 * DEVIATION LIST need to be machine-checkable so a block cannot ship without one.
 *
 * So this is the checkable half: the source commit, the C++ files, the kernel
 * class that holds the prose, and the deviation IDs that prose must define.
 * `tests/port_vc3b_test.js` asserts every `kernel` names a real exported class and
 * every deviation id really appears in synth/vc3b_kernels.js — so the index and the
 * record cannot drift apart, which a second prose copy could not promise.
 *
 * @param {string[]} files - the C++ files the port was read from
 * @param {string} kernel - the exported kernel class holding the full record
 * @param {string[]} deviations - the deviation ids that record must name
 * @returns {{source: string, files: string[], kernel: string, deviations: string[]}}
 *
 * @example derivedFrom(["src/Walk.cpp"], "WalkKernel", ["D0", "D2"]).kernel // "WalkKernel"
 * @example derivedFrom(["src/Walk.cpp"], "WalkKernel", ["D0"]).source.includes("656eaae") // true
 */
export function derivedFrom(files, kernel, deviations) {
  return { source: BOGAUDIO_SOURCE, files, kernel, deviations };
}

/** The deviations that bind EVERY node in this block — the voltage law, the
 *  modulate divider, the audio-typed CV inlets, the no-second-inlet rule and the
 *  mono wire. Named once so twelve rows cannot list four of the five. */
const BLOCK_WIDE_DEVIATIONS = ["D0", "D1", "D3", "D4", "D6"];

/** Bogaudio's own C4, to their six digits (`dsp/pitch.hpp referenceFrequency`).
 *  NOT Rack's `dsp::FREQ_C4` (261.6256) — porting means porting their number. */
const BOGAUDIO_C4_HZ = 261.626;
const SEMITONES_PER_OCTAVE = 12;

/**
 * Pure function. Semitones from C4 to hertz — the `hz` display field for this
 * family's pitch knobs, and the reason it is written here rather than imported:
 * core/ may not import synth/, and the E4-origin `semitonesToHz` in
 * core/audio_nodes.js would be four semitones wrong for a VCV module.
 *
 * @param {number} semitones - semitones from C4, which is 0
 * @returns {number} hertz
 *
 * @example bogaudioSemitonesToHz(0) // 261.626
 * @example bogaudioSemitonesToHz(12) // 523.252
 * @example bogaudioSemitonesToHz(-12) // 130.813
 */
export function bogaudioSemitonesToHz(semitones) {
  return BOGAUDIO_C4_HZ * Math.pow(2, semitones / SEMITONES_PER_OCTAVE);
}

// ── SHARED KNOB FRAGMENTS ───────────────────────────────────────────────────

/**
 * THE SEED KNOB. Bogaudio seeds every noise generator from `std::random_device`
 * (`dsp/noise.cpp:12`), so THEIR noise is not reproducible even on the same
 * machine; ours is (kernels' D2, and the project's determinism law). Same seed,
 * same noise, forever.
 */
const SEED = {
  key: "seed", label: "Seed", default: 0, min: 0, max: 65535, step: 1, construct: true,
  help: "CONSTRUCT-TIME: the generator's state is initialised once, so changing this rebuilds the module. THE REASON THIS KNOB EXISTS: Bogaudio seeds its noise from the machine's random device and is not reproducible even on the same box, and a document that renders differently every time is not a document. The seed is SCRAMBLED before use — a raw small seed leaves the generator in a cold corner where its first draws are all near one end of the range, which made every sample-and-hold in a patch start at the same value.",
};

/** The two-value on/off option every boolean switch in this block uses. Stated
 *  once so twelve rows cannot spell the same pair three ways. */
const ON_OFF = ["off", "on"];

/** The level/mix taper switch Bogaudio's VCA, VCM and XFade share. */
const TAPER = ["decibels", "linear"];

/** The sentence every taper row carries — one control, one explanation. */
const TAPER_HELP = "`decibels` is their default and is NOT a 6 dB-per-half taper: the level runs through `(1 − knob) × −60 dB`, so half-way up is −30 dB. `linear` multiplies amplitude directly. Wire one envelope into each and you get two audibly different envelopes from the same envelope, which is why the switch exists.";

/** Their `disableOutputLimit` context-menu item, as a row. It is a hard ±12 V
 *  clamp, NOT the soft saturator — the two are different sounds at the ceiling. */
const OUTPUT_LIMIT = {
  key: "outputLimit", label: "Output limit", default: "on", discrete: true, options: ON_OFF,
  help: "A HARD clamp at ±12 V (±2.4 on our wires), which is Bogaudio's own output ceiling and their context-menu option. Turning it off lets the module pass whatever it computes — useful when it feeds something that saturates properly, and a way to hear a mixer clip when it does not.",
};

// ── PEQ ─────────────────────────────────────────────────────────────────────

/** How many bands the collapsed PEQ family supports, and therefore how many band
 *  ports and band knobs the node declares. FOURTEEN is `PEQ14`, the widest
 *  Bogaudio ships; the ACTIVE count is the `bands` construct knob. */
const PEQ_MAX_BANDS = 14;

/** `PEQ14.hpp`'s fourteen frequency defaults, in HERTZ (their knob positions
 *  squared and scaled by 20000). RESTATED from the roster for the layering reason
 *  this file's header gives, and pinned against it by tests/port_vc3b_test.js. */
const PEQ14_FREQUENCIES_HZ = [95, 125, 175, 250, 350, 500, 700, 1000, 1400, 2000, 2800, 4000, 5600, 6900];

/** `PEQChannel`'s level span (`parametric_eq.cpp:5-6`) — the amplifier's own
 *  −60 dB floor, but only +6 dB of boost: a parametric band that could add 20 dB
 *  would be a distortion pedal. Their default position lands on exactly 0 dB. */
const PEQ_MIN_DB = -60;
const PEQ_MAX_DB = 6;

/**
 * Pure function. PEQ's per-band knob rows — fourteen levels and fourteen
 * frequencies, GENERATED rather than written out. Twenty-eight literals is
 * twenty-eight places for a band number to be wrong, and the only thing that
 * differs between them is one integer and one default.
 *
 * @returns {object[]} knob declarations, all fourteen levels then all fourteen
 *          frequencies (so the Inspector groups them by KIND, which is how an
 *          author reads a filter bank — "are my levels right" then "are my
 *          centres right")
 *
 * @example peqBandKnobs().length // 28
 * @example peqBandKnobs()[0].key // "level1"
 * @example peqBandKnobs()[14].key // "frequency1"
 * @example peqBandKnobs()[14].default // 95
 */
export function peqBandKnobs() {
  const levels = [];
  const frequencies = [];
  for (let i = 1; i <= PEQ_MAX_BANDS; i++) {
    levels.push({
      key: `level${i}`, label: `Band ${i} level`, default: 0, min: PEQ_MIN_DB, max: PEQ_MAX_DB, step: 0.1, unit: " dB",
      help: `Band ${i}'s output level in decibels, −60 (silence) to +6. Bogaudio's own default is exactly 0 dB. A band's LEVEL CV inlet ATTENUATES this rather than adding to it — 10 V is unity and 0 V is silence — which is what lets a bank of envelopes carve formants out of one signal.`,
    });
    frequencies.push({
      key: `frequency${i}`, label: `Band ${i} freq`, default: PEQ14_FREQUENCIES_HZ[i - 1], min: 3, max: 20000, step: 1, unit: " Hz",
      help: `Band ${i}'s centre frequency (or corner, for band 1 and the last band when they are shelving). The defaults are PEQ14's geometric spread; a 3- or 6-band patch sets its own — PEQ6's are 100, 175, 350, 700, 1400 and 2500 Hz, and the 3-band PEQ's are 100, 350 and 1000 Hz.`,
    });
  }
  return [...levels, ...frequencies];
}

/**
 * Pure function. PEQ's per-band LEVEL CV inlets, generated for the same reason
 * the knobs are.
 *
 * @returns {object[]} port declarations
 *
 * @example peqBandLevelInputs().length // 14
 * @example peqBandLevelInputs()[0].key // "level1_cv"
 * @example peqBandLevelInputs()[0].type // "audio"
 */
export function peqBandLevelInputs() {
  const inputs = [];
  for (let i = 1; i <= PEQ_MAX_BANDS; i++) inputs.push({ key: `level${i}_cv`, type: "audio", label: `lvl${i}` });
  return inputs;
}

/**
 * Pure function. PEQ's per-band outputs — the thing that makes it a filter BANK
 * rather than an equaliser, and what a vocoder's analysis side is built from.
 *
 * @returns {object[]} port declarations
 *
 * @example peqBandOutputs().length // 14
 * @example peqBandOutputs()[13].key // "band14"
 */
export function peqBandOutputs() {
  const outputs = [];
  for (let i = 1; i <= PEQ_MAX_BANDS; i++) outputs.push({ key: `band${i}`, type: "audio", label: `b${i}` });
  return outputs;
}

export const VCV_PEQ_SPEC = {
  derivation: derivedFrom(["src/PEQ6.cpp", "src/PEQ.hpp", "src/PEQ14.hpp", "src/parametric_eq.cpp", "src/dsp/filters/multimode.cpp"], "PeqKernel", [...BLOCK_WIDE_DEVIATIONS, "D7", "D8", "D9", "D-BE", "D-DEADSLEW", "D13"]),
  type: "audio_vcv_peq", module: "vcvPeq", title: "VCV Bogaudio PEQ", family: "filter",
  icon: "mdi:tune-vertical", readout: "bands", w: 420,
  help: "Bogaudio's whole parametric-EQ family — PEQ, PEQ6, PEQ14 — as ONE node whose band count is a knob. It is a BANK, not a tone control: N Butterworth bands in PARALLEL, each with its own level and centre, summed and softly saturated, with every band also available on its own output. Pull five of six bands to silence and you hear only the sixth, which is why it works as a formant shaper and as a vocoder's filter bank rather than as an EQ.",
  inputs: [
    { key: "in", type: "audio", label: "in" },
    { key: "frequency_cv", type: "audio", label: "f cv" },
    { key: "bandwidth_cv", type: "audio", label: "bw cv" },
    ...peqBandLevelInputs(),
  ],
  outputs: [
    { key: "out", type: "audio", label: "mix" },
    ...peqBandOutputs(),
  ],
  knobs: [
    {
      key: "bands", label: "Bands", default: 6, min: 2, max: 14, step: 1, construct: true,
      help: "CONSTRUCT-TIME: the bank is sized at build, so changing this rebuilds the module. How many bands run. 3, 6 and 14 are the widths Bogaudio ships as separate modules (PEQ, PEQ6, PEQ14); anything between works because the engine never cared. Bands above this count output silence and their level CVs do nothing. TWO is the floor: the first and last band take the shelving modes, so one band cannot be both.",
    },
    {
      key: "bandwidth", label: "Bandwidth", default: 0.33, min: 0, max: 1, step: 0.01,
      help: "How wide every BANDPASS band is, in OCTAVES rather than hertz — 0 is their minimum (about 1/48 octave) and 1 is ±2 octaves. Shared by all bands, as PEQ6 and PEQ14 share it. It does nothing to a band running as a shelf, because a shelf has no skirts to widen. PEQ6's default is 0.33 and PEQ14's is 0.11 (a 14-band bank needs narrower bands to stay separable).",
    },
    {
      key: "frequencyCvAtten", label: "Freq CV depth", default: 0, min: -1, max: 1, step: 0.01,
      help: "How much the global Frequency CV inlet moves EVERY band's centre, and in which direction. Zero by default, which is Bogaudio's own default — so that inlet does nothing until this is turned up. The CV sums in the PITCH domain, so one depth setting transposes the whole bank by the same interval wherever its bands are parked.",
    },
    {
      key: "fmodRange", label: "Freq CV range", default: "octave", discrete: true, options: ["octave", "full"],
      help: "Whether ±5 V of frequency CV spans ONE OCTAVE (musical, the default) or the filter's ENTIRE 3 Hz…20 kHz range (a sweep). Their `FMOD` switch. The choice is about resolution: an octave gives you 12 semitones across the full CV swing, full range gives you 75.",
    },
    {
      key: "lowMode", label: "Band 1 mode", default: "lowpass", discrete: true, options: ["bandpass", "lowpass"],
      help: "The FIRST band is either a 4-pole bandpass like every other band, or a TWELVE-pole lowpass shelf. The pole count is not a detail — 12 poles is 72 dB per octave, which is what makes it read as a shelf rather than as a wide band.",
    },
    {
      key: "highMode", label: "Last band mode", default: "highpass", discrete: true, options: ["bandpass", "highpass"],
      help: "The LAST band, mirrored: a 4-pole bandpass, or a 12-pole highpass shelf. With both ends shelving, the bank covers the whole spectrum with no gaps at the edges.",
    },
    ...peqBandKnobs(),
  ],
};

// ── SOURCES ─────────────────────────────────────────────────────────────────

export const VCV_BOG_VCO_SPEC = {
  derivation: derivedFrom(["src/VCO.cpp", "src/vco_base.cpp", "src/dsp/oscillator.cpp", "src/dsp/table.cpp", "src/dsp/filters/resample.cpp"], "VcoKernel", [...BLOCK_WIDE_DEVIATIONS, "D10", "D11", "D-ACTIVE", "D-POLY"]),
  type: "audio_vcv_bog_vco", module: "vcvBogVco", title: "VCV Bogaudio VCO", family: "source",
  icon: "mdi:sine-wave", readout: "frequency", w: 175,
  help: "Bogaudio's analogue-modelled oscillator: square, saw, triangle and sine from ONE phase accumulator, so they are phase-locked forever and can be mixed without beating. Anti-aliased TWICE OVER — a minBLEP correction at each discontinuity AND 8× oversampling with a 4-stage CIC decimator faded in above 2.88 kHz. That is the difference you hear two octaves up, where a naive oscillator folds its high harmonics back down as inharmonic whistling.",
  inputs: [
    { key: "pitch", type: "audio", label: "pitch" },
    { key: "sync", type: "audio", label: "sync" },
    { key: "pw_cv", type: "audio", label: "pw cv" },
    { key: "fm", type: "audio", label: "fm" },
  ],
  outputs: [
    { key: "square", type: "audio", label: "sqr" },
    { key: "saw", type: "audio", label: "saw" },
    { key: "triangle", type: "audio", label: "tri" },
    { key: "sine", type: "audio", label: "sin" },
  ],
  knobs: [
    {
      key: "frequency", label: "Frequency", default: 0, min: -36, max: 72, step: 0.1, unit: " st", hz: bogaudioSemitonesToHz,
      help: "Pitch in SEMITONES FROM C4 (R7-UNITS clause 3), so 0 is 261.626 Hz, 12 is an octave up and −36 is C1. Rack's own knob is the same span in volts (−3…+6 V); the numbers here are twelve times theirs and mean the same pitch. The `pitch` inlet carries semitones too and ADDS to this — clamped to ±60, which is their ±5 V — so one knob transposes a whole sequence.",
    },
    {
      key: "fine", label: "Fine", default: 0, min: -1, max: 1, step: 0.01, unit: " st",
      help: "Fine tune, ±1 semitone. It sums with Frequency in the same unit, which is the whole reason both are semitones. This is the knob a detuned pair is made of: two of these a few hundredths apart beat at a rate you can hear rather than at one you can count.",
    },
    {
      key: "pw", label: "Pulse width", default: 0, min: -1, max: 1, step: 0.01,
      help: "SQUARE ONLY: duty cycle, where 0 is 50% and ±1 reaches their 3%/97% limits (a pulse narrower than 3% of a cycle stops being a waveform and starts being a click). It is LATCHED once per cycle, because moving an edge mid-cycle would displace that edge's anti-aliasing correction from the edge it corrects.",
    },
    {
      key: "fmDepth", label: "FM depth", default: 0, min: 0, max: 1, step: 0.01,
      help: "How much the `fm` inlet moves the pitch. BELOW 0.01 THE FM PATH IS SKIPPED ENTIRELY — theirs, so a depth of zero costs nothing and a hair of depth is snapped to none rather than dithering the phase.",
    },
    {
      key: "fmMode", label: "FM mode", default: "exponential", discrete: true, options: ["linear", "exponential"],
      help: "`linear` is THROUGH-ZERO PHASE modulation — the FM signal offsets the phase by `2·fm` radians, so the oscillator can run backwards and the timbre stays in tune as depth rises. That is what an FM patch wants. `exponential` shifts the PITCH instead, which detunes as depth rises and is what a vibrato patch wants.",
    },
    {
      key: "tuning", label: "Tuning", default: "voct", discrete: true, options: ["voct", "hertz"],
      help: "`voct` is volts-per-octave — musical, and what everything else in the library speaks. `hertz` makes the Frequency knob LINEAR in frequency (1 V = 1000 Hz, or 1 Hz in Slow mode), which is how you tune an oscillator to a fixed beat rate against another rather than to a note.",
    },
    {
      key: "slow", label: "Slow", default: "off", discrete: true, options: ON_OFF,
      help: "Drops the frequency by SEVEN OCTAVES, putting the range at roughly 0.02…50 Hz. That turns the module into an LFO with four band-limited waveforms and a sync input — which is worth more than it sounds, because most LFOs alias when you sweep them.",
    },
    {
      key: "dcCorrection", label: "DC correction", default: "on", discrete: true, options: ON_OFF,
      help: "SQUARE ONLY: removes the DC offset a non-50% duty cycle introduces. On by default. Turning it off is not a bug to be fixed — a narrow pulse with its DC intact pushes a step into whatever it feeds, which is a legitimate way to bias a filter or a wavefolder.",
    },
  ],
};

// ── FILTERS ─────────────────────────────────────────────────────────────────

export const VCV_BOG_VCF_SPEC = {
  derivation: derivedFrom(["src/VCF.cpp", "src/dsp/filters/multimode.cpp"], "VcfKernel", [...BLOCK_WIDE_DEVIATIONS, "D-MINDELAY", "D13"]),
  type: "audio_vcv_bog_vcf", module: "vcvBogVcf", title: "VCV Bogaudio VCF", family: "filter",
  icon: "mdi:filter-variant", readout: "frequency", w: 175,
  help: "Bogaudio's multimode filter, and the one thing in this library with a CONTINUOUS slope: TWELVE independent Butterworth filters (1 pole through 12) run in parallel and the Slope knob crossfades between the two nearest, with a 50 ms slew on each gain. So the skirt steepness is a sweepable parameter anywhere between a gentle tilt and a 72 dB-per-octave brick wall. Lowpass, highpass, bandpass and band-reject, all from the same design.",
  inputs: [
    { key: "in", type: "audio", label: "in" },
    { key: "frequency_cv", type: "audio", label: "f cv" },
    { key: "fm", type: "audio", label: "fm" },
    { key: "pitch", type: "audio", label: "pitch" },
    { key: "q_cv", type: "audio", label: "q cv" },
    { key: "slope_cv", type: "audio", label: "slp cv" },
  ],
  outputs: [{ key: "out", type: "audio", label: "out" }],
  knobs: [
    {
      key: "frequency", label: "Frequency", default: 1000, min: 3, max: 20000, step: 1, unit: " Hz",
      help: "Cutoff, or the centre for bandpass and band-reject, in HERTZ (R7-UNITS clause 2 — a frequency's real unit). 1000 Hz is their own default. The `pitch` inlet carries SEMITONES from C4 and ADDS the frequency they name, so the filter tracks a keyboard; `f cv` is a level CV that moves the cutoff on the knob's own square-root scale, which is why a CV sweep sounds even rather than crawling at the bottom and racing at the top.",
    },
    {
      key: "frequencyCvAtten", label: "Freq CV depth", default: 0, min: -1, max: 1, step: 0.01,
      help: "How far the `f cv` inlet moves the cutoff, and in which direction. Zero by default, which is theirs — so that inlet does nothing until this is turned up. Negative inverts, which is how one envelope opens one filter and closes another.",
    },
    {
      key: "q", label: "Resonance", default: 0, min: 0, max: 1, step: 0.01,
      help: "Resonance for lowpass and highpass, BANDWIDTH for bandpass and band-reject — one knob with two jobs, as theirs has. The resonance is applied to exactly ONE section of the cascade (the middle one), which is what makes it a peak at the corner rather than a Q change spread across every pole; a 12-pole lowpass therefore resonates differently from a 4-pole one at the same setting.",
    },
    {
      key: "slope", label: "Slope", default: 0.522233, min: 0, max: 1, step: 0.001,
      help: "How steep the skirt is, CONTINUOUSLY: 0 is one pole (6 dB/octave) and 1 is twelve (72 dB/octave). The knob is SQUARED before it is used, so the gentle end has most of the travel. Their default lands on exactly 4 poles. Sweeping this is a real gesture and not a mode switch — the two nearest pole counts are crossfaded with a 50 ms slew.",
    },
    {
      key: "mode", label: "Mode", default: "lowpass", discrete: true, options: ["lowpass", "highpass", "bandpass", "bandreject"],
      help: "Which side of the corner survives. Changing it RESETS every filter section, as theirs does — a mode change re-poles the cascade and a stale tail would ring in the wrong mode. `bandreject` is the one worth knowing about: at a narrow bandwidth it is a notch you can sweep through a pad to make it breathe.",
    },
    {
      key: "bandwidthMode", label: "Bandwidth in", default: "pitched", discrete: true, options: ["pitched", "linear"],
      help: "BANDPASS AND BAND-REJECT ONLY: whether the Resonance knob's bandwidth is measured in OCTAVES (`pitched`, so the band's skirts are geometrically symmetric and stay musical as you sweep) or in HERTZ (`linear`, 10 Hz…5 kHz, so a swept band gets proportionally narrower as it rises). Their patch field is `bandwidthMode`.",
    },
  ],
};

// ── MODULATION AND UTILITY ──────────────────────────────────────────────────

export const VCV_SAMPLEHOLD_SPEC = {
  derivation: derivedFrom(["src/SampleHold.cpp", "src/dsp/noise.hpp", "src/dsp/signal.cpp"], "SampleHoldKernel", [...BLOCK_WIDE_DEVIATIONS, "D2", "D5"]),
  type: "audio_vcv_samplehold", module: "vcvSamplehold", title: "VCV Bogaudio S&H", family: "modulation",
  icon: "mdi:stairs-up", readout: "range", w: 165,
  help: "TWO sample-and-holds with a built-in four-colour noise source — and the unconnected input IS the feature, not a fallback: with nothing patched in, each half samples noise, so one 3 HP module is a random voltage generator with eight output ranges. Seven of these with empty inputs are the entire pitch and timbre memory of Omri Cohen's self-playing patch. Section 2 falls back to section 1's trigger, so one clock fires both halves and gives you a correlated pair.",
  inputs: [
    { key: "trigger1", type: "audio", label: "trig 1" },
    { key: "in1", type: "audio", label: "in 1" },
    { key: "trigger2", type: "audio", label: "trig 2" },
    { key: "in2", type: "audio", label: "in 2" },
  ],
  outputs: [
    { key: "out1", type: "audio", label: "out 1" },
    { key: "out2", type: "audio", label: "out 2" },
  ],
  knobs: [
    {
      key: "range", label: "Noise range", default: "0V-10V", discrete: true,
      options: ["+/-10V", "+/-5V", "+/-3V", "+/-1V", "0V-10V", "0V-5V", "0V-3V", "0V-1V"],
      help: "The range the INTERNAL NOISE is scaled to, when an input is left unpatched. Their eight menu choices exactly. The unipolar ones (`0V-…`) are what a pitch or a filter cutoff wants; the bipolar ones are for anything that wants to be pushed both ways. On our wires, 10 V is 2.0 and 5 V is 1.0.",
    },
    {
      key: "noiseType", label: "Noise colour", default: "white", discrete: true, options: ["white", "blue", "pink", "red"],
      help: "Which noise an unpatched input samples, and it changes the SEQUENCE's character rather than its spectrum: `white` gives independent values, `pink` and `red` are correlated so consecutive samples drift instead of jumping (a melody that wanders), and `blue` is a first difference so consecutive samples ALTERNATE. Live — switching costs no rebuild.",
    },
    {
      key: "track1", label: "Section 1 mode", default: "sample", discrete: true, options: ["sample", "track"],
      help: "`sample` grabs a value on the trigger's RISING EDGE and holds it — the two trigger inlets are GATE ports carrying 0…1 logic (R7-UNITS clause 4). `track` FOLLOWS the input for as long as the gate is high and freezes when it falls — which is a different instrument: a track-and-hold on an envelope gives you a plateau at whatever level the gate ended on. The Glide knob applies in `sample` mode only, because slewing a tracked signal is just a lowpass.",
    },
    {
      key: "invert1", label: "Section 1 invert", default: "off", discrete: true, options: ON_OFF,
      help: "Negates section 1's output. With both halves fed by one trigger and one inverted, the module emits a mirrored pair — two voices moving in opposite directions off one random value.",
    },
    {
      key: "track2", label: "Section 2 mode", default: "sample", discrete: true, options: ["sample", "track"],
      help: "Section 2's mode, independently. Sample on one half and track on the other is how you get a stepped voltage and a smoothed version of the same gate from one module.",
    },
    {
      key: "invert2", label: "Section 2 invert", default: "off", discrete: true, options: ON_OFF,
      help: "Negates section 2's output.",
    },
    {
      key: "smoothMs", label: "Glide", default: 0, min: 0, max: 10000, step: 1, unit: " ms",
      help: "How long the output takes to slew 10 V — their context-menu Glide slider. Zero is an instant step. At a second or more a random sequence stops being steps and becomes a drifting line, which is the cheapest way to turn a sample-and-hold into a smooth random modulator. SAMPLE MODE ONLY.",
    },
    { ...SEED },
  ],
};

export const VCV_WALK_SPEC = {
  derivation: derivedFrom(["src/Walk.cpp", "src/dsp/noise.cpp"], "WalkKernel", [...BLOCK_WIDE_DEVIATIONS, "D2"]),
  type: "audio_vcv_walk", module: "vcvWalk", title: "VCV Bogaudio Walk", family: "modulation",
  icon: "mdi:chart-timeline-variant", readout: "rate", w: 150,
  help: "A SMOOTH RANDOM WALKER, and not the same thing as smoothed noise: a leaky integrator over white noise, reflected at ±5 V, lowpassed by a filter the same knob moves, plus a decaying bias a jump sets. Smoothed noise returns to its mean; this WANDERS and stays where it wanders. That is why eight of them sound like eight hands on eight knobs rather than like eight LFOs — which is exactly what P5 uses them for.",
  inputs: [
    { key: "rate_cv", type: "audio", label: "rate cv" },
    { key: "offset_cv", type: "audio", label: "off cv" },
    { key: "scale_cv", type: "audio", label: "scl cv" },
    { key: "jump", type: "audio", label: "jump" },
  ],
  outputs: [{ key: "out", type: "audio", label: "out" }],
  knobs: [
    {
      key: "rate", label: "Rate", default: 0.1, min: 0, max: 1, step: 0.01,
      help: "How fast the walk moves — and it is raised to the FIFTH POWER, so the bottom nine-tenths of the knob is a very slow drift and the top tenth opens right up. Theirs, and that curve IS the knob's feel. It moves BOTH the integrator's memory and the smoothing filter's cutoff, which is why one knob changes the character and not just the speed.",
    },
    {
      key: "offset", label: "Offset", default: 0, min: -1, max: 1, step: 0.01,
      help: "Where the walk is centred, ±5 V. Applied AFTER Scale, so it survives being scaled to nothing — a Scale of 0 with an Offset set is a constant voltage, which is a legitimate way to park one.",
    },
    {
      key: "scale", label: "Scale", default: 1, min: 0, max: 1, step: 0.01,
      help: "How far the walk swings, before Offset. At 1 it uses the full ±5 V it reflects within, so the walk's own wall-bouncing is audible as a distribution that piles up at the extremes rather than being gaussian.",
    },
    {
      key: "jumpMode", label: "Jump input", default: "jump", discrete: true,
      options: ["jump", "track_and_hold", "sample_and_hold"],
      help: "What the `jump` inlet does — a GATE port carrying 0…1 logic (R7-UNITS clause 4). `jump` TELEPORTS the walk somewhere new in range (with the output's 100 ms slew smoothing the landing). `track_and_hold` freezes it while the gate is LOW. `sample_and_hold` freezes it between rising edges, turning a continuous walk into a stepped sequence that still wanders.",
    },
    { ...SEED },
  ],
};

export const VCV_PRESSOR_SPEC = {
  derivation: derivedFrom(["src/Pressor.cpp", "src/dsp/signal.cpp", "src/dsp/filters/utility.cpp"], "PressorKernel", [...BLOCK_WIDE_DEVIATIONS, "D13"]),
  type: "audio_vcv_pressor", module: "vcvPressor", title: "VCV Bogaudio Pressor", family: "effect",
  icon: "mdi:arrow-collapse-vertical", readout: "threshold", w: 190,
  help: "A real stereo compressor / limiter / noise gate with a sidechain — not a gain curve. The detector is an RMS over a 50 ms WINDOW (DC-blocked and rectified), attack and release are slew limiters on that envelope, the knee is a chord construction that starts 3 dB BELOW the threshold, and the output stage soft-saturates rather than clipping. It is used as a master-bus processor in P5 and P9, which is what a compressor has to be good enough for.",
  inputs: [
    { key: "left", type: "audio", label: "left" },
    { key: "right", type: "audio", label: "right" },
    { key: "sidechain", type: "audio", label: "sidech" },
    { key: "threshold_cv", type: "audio", label: "thr cv" },
    { key: "ratio_cv", type: "audio", label: "rat cv" },
    { key: "attack_cv", type: "audio", label: "atk cv" },
    { key: "release_cv", type: "audio", label: "rel cv" },
    { key: "input_gain_cv", type: "audio", label: "in cv" },
    { key: "output_gain_cv", type: "audio", label: "out cv" },
  ],
  outputs: [
    { key: "envelope", type: "audio", label: "env" },
    { key: "left", type: "audio", label: "left" },
    { key: "right", type: "audio", label: "right" },
  ],
  knobs: [
    {
      key: "threshold", label: "Threshold", default: 0, min: -24, max: 6, step: 0.1, unit: " dB",
      help: "Where compression (or gating) starts, relative to 5 V being 0 dB. Their span is −24…+6 dB and 0 is the default. With a SOFT knee the curve has already begun 3 dB below this number, which is why a threshold set exactly at a signal's level still audibly touches it.",
    },
    {
      key: "thresholdRange", label: "Threshold range", default: 1, min: 0, max: 4, step: 0.1,
      help: "Multiplies the Threshold knob's span — their `threshold_range` patch field, exposed as a knob because a value their patch SAVES is property state rather than a hidden preference. At 2 the same knob travel covers −48…+12 dB, which is what a gate on a quiet source needs.",
    },
    {
      key: "ratio", label: "Ratio", default: 0.55159, min: 0, max: 1, step: 0.001,
      help: "Compression ratio, on their own tangent curve: `1/tan((1 − knob^1.5)·π/4)`. So 0 is 1:1 (no compression), the default 0.55159 is EXACTLY 2:1, and 1 is infinity — a limiter. The curve exists because a linear ratio knob would put every useful setting in the bottom fifth of its travel.",
    },
    {
      key: "attack", label: "Attack", default: 50, min: 0, max: 500, step: 1, unit: " ms",
      help: "How fast the envelope may RISE, as a slew limit rather than a filter time constant. 50 ms is their default. Short attacks catch transients and squash them flat; long ones let the front of a drum through and duck only its tail, which is how a compressor adds punch instead of removing it.",
    },
    {
      key: "release", label: "Release", default: 200, min: 0, max: 2000, step: 1, unit: " ms",
      help: "How fast the envelope may FALL — the knob that decides whether the compressor breathes or pumps. Up to two seconds. Set it shorter than the source's natural decay and you hear the gain rise underneath the note, which is the pumping a dance mix is made of.",
    },
    {
      key: "inputGain", label: "Input gain", default: 0, min: -12, max: 12, step: 0.1, unit: " dB",
      help: "Gain BEFORE the detector, ±12 dB, so it moves the signal relative to the threshold as well as making it louder. Its CV inlet SUMS with the knob rather than attenuating it (theirs, and the asymmetry with the other inlets is deliberate in the original too).",
    },
    {
      key: "outputGain", label: "Output gain", default: 0, min: 0, max: 24, step: 0.1, unit: " dB",
      help: "Make-up gain after compression, 0…24 dB, applied before the soft saturator — so pushing it hard distorts gracefully rather than clipping. Its CV inlet also sums.",
    },
    {
      key: "detectorMix", label: "Sidechain mix", default: 0, min: -1, max: 1, step: 0.01,
      help: "SIDECHAIN ONLY: how much of the DETECTOR hears the sidechain instead of the programme. −1 is all programme, +1 is all sidechain, 0 is an even blend. A blend rather than a switch is the useful part — a kick ducking a pad by half is a mix decision, not an on/off.",
    },
    {
      key: "mode", label: "Mode", default: "compressor", discrete: true, options: ["compressor", "noise_gate"],
      help: "The same control path run either way up. `compressor` reduces gain ABOVE the threshold; `noise_gate` reduces it BELOW, with the Ratio knob deciding how hard. One module, two devices.",
    },
    {
      key: "detector", label: "Detector", default: "rms", discrete: true, options: ["rms", "peak"],
      help: "`rms` averages the rectified signal over a 50 ms WINDOW — a true boxcar, so a transient leaves the detector abruptly 50 ms later. `peak` uses the instantaneous absolute value. On percussion these sound nothing alike, and on a pad they are nearly identical.",
    },
    {
      key: "knee", label: "Knee", default: "soft", discrete: true, options: ["soft", "hard"],
      help: "`soft` starts bending 3 dB below the threshold along a chord whose slope depends on the ratio; `hard` is a corner. ⚠ IN NOISE-GATE MODE THIS DOES NOTHING — their own source comments the soft-knee branch as achieving nothing, and that is reproduced rather than fixed, because the gate in the patches was set against the behaviour it really has.",
    },
  ],
};

export const VCV_BOG_VCA_SPEC = {
  derivation: derivedFrom(["src/VCA.cpp", "src/dsp/signal.cpp"], "VcaKernel", [...BLOCK_WIDE_DEVIATIONS, "D-IDLE"]),
  type: "audio_vcv_bog_vca", module: "vcvBogVca", title: "VCV Bogaudio VCA", family: "modulation",
  icon: "mdi:volume-high", readout: "level1", w: 150,
  help: "Two independent VCAs sharing one taper switch. The taper is the module: in decibel mode half-way up is −30 dB, in linear mode it is half the amplitude, so the same envelope produces two audibly different shapes. Each level has a 5 ms slew, which is what turns a stepped CV into a fade instead of a click. Bogaudio's single metered VCAmp is the same arithmetic.",
  inputs: [
    { key: "cv1", type: "audio", label: "cv 1" },
    { key: "in1", type: "audio", label: "in 1" },
    { key: "cv2", type: "audio", label: "cv 2" },
    { key: "in2", type: "audio", label: "in 2" },
  ],
  outputs: [
    { key: "out1", type: "audio", label: "out 1" },
    { key: "out2", type: "audio", label: "out 2" },
  ],
  knobs: [
    {
      key: "level1", label: "Level 1", default: 0.8, min: 0, max: 1, step: 0.01,
      help: "Section 1's gain, 0 (silence) to 1 (unity). The `cv 1` inlet ATTENUATES this — 10 V is unity, 0 V is silence — so an envelope multiplies the knob rather than adding to it, which is what makes the knob a maximum level.",
    },
    {
      key: "level2", label: "Level 2", default: 0.8, min: 0, max: 1, step: 0.01,
      help: "Section 2's gain, independently. Two VCAs on one card is what a stereo pair or a dry/wet pair wants.",
    },
    { key: "taper", label: "Taper", default: "decibels", discrete: true, options: TAPER, help: TAPER_HELP },
  ],
};

export const VCV_VCM_SPEC = {
  derivation: derivedFrom(["src/VCM.cpp", "src/dsp/signal.cpp"], "VcmKernel", [...BLOCK_WIDE_DEVIATIONS, "D12", "D-NOSLEW"]),
  type: "audio_vcv_vcm", module: "vcvVcm", title: "VCV Bogaudio VCM", family: "modulation",
  icon: "mdi:tune", readout: "mix", w: 165,
  help: "A four-channel voltage-controlled mixer: a level knob and a CV inlet per channel, then a master. ⚠ THE MASTER LEVEL IS APPLIED TWICE — that is a bug in Bogaudio's own source (`VCM.cpp` multiplies by it, then writes `level * out`), so the master is SQUARED and the default 0.8 is really 0.64, i.e. 3.9 dB quieter than the panel claims. Reproduced deliberately: a patch mixed on this module was balanced against the squared curve.",
  inputs: [
    { key: "in1", type: "audio", label: "in 1" },
    { key: "cv1", type: "audio", label: "cv 1" },
    { key: "in2", type: "audio", label: "in 2" },
    { key: "cv2", type: "audio", label: "cv 2" },
    { key: "in3", type: "audio", label: "in 3" },
    { key: "cv3", type: "audio", label: "cv 3" },
    { key: "in4", type: "audio", label: "in 4" },
    { key: "cv4", type: "audio", label: "cv 4" },
    { key: "mix_cv", type: "audio", label: "mix cv" },
  ],
  outputs: [{ key: "mix", type: "audio", label: "mix" }],
  knobs: [
    { key: "level1", label: "Level 1", default: 0.8, min: 0, max: 1, step: 0.01, help: "Channel 1's gain. Its CV inlet attenuates the knob (10 V is unity). UNLIKE THE VCA, there is no slew on these, so a stepped CV into a VCM channel does click — theirs, and not smoothed here because it would make the module a different one from the one a patch was mixed on." },
    { key: "level2", label: "Level 2", default: 0.8, min: 0, max: 1, step: 0.01, help: "Channel 2's gain, with the same CV law and the same absence of a slew." },
    { key: "level3", label: "Level 3", default: 0.8, min: 0, max: 1, step: 0.01, help: "Channel 3's gain, with the same CV law and the same absence of a slew." },
    { key: "level4", label: "Level 4", default: 0.8, min: 0, max: 1, step: 0.01, help: "Channel 4's gain, with the same CV law and the same absence of a slew." },
    {
      key: "mix", label: "Mix level", default: 0.8, min: 0, max: 1, step: 0.01,
      help: "The master. ⚠ IT IS APPLIED TWICE — see this module's own description: the effective gain is this number SQUARED, so the taper is twice as steep as it looks and 0.8 is really 0.64. Bogaudio's bug, kept because the sound is what a patch was balanced against.",
    },
    { key: "taper", label: "Taper", default: "decibels", discrete: true, options: TAPER, help: TAPER_HELP },
    { ...OUTPUT_LIMIT },
  ],
};

export const VCV_XFADE_SPEC = {
  derivation: derivedFrom(["src/XFade.cpp", "src/dsp/signal.cpp"], "XFadeKernel", [...BLOCK_WIDE_DEVIATIONS]),
  type: "audio_vcv_xfade", module: "vcvXfade", title: "VCV Bogaudio XFade", family: "modulation",
  icon: "mdi:call-merge", readout: "mix", w: 150,
  help: "A crossfader with a CURVE control, which is the part worth having: at one extreme the middle of the sweep is SILENT (each side has fully cut by centre), at the other BOTH sides are at full level in the middle, and in between it is an ordinary blend. Decibel or amplitude cut. That makes it a mixer, a VCA and a wave-blender depending on where the curve sits.",
  inputs: [
    { key: "mix_cv", type: "audio", label: "mix cv" },
    { key: "a", type: "audio", label: "a" },
    { key: "b", type: "audio", label: "b" },
  ],
  outputs: [{ key: "out", type: "audio", label: "out" }],
  knobs: [
    {
      key: "mix", label: "Mix", default: 0, min: -1, max: 1, step: 0.01,
      help: "−1 is all A, +1 is all B, 0 is the middle (whatever the Curve makes the middle mean). The `mix cv` inlet ATTENUATES this rather than adding, so the knob is a depth control for the CV. There is a 10 ms slew on it, so a stepped CV crossfades instead of switching.",
    },
    {
      key: "curve", label: "Curve", default: 0.5, min: 0, max: 1, step: 0.01,
      help: "WHAT THE MIDDLE OF THE SWEEP MEANS. At 0 each input has fully cut by the time the mix reaches centre, so the centre is silence — a gap between two sources. At 1 neither has begun to cut at centre, so both are at full level and the centre is a sum. 0.5 is a normal blend. In decibel mode the knob is warped by `x^0.082` first, which widens the constant-power region.",
    },
    { key: "taper", label: "Taper", default: "decibels", discrete: true, options: TAPER, help: TAPER_HELP },
  ],
};

export const VCV_OFFSET_SPEC = {
  derivation: derivedFrom(["src/Offset.cpp"], "OffsetKernel", [...BLOCK_WIDE_DEVIATIONS]),
  type: "audio_vcv_offset", module: "vcvOffset", title: "VCV Bogaudio Offset", family: "modulation",
  icon: "mdi:swap-vertical", readout: "offset", w: 150,
  help: "Scale then offset, or offset then scale — an attenuverter with a DC adder, and the order switch matters: `(in + offset) × scale` moves a signal's centre before amplifying it (so the offset is amplified too), while `in × scale + offset` amplifies then re-centres. The scale is a SIGNED SQUARE times ten, so it has fine control near unity and reaches ±10×.",
  inputs: [
    { key: "offset_cv", type: "audio", label: "off cv" },
    { key: "scale_cv", type: "audio", label: "scl cv" },
    { key: "in", type: "audio", label: "in" },
  ],
  outputs: [{ key: "out", type: "audio", label: "out" }],
  knobs: [
    {
      key: "offset", label: "Offset", default: 0, min: -1, max: 1, step: 0.01,
      help: "The DC added, ±10 V (±2 on our wires). Its CV inlet ATTENUATES the knob bipolarly, so a ±10 V signal there sweeps the offset through zero and out the other side.",
    },
    {
      key: "scale", label: "Scale", default: Math.sqrt(0.1), min: -1, max: 1, step: 0.001,
      help: "The multiplier, as a SIGNED SQUARE times ten: the default 0.3162278 (the square root of a tenth) is EXACTLY 1.0×, negative values invert, and ±1 is ±10×. The square is why there is real resolution around unity instead of the whole useful range living in one degree of knob travel.",
    },
    {
      key: "order", label: "Order", default: "scale_first", discrete: true, options: ["scale_first", "offset_first"],
      help: "`scale_first` is `in × scale + offset` — amplify, then re-centre, which is what an attenuverter into a modulation input wants. `offset_first` is `(in + offset) × scale`, which amplifies the offset too and is how you bias a signal before a wavefolder or a filter's exponential input.",
    },
    { ...OUTPUT_LIMIT },
  ],
};

export const VCV_SWITCH_SPEC = {
  derivation: derivedFrom(["src/Switch.cpp", "src/rack_overrides.cpp"], "SwitchKernel", [...BLOCK_WIDE_DEVIATIONS, "D5"]),
  type: "audio_vcv_switch", module: "vcvSwitch", title: "VCV Bogaudio Switch", family: "modulation",
  icon: "mdi:toggle-switch-outline", readout: "latch", w: 150,
  help: "Two 2-way signal routers on one gate. Ungated it is a MULTIPLEXER (the gate's level chooses which input passes); latched it is a FLIP-FLOP (each rising edge toggles), so one clock alternates two sources forever. Both halves switch together, which is what routes a stereo pair or a pitch/gate pair with one control. Bogaudio's 4×4, 8×8 and 16×16 switches are the same idea at other widths.",
  inputs: [
    { key: "gate", type: "audio", label: "gate" },
    { key: "high1", type: "audio", label: "hi 1" },
    { key: "low1", type: "audio", label: "lo 1" },
    { key: "high2", type: "audio", label: "hi 2" },
    { key: "low2", type: "audio", label: "lo 2" },
  ],
  outputs: [
    { key: "out1", type: "audio", label: "out 1" },
    { key: "out2", type: "audio", label: "out 2" },
  ],
  knobs: [
    {
      key: "latch", label: "Latch", default: "off", discrete: true, options: ON_OFF,
      help: "`off` follows the gate's LEVEL — high passes the `hi` inputs, low passes the `lo` ones. `on` TOGGLES on every rising edge, so a clock alternates the two sources and the gate's width stops mattering. The `gate` inlet is a GATE port (R7-UNITS clause 4): it carries 0…1 logic, mapped onto Rack's 10 V gate, so a full gate sits an order of magnitude above Bogaudio's own 1 V Schmitt threshold and anything under 0.1 rearms it.",
    },
  ],
};

export const VCV_STACK_SPEC = {
  derivation: derivedFrom(["src/Stack.cpp", "src/dsp/pitch.hpp"], "StackKernel", [...BLOCK_WIDE_DEVIATIONS]),
  type: "audio_vcv_stack", module: "vcvStack", title: "VCV Bogaudio Stack", family: "modulation",
  icon: "mdi:layers-triple-outline", readout: "semitones", w: 150,
  help: "A pitch transposer for stacking a second voice on a first: it takes a pitch in and emits it shifted by octaves, semitones and cents, clamped to C1…C9. Two details make it more than an adder — its `thru` output becomes a TRANSPOSITION SOURCE when nothing is patched in, ready to drive another Stack's `cv`, and the transposition is quantised to whole semitones unless you say otherwise. ALL FOUR PORTS CARRY SEMITONES: Rack's `cv` inlet is ten semitones per volt and its `thru` emits `semitones/10` to match, a scale that is neither V/oct nor a level — so both are semitones here (deviation D-STACKUNITS in synth/vc3b_kernels.js), which makes chaining exact in one unit instead of exact only by agreeing on an arbitrary 10 st/V.",
  inputs: [
    { key: "cv", type: "audio", label: "cv" },
    { key: "in", type: "audio", label: "pitch" },
  ],
  outputs: [
    { key: "thru", type: "audio", label: "thru" },
    { key: "out", type: "audio", label: "out" },
  ],
  knobs: [
    {
      // `interval: true` — this is a TRANSPOSITION, not an absolute pitch. The pitch
      // arrives on `cv`/`in`; this knob ADDS to it, so there is no frequency to read out
      // and a hertz number beside it would be a confident lie (VC-1 reached the same
      // conclusion for Clouds' and Supercell's pitch knobs). tests/audio_nodes_test.js
      // holds the pair both ways: an interval must NOT carry `hz`, an absolute pitch MUST.
      key: "semitones", label: "Semitones", interval: true, default: 0, min: 0, max: 11, step: 1, unit: " st",
      help: "Transposition in whole semitones, 0…11 — the interval, with the Octaves knob supplying the register. 7 is a fifth, 4 a major third; the two together are how a chord is built out of three of these off one sequencer.",
    },
    {
      key: "octave", label: "Octaves", default: 0, min: -3, max: 3, step: 1, unit: " oct",
      help: "Whole octaves, ±3. Rounded before use, as theirs is, so an equation driving it lands on a real octave rather than between two.",
    },
    {
      key: "fine", label: "Fine", default: 0, min: -0.99, max: 0.99, step: 0.01, unit: " st",
      help: "Fine tune, up to ±99 cents — and it is applied AFTER quantisation, so it survives the Quantize switch. That is the knob that makes a stacked voice beat against the original instead of doubling it exactly.",
    },
    {
      key: "quantize", label: "Quantize", default: "on", discrete: true, options: ON_OFF,
      help: "Snaps the total transposition (knobs plus CV) to whole semitones. On by default. Off lets the CV inlet glide the interval continuously, which turns the module into a pitch-shifting portamento rather than a transposer.",
    },
  ],
};

/**
 * EVERY VC-3b SPEC — filters and sources first, then modulation and utility, which
 * is core/audio_specs.AUDIO_SPECS's own ordering rule, so the palette reads as one
 * library rather than as two lists that happen to be adjacent.
 *
 * THE BARREL LINE THIS NEEDS: `core/audio_blocks.js`'s `PORT_BLOCK_SPECS` must
 * spread this array and `plugins/audio_index.js`'s `audioPlugins` must spread the
 * matching plugin array, or these modules exist in the engine and nowhere the
 * author can reach. tests/port_vc3b_test.js sweeps this array either way.
 */
export const BLOCK_SPECS = [
  VCV_BOG_VCO_SPEC,
  VCV_PEQ_SPEC, VCV_BOG_VCF_SPEC,
  VCV_PRESSOR_SPEC,
  VCV_SAMPLEHOLD_SPEC, VCV_WALK_SPEC,
  VCV_BOG_VCA_SPEC, VCV_VCM_SPEC, VCV_XFADE_SPEC, VCV_OFFSET_SPEC, VCV_SWITCH_SPEC, VCV_STACK_SPEC,
];
