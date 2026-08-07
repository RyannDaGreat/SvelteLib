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

// ── PEQ6 — THE SIX-BAND WIDTH, WITH THE PER-BAND CV THE COLLAPSED NODE DROPS ─

/** `PEQ6.hpp`'s six frequency defaults, in HERTZ (their positions squared and
 *  scaled by 20000). NOT PEQ14's first six — a six-band bank is spread wider. */
const PEQ6_FREQUENCIES_HZ = [100, 175, 350, 700, 1400, 2500];
const PEQ6_BANDS = 6;

/**
 * Pure function. PEQ6's per-band knob rows — a level, a centre and a frequency-CV
 * attenuverter for each of the six, GENERATED for the reason `peqBandKnobs` is:
 * eighteen literals is eighteen places for a band number to be wrong.
 *
 * @returns {object[]} knob declarations, grouped by KIND (all levels, all
 *          centres, all attenuverters) so the Inspector reads the way an author
 *          works a filter bank
 *
 * @example peq6BandKnobs().length // 18
 * @example peq6BandKnobs()[0].key // "level1"
 * @example peq6BandKnobs()[6].default // 100
 * @example peq6BandKnobs()[12].key // "frequencyCvAtten1"
 */
export function peq6BandKnobs() {
  const levels = [];
  const frequencies = [];
  const attenuators = [];
  for (let i = 1; i <= PEQ6_BANDS; i++) {
    levels.push({
      key: `level${i}`, label: `Band ${i} level`, default: 0, min: PEQ_MIN_DB, max: PEQ_MAX_DB, step: 0.1, unit: " dB",
      help: `Band ${i}'s output level in decibels, −60 (silence) to +6, with 0 dB their own default. Its CV inlet ATTENUATES this rather than adding — 10 V is unity and 0 V is silence — which is what lets six envelopes carve six formants out of one signal.`,
    });
    frequencies.push({
      key: `frequency${i}`, label: `Band ${i} freq`, default: PEQ6_FREQUENCIES_HZ[i - 1], min: 3, max: 20000, step: 1, unit: " Hz",
      help: `Band ${i}'s centre (or its corner, for bands 1 and 6 when they are shelving). PEQ6's own six defaults are 100, 175, 350, 700, 1400 and 2500 Hz — roughly an octave apart, which is what makes the bank cover the spectrum without gaps.`,
    });
    attenuators.push({
      key: `frequencyCvAtten${i}`, label: `Band ${i} freq CV`, default: 1, min: -1, max: 1, step: 0.01,
      help: `How far band ${i}'s OWN frequency CV inlet moves its centre, and in which direction. It defaults to FULLY OPEN, unlike the global depth which defaults to zero — Bogaudio's own asymmetry, and it means patching that inlet does something immediately. It also scales the global CV's contribution to this band, so one band can be made to ignore a bank-wide sweep.`,
    });
  }
  return [...levels, ...frequencies, ...attenuators];
}

/**
 * Pure function. PEQ6's audio inlets, in Bogaudio's own `InputsIds` order: the
 * global three, then a LEVEL/FREQUENCY pair per band.
 *
 * @returns {object[]} port declarations, 15 of them
 *
 * @example peq6Inputs().length // 15
 * @example peq6Inputs()[3].key // "level1_cv"
 * @example peq6Inputs()[4].key // "frequency_cv1"
 */
export function peq6Inputs() {
  const ports = [
    { key: "frequency_cv", type: "audio", label: "f cv" },
    { key: "bandwidth_cv", type: "audio", label: "bw cv" },
    { key: "in", type: "audio", label: "in" },
  ];
  for (let i = 1; i <= PEQ6_BANDS; i++) {
    ports.push({ key: `level${i}_cv`, type: "audio", label: `lvl${i}` });
    ports.push({ key: `frequency_cv${i}`, type: "audio", label: `f${i} cv` });
  }
  return ports;
}

export const VCV_PEQ6_SPEC = {
  derivation: derivedFrom(["src/PEQ6.cpp", "src/PEQ6.hpp", "src/parametric_eq.cpp", "src/dsp/filters/multimode.cpp"], "PeqKernel", [...BLOCK_WIDE_DEVIATIONS, "D7", "D8", "D-BE", "D-DEADSLEW", "D13"]),
  type: "audio_vcv_peq6", module: "vcvPeq6", title: "VCV Bogaudio PEQ6", family: "filter",
  icon: "mdi:tune-vertical", readout: "bandwidth", w: 380,
  help: "Bogaudio's SIX-band parametric EQ, exactly as their panel draws it — and it is the same engine as the collapsed PEQ node with one thing added: EVERY BAND HAS ITS OWN FREQUENCY CV INLET AND ATTENUVERTER. That is the difference between a static formant bank and one whose bands move independently, which is what a vocoder or a sweeping resonator patch is made of. Six 4-pole bandpasses in parallel (the first and last optionally 12-pole shelves), summed and softly saturated, with every band also on its own output.",
  inputs: peq6Inputs(),
  outputs: [
    { key: "out", type: "audio", label: "mix" },
    ...Array.from({ length: PEQ6_BANDS }, (unused, i) => ({ key: `out${i + 1}`, type: "audio", label: `b${i + 1}` })),
  ],
  knobs: [
    {
      key: "bandwidth", label: "Bandwidth", default: 0.33, min: 0, max: 1, step: 0.01,
      help: "How wide every BANDPASS band is, in OCTAVES rather than hertz — 0 is about 1/48 octave and 1 is ±2 octaves. Shared by all six, and their default is 0.33. It does nothing to a band running as a shelf, because a shelf has no skirts to widen.",
    },
    {
      key: "frequencyCvAtten", label: "Global freq CV", default: 0, min: -1, max: 1, step: 0.01,
      help: "How much the global Frequency CV inlet moves EVERY band's centre. Zero by default, which is theirs, so that inlet does nothing until this is turned up. It sums in the PITCH domain and is then scaled by each band's OWN attenuverter, so one depth setting transposes the whole bank by one interval — and a band with its attenuverter at zero sits still while the rest sweep.",
    },
    {
      key: "lowMode", label: "Band 1 mode", default: "lowpass", discrete: true, options: ["bandpass", "lowpass"],
      help: "The FIRST band is either a 4-pole bandpass like the middle four, or a TWELVE-pole lowpass shelf. Twelve poles is 72 dB per octave, which is what makes it read as a shelf rather than as a very wide band.",
    },
    {
      key: "highMode", label: "Band 6 mode", default: "highpass", discrete: true, options: ["bandpass", "highpass"],
      help: "The LAST band, mirrored: a 4-pole bandpass, or a 12-pole highpass shelf. With both ends shelving the bank covers the whole spectrum with no gaps at the edges.",
    },
    {
      key: "fmodRange", label: "Freq CV range", default: "octave", discrete: true, options: ["octave", "full"],
      help: "Whether ±5 V of frequency CV spans ONE OCTAVE (musical, their default) or the filter's entire 3 Hz…20 kHz range (a sweep). The choice is about resolution: an octave gives 12 semitones across the full CV swing, full range gives 75.",
    },
    ...peq6BandKnobs(),
  ],
};

// ── SOURCES ─────────────────────────────────────────────────────────────────

/**
 * Pure function. One XCO waveform's three knob rows — its modifier, its phase and
 * its mix. Written once because the four waveforms differ only in the modifier's
 * name, range and sentence, and twelve hand-written rows is twelve chances to give
 * the sine the saw's default.
 *
 * @param {string} wave - the key stem, "square" | "saw" | "triangle" | "sine"
 * @param {string} label - the panel word, "Square" | "Saw" | …
 * @param {object} modifier - {key, label, default, min, max, step, unit, help}
 * @param {string} modifierHelp - the modifier row's sentence
 * @returns {object[]} three knob declarations
 *
 * @example xcoWaveKnobs("saw", "Saw", {suffix: "Saturation", label: "saturation", default: 0, min: 0, max: 1}, "x")[0].key // "sawSaturation"
 * @example xcoWaveKnobs("saw", "Saw", {suffix: "Saturation", label: "saturation", default: 0, min: 0, max: 1}, "x")[1].key // "sawPhase"
 * @example xcoWaveKnobs("saw", "Saw", {suffix: "Saturation", label: "saturation", default: 0, min: 0, max: 1}, "x")[2].default // 1
 */
export function xcoWaveKnobs(wave, label, modifier, modifierHelp) {
  return [
    {
      key: `${wave}${modifier.suffix}`, label: `${label} ${modifier.label}`,
      default: modifier.default, min: modifier.min, max: modifier.max, step: 0.01,
      help: modifierHelp,
    },
    {
      key: `${wave}Phase`, label: `${label} phase`, default: 0, min: -180, max: 180, step: 1, unit: "°",
      help: `Where the ${label.toLowerCase()} sits in the shared cycle, in DEGREES (their own readout unit). All four waveforms read ONE phase accumulator, so this is the only way to move them relative to each other — and moving two apart and mixing them is how you get comb-like cancellation from a single oscillator instead of from two detuned ones.`,
    },
    {
      key: `${wave}Mix`, label: `${label} mix`, default: 1, min: 0, max: 1, step: 0.01,
      help: `How much ${label.toLowerCase()} reaches the MIX output. It does not touch the ${label.toLowerCase()}'s own output, which is always at full level. Its CV inlet is UNIPOLAR and MULTIPLIES this, so an envelope there fades the waveform into the mix rather than adding to it.`,
    },
  ];
}

export const VCV_XCO_SPEC = {
  derivation: derivedFrom(["src/XCO.cpp", "src/XCO.hpp", "src/dsp/oscillator.cpp", "src/dsp/table.cpp", "src/dsp/math.cpp", "src/dsp/filters/resample.cpp"], "XcoKernel", [...BLOCK_WIDE_DEVIATIONS, "D10", "D11", "D-ACTIVE", "D-XCOPHASE", "D13"]),
  type: "audio_vcv_xco", module: "vcvXco", title: "VCV Bogaudio XCO", family: "source",
  icon: "mdi:waveform", readout: "frequency", w: 400,
  help: "Bogaudio's full-size oscillator, and NOT the VCO with more knobs: four waveforms off one phase accumulator, each with its OWN phase offset, its own modifier and its own mix level, plus a mix bus that normalises itself once per cycle. The modifiers are the reason to reach for it — the saw runs through a tanh saturator, the triangle's phase can be quantised into a stepped ramp, and the SINE CAN PHASE-MODULATE ITSELF, which is one-operator FM and is why its output can sound like a saw. Anti-aliased twice over, as the VCO is: minBLEP at every discontinuity plus 8× oversampling with a CIC decimator.",
  inputs: [
    { key: "fm", type: "audio", label: "fm" },
    { key: "fm_depth_cv", type: "audio", label: "fm cv" },
    { key: "square_pw_cv", type: "audio", label: "sq pw" },
    { key: "square_phase_cv", type: "audio", label: "sq φ" },
    { key: "square_mix_cv", type: "audio", label: "sq mix" },
    { key: "saw_saturation_cv", type: "audio", label: "sw sat" },
    { key: "saw_phase_cv", type: "audio", label: "sw φ" },
    { key: "saw_mix_cv", type: "audio", label: "sw mix" },
    { key: "triangle_sample_cv", type: "audio", label: "tr smp" },
    { key: "triangle_phase_cv", type: "audio", label: "tr φ" },
    { key: "triangle_mix_cv", type: "audio", label: "tr mix" },
    { key: "sine_feedback_cv", type: "audio", label: "sn fb" },
    { key: "sine_phase_cv", type: "audio", label: "sn φ" },
    { key: "sine_mix_cv", type: "audio", label: "sn mix" },
    { key: "pitch", type: "audio", label: "pitch" },
    { key: "sync", type: "audio", label: "sync" },
  ],
  outputs: [
    { key: "square", type: "audio", label: "sqr" },
    { key: "saw", type: "audio", label: "saw" },
    { key: "triangle", type: "audio", label: "tri" },
    { key: "sine", type: "audio", label: "sin" },
    { key: "mix", type: "audio", label: "mix" },
  ],
  knobs: [
    {
      key: "frequency", label: "Frequency", default: 0, min: -36, max: 72, step: 0.1, unit: " st", hz: bogaudioSemitonesToHz,
      help: "Pitch in SEMITONES FROM C4 (R7-UNITS clause 3), so 0 is 261.626 Hz and 12 is an octave up. Rack's own knob is the same span in volts (−3…+6 V); these numbers are twelve times theirs and mean the same pitch. The `pitch` inlet also carries semitones and ADDS, clamped to their ±60.",
    },
    {
      key: "fine", label: "Fine", default: 0, min: -1, max: 1, step: 0.01, unit: " st",
      help: "Fine tune, ±1 semitone, summing with Frequency in the same unit. Two XCOs a few hundredths apart beat at a rate you can hear rather than at one you can count.",
    },
    {
      key: "fmDepth", label: "FM depth", default: 0, min: 0, max: 1, step: 0.01,
      help: "How much the `fm` inlet moves the pitch. It is SLEWED over 5 ms, so sweeping it does not zipper, and BELOW 0.01 THE FM PATH IS SKIPPED ENTIRELY — theirs, so zero depth costs nothing. Its own CV inlet is unipolar and multiplies it.",
    },
    ...xcoWaveKnobs("square", "Square", { suffix: "Pw", label: "width", default: 0, min: -0.97, max: 0.97 },
      "The square's duty cycle: 0 is 50% and ±0.97 approaches their 3%/97% limits. LATCHED once per cycle, because moving an edge mid-cycle would displace that edge's anti-aliasing correction from the edge it corrects. Its CV inlet is BIPOLAR and multiplies the knob."),
    ...xcoWaveKnobs("saw", "Saw", { suffix: "Saturation", label: "saturation", default: 0, min: 0, max: 1 },
      "Runs the ramp through a tanh curve BEFORE the band-limiting correction is subtracted, which rounds its shoulders and compresses it — a saw that has been through a transformer rather than one that has been filtered. It engages only above a tenth of the way up, and below 1.0 it is level-compensated, so the top of the knob genuinely loses level."),
    ...xcoWaveKnobs("triangle", "Triangle", { suffix: "Sample", label: "sampling", default: 0, min: 0, max: 1 },
      "Quantises the triangle's PHASE onto a grid, turning it into a staircase that still traces a triangle. Any amount above zero FORCES OVERSAMPLING ON for this waveform, because a stepped wave is discontinuous and would otherwise alias badly. At the top the triangle becomes a four-step ramp, which is a chiptune sound rather than a triangle."),
    ...xcoWaveKnobs("sine", "Sine", { suffix: "Feedback", label: "feedback", default: 0, min: 0, max: 1 },
      "Offsets the sine's phase by ITS OWN PREVIOUS OUTPUT — one-operator phase modulation, so the sine grows harmonics and eventually sounds like a saw. Engaging it fades the sine's own 8× oversampling in over 100 samples, because a self-modulated sine aliases the way a square does."),
    {
      key: "slow", label: "Slow", default: "off", discrete: true, options: ON_OFF,
      help: "Drops the frequency by SEVEN OCTAVES, putting the range at roughly 0.02…50 Hz. That turns the whole module into a four-output LFO with phase offsets and a mix bus, which is worth more than it sounds: most LFOs alias when you sweep them and this one does not.",
    },
    {
      key: "fmMode", label: "FM mode", default: "exponential", discrete: true, options: ["linear", "exponential"],
      help: "`linear` is THROUGH-ZERO PHASE modulation — the FM signal offsets the phase by `2·fm` radians, so the oscillator can run backwards and the timbre stays in tune as depth rises. `exponential` shifts the PITCH, which detunes as depth rises and is what a vibrato patch wants.",
    },
    {
      key: "dcCorrection", label: "DC correction", default: "on", discrete: true, options: ON_OFF,
      help: "SQUARE ONLY: removes the DC offset a non-50% duty cycle introduces. On by default. Off is not a bug — a narrow pulse with its DC intact pushes a step into whatever it feeds, which is a legitimate way to bias a filter.",
    },
    {
      key: "clipping", label: "Mix clipping", default: "comp", discrete: true, options: ["comp", "soft", "hard", "none"],
      help: "MIX OUTPUT ONLY. `comp` is theirs and is a ONE-CYCLE AGC: the mix is divided by the previous cycle's peak-to-peak span over ten volts, but only when that would attenuate — which is why four waveforms at full mix come out at roughly the level of one, and why the mix jumps level for a single cycle after a big knob move. `soft` is the shared saturator, `hard` a ±12 V clamp, `none` lets it run hot.",
    },
  ],
};

export const VCV_LVCO_SPEC = {
  derivation: derivedFrom(["src/LVCO.cpp", "src/vco_base.cpp", "src/dsp/oscillator.cpp"], "LvcoKernel", [...BLOCK_WIDE_DEVIATIONS, "D10", "D11", "D-ACTIVE"]),
  type: "audio_vcv_lvco", module: "vcvLvco", title: "VCV Bogaudio LVCO", family: "source",
  icon: "mdi:sine-wave", readout: "frequency", w: 160,
  help: "The 3 HP oscillator: one waveform at a time, chosen by a knob, and THE SAME ENGINE as the full-size VCO — the same minBLEP corrections, the same 8× oversampling, the same sync detector. Six waveforms, of which the last three are one band-limited square at three duty cycles. Reach for it when a patch needs its fourth or fifth voice and the panel is full; nothing about the sound is smaller.",
  inputs: [
    { key: "pitch", type: "audio", label: "pitch" },
    { key: "fm", type: "audio", label: "fm" },
    { key: "sync", type: "audio", label: "sync" },
  ],
  outputs: [{ key: "out", type: "audio", label: "out" }],
  knobs: [
    {
      key: "frequency", label: "Frequency", default: 0, min: -36, max: 72, step: 0.1, unit: " st", hz: bogaudioSemitonesToHz,
      help: "Pitch in SEMITONES FROM C4 (R7-UNITS clause 3), so 0 is 261.626 Hz. The `pitch` inlet carries semitones too and ADDS, clamped to their ±60 — five octaves either way.",
    },
    {
      key: "fmDepth", label: "FM depth", default: 0, min: 0, max: 1, step: 0.01,
      help: "How much the `fm` inlet moves the pitch. Below 0.01 the FM path is skipped entirely, so a depth of zero costs nothing.",
    },
    {
      key: "wave", label: "Waveform", default: "sine", discrete: true,
      options: ["sine", "triangle", "saw", "square", "pulse_25", "pulse_10"],
      help: "Which single waveform the output carries. The last three are ONE band-limited square at 50%, 25% and 10% duty — narrower pulses are brighter and thinner, and the 10% one is the classic reedy lead. Unlike the full VCO, only the selected waveform is computed, which is their own behaviour and makes this the cheap oscillator as well as the small one.",
    },
    {
      key: "slow", label: "Slow", default: "off", discrete: true, options: ON_OFF,
      help: "Drops the frequency by SEVEN OCTAVES — roughly 0.02…50 Hz — turning it into a band-limited LFO with a sync input.",
    },
    {
      key: "fmMode", label: "FM mode", default: "exponential", discrete: true, options: ["linear", "exponential"],
      help: "`linear` is through-zero PHASE modulation, which stays in tune as depth rises; `exponential` shifts the pitch, which does not. The first is for FM timbres, the second for vibrato.",
    },
    {
      key: "tuning", label: "Tuning", default: "voct", discrete: true, options: ["voct", "hertz"],
      help: "`voct` is volts-per-octave, what everything else speaks. `hertz` makes the Frequency knob LINEAR in frequency (1 V = 1000 Hz, or 1 Hz in Slow mode), which is how you tune one oscillator to a fixed beat rate against another.",
    },
    {
      key: "dcCorrection", label: "DC correction", default: "on", discrete: true, options: ON_OFF,
      help: "SQUARE AND PULSE ONLY: removes the DC offset a non-50% duty cycle introduces. It matters more here than on the VCO, because two of the six waveforms are narrow pulses.",
    },
  ],
};

/** The twelve note names, in the order `Reftone`'s PITCH_PARAM counts them —
 *  0 = C through 11 = B, which is their `referencePitch` of 0 meaning C. Sharps
 *  rather than flats because their own panel display uses sharps. */
export const BOGAUDIO_NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

export const VCV_REFTONE_SPEC = {
  derivation: derivedFrom(["src/Reftone.cpp", "src/Reftone.hpp", "src/dsp/oscillator.cpp", "src/dsp/pitch.hpp"], "ReftoneKernel", [...BLOCK_WIDE_DEVIATIONS]),
  type: "audio_vcv_reftone", module: "vcvReftone", title: "VCV Bogaudio Reftone", family: "source",
  icon: "mdi:tuning-fork", readout: "pitch", w: 165,
  help: "A TUNING REFERENCE: pick a note, an octave and a cents trim, and get both a pitch CV and a sine at exactly that frequency. Its defaults are A4 = 440 Hz. The sine is a double-precision quadrature recurrence rather than a table read — every other sine in this library is a 4096-entry table, and a reference tone is the one signal you tune something else AGAINST, so a table's interpolation ripple would put beats exactly where the point is that there are none.",
  inputs: [],
  outputs: [
    { key: "cv", type: "audio", label: "cv" },
    { key: "out", type: "audio", label: "out" },
  ],
  knobs: [
    {
      key: "pitch", label: "Pitch", default: "A", discrete: true, options: BOGAUDIO_NOTE_NAMES,
      help: "The note within the octave. A NAME rather than a number, because that is what their panel displays and because \"9\" is not something an author can reason about — the house rule this block's header states. Their default is A, which with the default octave gives 440 Hz.",
    },
    {
      key: "octave", label: "Octave", default: 4, min: 1, max: 8, step: 1,
      help: "Which octave, in scientific pitch notation — 4 is the one containing middle C. Also rounded. Octave 1 puts the reference at about 27 Hz and octave 8 at about 7 kHz.",
    },
    {
      key: "fine", label: "Fine", default: 0, min: -0.99, max: 0.99, step: 0.01, unit: " st",
      help: "Up to ±99 cents, and the ONLY control here that is not rounded — which is the point. It is how you set A = 432 Hz, or match an instrument that is a little flat, without leaving the note you named.",
    },
  ],
};

export const VCV_BOG_NOISE_SPEC = {
  derivation: derivedFrom(["src/Noise.cpp", "src/Noise.hpp", "src/dsp/noise.hpp"], "NoiseKernel", [...BLOCK_WIDE_DEVIATIONS, "D2", "D14", "D-ACTIVE"]),
  type: "audio_vcv_bog_noise", module: "vcvBogNoise", title: "VCV Bogaudio Noise", family: "source",
  icon: "mdi:blur", readout: "seed", w: 165,
  help: "FIVE COLOURS OF NOISE FROM FIVE INDEPENDENT GENERATORS, plus a rectifier. They are UNCORRELATED, which is the part that matters: white is uniform, pink is the Voss-McCartney tree over white, red is that tree applied to ITSELF, blue is pink's first difference, and gauss is a normal distribution. Mix white and pink and you get a wider spectrum than either; a module that filtered one source would give you a correlated pair and a comb.",
  inputs: [{ key: "abs", type: "audio", label: "abs in" }],
  outputs: [
    { key: "white", type: "audio", label: "white" },
    { key: "pink", type: "audio", label: "pink" },
    { key: "red", type: "audio", label: "red" },
    { key: "gauss", type: "audio", label: "gauss" },
    { key: "abs", type: "audio", label: "abs" },
    { key: "blue", type: "audio", label: "blue" },
  ],
  knobs: [
    {
      ...SEED,
      help: `${SEED.help} All five generators are seeded from this one number, spaced far apart so that white and gauss do not read the same stream. The ABS output is not a generator and is unaffected.`,
    },
  ],
};

// ── MODULATION AND UTILITY ──────────────────────────────────────────────────

/** LLFO's frequency knob in HERTZ (D13). Their −5…8 V knob sits SEVEN octaves
 *  below a VCO's, so the span is C4 · 2^(−12 … +1). Written through this file's
 *  own converter so the roster's `bogSemitonesToHz` calls and these produce the
 *  identical double — tests/port_vc3b_test.js pins them equal. */
const LLFO_MIN_HZ = bogaudioSemitonesToHz(-144);
const LLFO_MAX_HZ = bogaudioSemitonesToHz(12);
const LLFO_DEFAULT_HZ = bogaudioSemitonesToHz(-84);

export const VCV_LLFO_SPEC = {
  derivation: derivedFrom(["src/LLFO.cpp", "src/LLFO.hpp", "src/lfo_base.cpp", "src/dsp/oscillator.cpp"], "LlfoKernel", [...BLOCK_WIDE_DEVIATIONS, "D2", "D13", "D-OFFSETSCALE", "D-STEPPEDPHASE"]),
  type: "audio_vcv_llfo", module: "vcvLlfo", title: "VCV Bogaudio LLFO", family: "modulation",
  icon: "mdi:sine-wave", readout: "frequency", w: 175,
  help: "The 3 HP LFO a big patch has six of: seven waveforms, a reset input, and two controls that are not the waveform at all. SAMPLING holds the output for a fraction of a quarter-cycle, so a sine becomes a staircase that still traces a sine; SMOOTHING is a shaped slew whose time is a fraction of the PERIOD, so it tracks the rate instead of fighting it. Together they turn one LFO into a stepped sequencer and a lag generator. The Stepped waveform is a seeded random SEQUENCE — the same seed always gives the same tune.",
  inputs: [
    { key: "pitch", type: "audio", label: "pitch" },
    { key: "reset", type: "audio", label: "reset" },
  ],
  outputs: [{ key: "out", type: "audio", label: "out" }],
  knobs: [
    {
      key: "frequency", label: "Rate", default: LLFO_DEFAULT_HZ, min: LLFO_MIN_HZ, max: LLFO_MAX_HZ, step: 0.001, unit: " Hz",
      help: "The rate in HERTZ (R7-UNITS clause 2), spanning about 0.064 Hz — a cycle every sixteen seconds — up to 523 Hz, which is audio rate and is deliberate. The `pitch` inlet carries SEMITONES and is an INTERVAL on this, so ±12 there doubles or halves the rate exactly.",
    },
    {
      key: "wave", label: "Waveform", default: "sine", discrete: true,
      options: ["sine", "triangle", "ramp_up", "ramp_down", "square", "pulse", "stepped"],
      help: "`ramp_up` and `ramp_down` are one saw and its negation. `square` is a fixed 50% and `pulse` uses the Pulse width knob. `stepped` is a random SEQUENCE read from a seeded 4096-entry table by cycle number — not random per sample, so it is a tune rather than noise, and the same seed replays it. Sampling does nothing to the last three, which are already piecewise constant.",
    },
    {
      key: "slow", label: "Slow", default: "off", discrete: true, options: ON_OFF,
      help: "Divides the rate by SIXTEEN — their two pitch offsets are four octaves apart. It is a range shift, not a separate mode: a rate of 2 Hz becomes 0.125 Hz and everything else behaves identically.",
    },
    {
      key: "offset", label: "Offset", default: 0, min: -10, max: 10, step: 0.1, unit: " V",
      help: "A DC added AFTER Scale, in VOLTS (on our wires 5 V is 1.0). Their panel has a range switch that makes the same knob position mean ±5 V or ±10 V; here the knob says volts directly, so the switch would be a second way to state a number the knob already states, and the full ±10 V is simply available. Offset 5 V with Scale 1 gives a 0…10 V unipolar LFO.",
    },
    {
      key: "scale", label: "Scale", default: 1, min: 0, max: 1, step: 0.01,
      help: "How far the waveform swings before Offset is added — 1 is their full ±5 V. At 0 the output is the Offset alone, which is a legitimate way to park an LFO at a constant.",
    },
    {
      key: "pulseWidth", label: "Pulse width", default: -0.8510638, min: -1, max: 1, step: 0.01,
      help: "PULSE WAVEFORM ONLY: 0 is 50% and ±1 reaches the 3%/97% limits. Their default of −0.851064 is exactly a 10% pulse, which is why the number looks arbitrary and is not — it is the inverse of the `pw·0.94·0.5 + 0.5` mapping every Bogaudio oscillator shares.",
    },
    {
      key: "sampling", label: "Sampling", default: 0, min: 0, max: 1, step: 0.01,
      help: "Holds the output for N samples, where N is this fraction of a QUARTER CYCLE — so the number of steps per cycle stays constant as the rate changes. Zero is smooth. At the top a sine becomes a four-step staircase, which is a stepped sequence you can still hear the shape of. Does nothing to the square, pulse and stepped waveforms.",
    },
    {
      key: "smoothing", label: "Smoothing", default: 0, min: 0, max: 1, step: 0.01,
      help: "A shaped slew whose time is a fraction of the PERIOD rather than a fixed number of milliseconds, so it tracks the rate: the same setting rounds a slow square and a fast one by the same proportion of a cycle. Put it after Sampling and a staircase becomes a smooth wandering line.",
    },
    { ...SEED, help: `${SEED.help} It seeds the STEPPED waveform's 4096-entry table, and nothing else here — the other six waveforms are deterministic already.` },
  ],
};

export const VCV_WALK2_SPEC = {
  derivation: derivedFrom(["src/Walk2.cpp", "src/Walk2.hpp", "src/dsp/noise.cpp"], "Walk2Kernel", [...BLOCK_WIDE_DEVIATIONS, "D2"]),
  type: "audio_vcv_walk2", module: "vcvWalk2", title: "VCV Bogaudio Walk2", family: "modulation",
  icon: "mdi:vector-polyline", readout: "rateX", w: 190,
  help: "TWO random walkers and the distance between them — and it is not two Walks in a box. Each axis's Rate knob also sets that axis's OUTPUT SMOOTHING, at `(1 − rate)·100 ms`, where a single Walk's is a fixed 100 ms. So X and Y at different rates have different TEXTURES and not merely different speeds, which is what makes the pair read as a hand moving rather than as two knobs turning. The DISTANCE output is the third reason to use it: a unipolar signal that rises whenever the pair wanders away from the origin, correlated with both without being either.",
  inputs: [
    { key: "offset_x_cv", type: "audio", label: "off x" },
    { key: "scale_x_cv", type: "audio", label: "scl x" },
    { key: "rate_x_cv", type: "audio", label: "rate x" },
    { key: "offset_y_cv", type: "audio", label: "off y" },
    { key: "scale_y_cv", type: "audio", label: "scl y" },
    { key: "rate_y_cv", type: "audio", label: "rate y" },
    { key: "jump", type: "audio", label: "jump" },
  ],
  outputs: [
    { key: "out_x", type: "audio", label: "x" },
    { key: "out_y", type: "audio", label: "y" },
    { key: "distance", type: "audio", label: "dist" },
  ],
  knobs: [
    {
      key: "rateX", label: "Rate X", default: 0.1, min: 0, max: 1, step: 0.01,
      help: "How fast the X walk moves, raised to the FIFTH POWER — so the bottom nine-tenths of the knob is a very slow drift and the top tenth opens right up. It moves THREE things at once: the integrator's memory, the smoothing filter's cutoff, and this version's output slew. That triple coupling is the module's character.",
    },
    {
      key: "offsetX", label: "Offset X", default: 0, min: -1, max: 1, step: 0.01,
      help: "Where the X walk is centred, ±5 V. Applied AFTER Scale, so it survives being scaled to nothing — Scale 0 with an Offset set is a constant, which is how you park one axis and use the other.",
    },
    {
      key: "scaleX", label: "Scale X", default: 1, min: 0, max: 1, step: 0.01,
      help: "How far the X walk swings, before Offset. At 1 it uses the full ±5 V it reflects within, so its distribution piles up at the extremes rather than being gaussian — a walker that bounces off walls.",
    },
    { key: "rateY", label: "Rate Y", default: 0.1, min: 0, max: 1, step: 0.01, help: "The Y walk's rate, independently, with the same fifth-power curve and the same triple coupling. Setting X and Y a little apart is what makes the trace look drawn rather than plotted." },
    { key: "offsetY", label: "Offset Y", default: 0, min: -1, max: 1, step: 0.01, help: "Where the Y walk is centred, ±5 V, applied after Scale Y." },
    { key: "scaleY", label: "Scale Y", default: 1, min: 0, max: 1, step: 0.01, help: "How far the Y walk swings, before Offset Y." },
    {
      key: "jumpMode", label: "Jump input", default: "jump", discrete: true,
      options: ["jump", "track_and_hold", "sample_and_hold"],
      help: "What the `jump` inlet does to BOTH axes at once — a GATE port carrying 0…1 logic (R7-UNITS clause 4). `jump` teleports the pair somewhere new. `track_and_hold` freezes them while the gate is LOW. `sample_and_hold` freezes them between rising edges, turning a continuous wander into a stepped one that still wanders.",
    },
    { ...SEED, help: `${SEED.help} The two axes take DIFFERENT seeds derived from this one — one seed for both would make X and Y identical, which is a diagonal line rather than a walk.` },
  ],
};

export const VCV_SUMS_SPEC = {
  derivation: derivedFrom(["src/Sums.cpp", "src/Sums.hpp"], "SumsKernel", [...BLOCK_WIDE_DEVIATIONS]),
  type: "audio_vcv_sums", module: "vcvSums", title: "VCV Bogaudio Sums", family: "modulation",
  icon: "mdi:plus-minus-variant", readout: "outputLimit", w: 150,
  help: "a+b, a−b, max(a,b), min(a,b) and −c, all at once. Sum and difference are a mixer and an inverter; MAX AND MIN ARE THE INTERESTING HALF — they are logic on analogue values. Max of two envelopes is their union, min is their overlap, and min against a constant is a hard ceiling with no knee. That is what their own subtitle \"arithmetic logic\" means, and it is why this 3 HP module keeps appearing in patches that already have a mixer.",
  inputs: [
    { key: "a", type: "audio", label: "a" },
    { key: "b", type: "audio", label: "b" },
    { key: "negate", type: "audio", label: "neg in" },
  ],
  outputs: [
    { key: "sum", type: "audio", label: "a+b" },
    { key: "difference", type: "audio", label: "a−b" },
    { key: "max", type: "audio", label: "max" },
    { key: "min", type: "audio", label: "min" },
    { key: "negate", type: "audio", label: "−c" },
  ],
  knobs: [{ ...OUTPUT_LIMIT }],
};

export const VCV_SLEW_SPEC = {
  derivation: derivedFrom(["src/Slew.cpp", "src/Slew.hpp", "src/slew_common.cpp", "src/dsp/signal.cpp"], "SlewKernel", [...BLOCK_WIDE_DEVIATIONS, "D13", "D-ACTIVE"]),
  type: "audio_vcv_slew", module: "vcvSlew", title: "VCV Bogaudio Slew", family: "modulation",
  icon: "mdi:transit-connection-horizontal", readout: "rise", w: 175,
  help: "A slew limiter with a SHAPE on each direction, which is the difference between a glide and an envelope follower. The rise and fall times are independent, and each has an exponent knob that makes its segment logarithmic, linear or exponential. Feed it a stepped sequence and it is portamento; feed it a rectified audio signal and it is an envelope follower with an attack and a release; feed it a square and it is an AD envelope generator with no envelope module in the patch.",
  inputs: [
    { key: "rise_cv", type: "audio", label: "rise cv" },
    { key: "fall_cv", type: "audio", label: "fall cv" },
    { key: "in", type: "audio", label: "in" },
  ],
  outputs: [{ key: "out", type: "audio", label: "out" }],
  knobs: [
    {
      key: "rise", label: "Rise", default: 1, min: 0, max: 10, step: 0.01, unit: " s",
      help: "How long a RISE takes — and it is seconds PER TEN VOLTS, not seconds to reach the target, so a 1 V step at this default moves in 100 ms while a 10 V step takes a full second. That is a real slew limiter's slope spec, and it is why one setting glides a small interval quickly and a large one slowly. Their default is exactly 1 s. The `rise cv` inlet MULTIPLIES this by 0…1 from 0…10 V.",
    },
    {
      key: "riseShape", label: "Rise shape", default: 0, min: -1, max: 1, step: 0.01,
      help: "The rise segment's curve: 0 is a straight line, negative is fast-then-slow (logarithmic, like a capacitor charging), positive is slow-then-fast. THE TWO HALVES ARE NOT SYMMETRIC — theirs — the full anticlockwise travel is a 10× exponent and the full clockwise travel only a 2× one, so the logarithmic side has far more range.",
    },
    { key: "fall", label: "Fall", default: 1, min: 0, max: 10, step: 0.01, unit: " s", help: "How long a FALL takes, in the same seconds-per-ten-volts. Independent of Rise, which is the whole point: a fast rise and a slow fall is an envelope follower, the reverse is a reverse-envelope. Its own CV inlet multiplies it." },
    { key: "fallShape", label: "Fall shape", default: 0, min: -1, max: 1, step: 0.01, help: "The fall segment's curve, with the same asymmetric mapping as Rise shape. A logarithmic fall is what a natural decay sounds like." },
    {
      key: "slow", label: "Slow", default: "off", discrete: true, options: ON_OFF,
      help: "Multiplies BOTH times by ten, so the range becomes 0…100 seconds per ten volts. That is slow enough to be a drift generator rather than a glide.",
    },
  ],
};

export const VCV_POLYCON8_SPEC = {
  derivation: derivedFrom(["src/PolyCon8.cpp", "src/PolyCon8.hpp", "src/output_range.hpp"], "PolyCon8Kernel", [...BLOCK_WIDE_DEVIATIONS, "D13", "D16"]),
  type: "audio_vcv_polycon8", module: "vcvPolycon8", title: "VCV Bogaudio PolyCon8", family: "modulation",
  icon: "mdi:numeric", readout: "channel1", w: 165,
  help: "EIGHT CONSTANT VOLTAGES. In Rack this is one polyphonic cable carrying eight different numbers — a per-voice detune, a per-voice pan, a chord written down. Our wires are mono, so it is eight outputs instead of one cable: the same information with the bundling removed. Unglamorous and constantly useful, because a constant you can name and keyframe is worth more than a constant buried in a knob somewhere else.",
  inputs: [],
  outputs: Array.from({ length: 8 }, (unused, i) => ({ key: `out${i + 1}`, type: "audio", label: `${i + 1}` })),
  knobs: Array.from({ length: 8 }, (unused, i) => ({
    key: `channel${i + 1}`, label: `Channel ${i + 1}`, default: 0, min: -10, max: 10, step: 0.01, unit: " V",
    help: `Channel ${i + 1}'s constant, in VOLTS — on our wires 5 V is 1.0, so ±10 V is ±2.0. Their panel states the same number and their default range is the same ±10 V. Like every value here it may be an equation, which is what makes eight constants more useful than eight numbers: bind one to \`time\` and it stops being constant.`,
  })),
};

// ── THE MATRIX FAMILY — THREE PANELS OVER ONE ENGINE ────────────────────────

/**
 * Pure function. One matrix node's crosspoint knob rows plus its input-gain trim.
 * GENERATED, because Switch88 and Matrix88 have sixty-four cells each and a
 * hand-typed list of 64 is a list with a transposed pair in it.
 *
 * `step` is the ONE thing that differs between Bogaudio's knob matrix and their
 * switch matrix: the param's range is identical (`configSwitchParam` is
 * `configParam(-1, 1, 0)`), and only the widget differs — a continuous knob versus
 * a three-position switch. A step of 1 IS that switch.
 *
 * @param {number} ins - how many inputs
 * @param {number} outs - how many outputs
 * @param {number} step - 1 for a three-position switch, finer for a knob
 * @returns {object[]} ins·outs + 1 knob declarations, in Bogaudio's own
 *          column-major param order
 *
 * @example matrixKnobs(1, 3, 1).length // 4
 * @example matrixKnobs(1, 3, 1)[0].key // "mix1"
 * @example matrixKnobs(2, 2, 0.01)[1].key // "mix21"
 * @example matrixKnobs(2, 2, 0.01)[4].key // "inputGain"
 */
export function matrixKnobs(ins, outs, step) {
  const cells = [];
  for (let o = 1; o <= outs; o++) {
    for (let i = 1; i <= ins; i++) {
      const key = ins === 1 ? `mix${o}` : `mix${i}${o}`;
      const route = ins === 1 ? `output ${o}` : `input ${i} to output ${o}`;
      cells.push({
        key, label: ins === 1 ? `Route ${o}` : `In ${i} → out ${o}`, default: 0, min: -1, max: 1, step,
        help: `How much of ${route} passes. 0 is off, 1 is unity, and NEGATIVE INVERTS — which is the third position their switch has and the reason the range is bipolar rather than 0…1. Every cell is slewed over 0.5 ms, so flipping it is a fade and not a click.`,
      });
    }
  }
  return [...cells, {
    key: "inputGain", label: "Input gain", default: 0, min: -60, max: 6, step: 0.1, unit: " dB",
    help: "A trim applied to EVERY input before the matrix, −60…+6 dB. Their own menu offers four fixed values (unity, −3, −6, −12 dB) for one reason: summing eight sources at unity clips, and backing them all off by the same amount is the fix that does not change the balance.",
  }];
}

/** The two rows every matrix node shares beyond its crosspoints — stated once so
 *  three nodes cannot spell the same two controls three ways. */
const MATRIX_CLIPPING = {
  key: "clipping", label: "Clipping", default: "soft", discrete: true, options: ["soft", "hard", "none"],
  help: "What happens at the ceiling. `soft` is the shared saturator and is their default (better for audio); `hard` is a ±12 V clamp (better for CV, because a saturated control voltage is a wrong control voltage); `none` lets the sum run as hot as it likes, which is fine when the next thing along saturates properly.",
};

const MATRIX_MIX_MODE = {
  key: "mixMode", label: "Mix mode", default: "sum", discrete: true, options: ["sum", "average"],
  help: "`sum` adds the routed inputs. `average` divides by the number of CONNECTED inputs — note connected, not routed, so patching a ninth cable quietly changes the level of the other eight. That is their behaviour and it is what makes average safe against clipping and unsafe against surprises.",
};

export const VCV_SWITCH18_SPEC = {
  derivation: derivedFrom(["src/Switch18.cpp", "src/Switch18.hpp", "src/matrix_base.cpp"], "MatrixKernel", [...BLOCK_WIDE_DEVIATIONS, "D15", "D16", "D-ACTIVE"]),
  type: "audio_vcv_switch18", module: "vcvSwitch18", title: "VCV Bogaudio Switch18", family: "modulation",
  icon: "mdi:call-split", readout: "mix1", w: 175,
  help: "ONE INPUT TO EIGHT OUTPUTS, each with its own three-position route switch: off, through, or INVERTED. It is a 1×8 slice of the same matrix engine Switch88 and Matrix88 run, so every route is slewed over half a millisecond and a flip is a fade rather than a click. More than one route may be on at once, which makes it a splitter as well as a switch — and with a couple inverted, one signal becomes a set that cancels.",
  inputs: [{ key: "in", type: "audio", label: "in" }],
  outputs: Array.from({ length: 8 }, (unused, i) => ({ key: `out${i + 1}`, type: "audio", label: `${i + 1}` })),
  knobs: [...matrixKnobs(1, 8, 1), { ...MATRIX_CLIPPING }, { ...MATRIX_MIX_MODE }],
};

export const VCV_SWITCH88_SPEC = {
  derivation: derivedFrom(["src/Switch88.cpp", "src/Switch88.hpp", "src/matrix_base.cpp"], "MatrixKernel", [...BLOCK_WIDE_DEVIATIONS, "D15", "D16", "D-ACTIVE"]),
  type: "audio_vcv_switch88", module: "vcvSwitch88", title: "VCV Bogaudio Switch88", family: "modulation",
  icon: "mdi:grid", readout: "mix11", w: 520,
  help: "AN 8×8 ROUTING MATRIX with a three-position switch at every crosspoint — off, through, inverted. Sixty-four switches is a patchbay you can keyframe: a slide that reroutes an entire mixer is one delta here. Same engine as Matrix88, and the only difference is the control: these snap to the three positions where Matrix88's are continuous.",
  inputs: Array.from({ length: 8 }, (unused, i) => ({ key: `in${i + 1}`, type: "audio", label: `in${i + 1}` })),
  outputs: Array.from({ length: 8 }, (unused, i) => ({ key: `out${i + 1}`, type: "audio", label: `out${i + 1}` })),
  knobs: [...matrixKnobs(8, 8, 1), { ...MATRIX_CLIPPING }, { ...MATRIX_MIX_MODE }],
};

export const VCV_MATRIX88_SPEC = {
  derivation: derivedFrom(["src/Matrix88.cpp", "src/Matrix88.hpp", "src/matrix_base.cpp"], "MatrixKernel", [...BLOCK_WIDE_DEVIATIONS, "D15", "D16", "D-ACTIVE"]),
  type: "audio_vcv_matrix88", module: "vcvMatrix88", title: "VCV Bogaudio Matrix88", family: "modulation",
  icon: "mdi:grid-large", readout: "inputGain", w: 520,
  help: "AN 8×8 MIXING MATRIX: sixty-four CONTINUOUS crosspoints, each a bipolar level from any input to any output. Switch88 is the same engine with the crosspoints snapped to off/through/inverted; this one is the version you automate. Eight sources into eight destinations at arbitrary levels is a whole mixing desk, and every one of those 64 numbers can be an equation.",
  inputs: Array.from({ length: 8 }, (unused, i) => ({ key: `in${i + 1}`, type: "audio", label: `in${i + 1}` })),
  outputs: Array.from({ length: 8 }, (unused, i) => ({ key: `out${i + 1}`, type: "audio", label: `out${i + 1}` })),
  knobs: [...matrixKnobs(8, 8, 0.01), { ...MATRIX_CLIPPING }, { ...MATRIX_MIX_MODE }],
};

export const VCV_ONEEIGHT_SPEC = {
  derivation: derivedFrom(["src/OneEight.cpp", "src/OneEight.hpp", "src/addressable_sequence.cpp"], "OneEightKernel", [...BLOCK_WIDE_DEVIATIONS, "D16", "D-ACTIVE"]),
  type: "audio_vcv_oneeight", module: "vcvOneeight", title: "VCV Bogaudio OneEight", family: "modulation",
  icon: "mdi:arrow-decision", readout: "steps", w: 190,
  help: "AN EIGHT-WAY SEQUENTIAL SWITCH, and with nothing patched to its input it becomes an eight-step GATE SEQUENCER — the selected output emits 10 V and the rest sit at zero. Step and Select are two addresses that ADD: the clock walks a loop of length Steps, and Select offsets that loop, so one CV transposes the whole pattern. A 1 ms debounce swallows any clock edge arriving within a millisecond of a reset, which is what stops a sequencer restarted by its own end-of-cycle from being permanently one step out.",
  inputs: [
    { key: "clock", type: "audio", label: "clock" },
    { key: "reset", type: "audio", label: "reset" },
    { key: "select_cv", type: "audio", label: "sel cv" },
    { key: "in", type: "audio", label: "in" },
  ],
  outputs: Array.from({ length: 8 }, (unused, i) => ({ key: `out${i + 1}`, type: "audio", label: `${i + 1}` })),
  knobs: [
    {
      key: "steps", label: "Steps", default: 8, min: 1, max: 8, step: 1,
      help: "How many outputs the clock cycles through before wrapping. The outputs above this count are still reachable by SELECT — the two addresses wrap differently unless you turn on `Wrap select at steps` — so a 3-step loop with a select of 5 walks outputs 6, 7 and 8.",
    },
    {
      key: "select", label: "Select", default: 0, min: 0, max: 7, step: 1,
      help: "An OFFSET added to the clock's step, 0…7. Its CV inlet ADDS on top, ±9.99 V mapped across all eight — their clamp is 9.99 and not 10 deliberately, so a full 10 V selects step 7 rather than wrapping to 8.",
    },
    {
      key: "direction", label: "Direction", default: "forward", discrete: true, options: ["forward", "reverse"],
      help: "Which way the clock walks the loop. A two-position switch on their panel, so it is a named choice here rather than a 0/1 number — \"reverse\" is a word, not a value.",
    },
    {
      key: "selectOnClock", label: "Select on clock", default: "off", discrete: true, options: ON_OFF,
      help: "Holds the Select address until the next CLOCK edge, instead of applying it the instant the CV moves. On, a select CV that drifts mid-step cannot glitch the output; off, it can be used as a live crossfade between patterns.",
    },
    {
      key: "triggeredSelect", label: "Triggered select", default: "off", discrete: true, options: ON_OFF,
      help: "Turns the SELECT inlet into a SECOND CLOCK: each rising edge advances the select address by one, wrapping at the Select knob's value. Two clocks at different rates then walk two independent counters that add, which is how you get long non-repeating patterns out of an eight-step switch.",
    },
    {
      key: "reverseOnNegativeClock", label: "Negative clock reverses", default: "off", discrete: true, options: ON_OFF,
      help: "A −1 V edge on the clock inlet steps BACKWARDS. With a bipolar clock source that makes one cable a bidirectional transport, and it is why the clock inlet is a level port rather than a plain gate.",
    },
    {
      key: "wrapSelectAtSteps", label: "Wrap select at steps", default: "off", discrete: true, options: ON_OFF,
      help: "Makes the combined address wrap at STEPS rather than at eight. Off (theirs) the select offset can walk outputs the clock never reaches; on, select and step stay inside the same short loop, which is what you want when Steps is a musical length.",
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
  VCV_BOG_VCO_SPEC, VCV_XCO_SPEC, VCV_LVCO_SPEC, VCV_REFTONE_SPEC, VCV_BOG_NOISE_SPEC,
  VCV_PEQ_SPEC, VCV_PEQ6_SPEC, VCV_BOG_VCF_SPEC,
  VCV_PRESSOR_SPEC,
  VCV_SAMPLEHOLD_SPEC, VCV_WALK_SPEC, VCV_WALK2_SPEC, VCV_LLFO_SPEC,
  VCV_BOG_VCA_SPEC, VCV_VCM_SPEC, VCV_XFADE_SPEC, VCV_OFFSET_SPEC, VCV_SWITCH_SPEC, VCV_STACK_SPEC,
  VCV_SUMS_SPEC, VCV_SLEW_SPEC, VCV_POLYCON8_SPEC,
  VCV_ONEEIGHT_SPEC, VCV_SWITCH18_SPEC, VCV_SWITCH88_SPEC, VCV_MATRIX88_SPEC,
];
