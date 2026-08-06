/**
 * VC-3a — THE BOGAUDIO KERNELS (part 1 of 2), PORTED FROM C++ TO OUR FLOAT WIRES.
 *
 * ── WHAT THIS FILE IS ───────────────────────────────────────────────────────
 * Nine Bogaudio module's DSP and nothing else. No AudioNodes, no AudioWorklet, no
 * DOM: a plain ES module, so `tests/port_vc3a_test.js` runs every recurrence in
 * BARE NODE against a line-by-line transcription of the C++. That separation is
 * the point — the arithmetic IS the deliverable, so it must be reachable without
 * a browser.
 *
 * `worklets/processors_vc3a.js` wraps each kernel in an AudioWorkletProcessor;
 * `modules_vc3a.js` wires those into engine modules.
 *
 * ── THE DERIVATION RECORD (R7-17) ───────────────────────────────────────────
 * Source, cloned READ-ONLY and read at this commit on 2026-08-06:
 *
 *   bogaudio/BogaudioModules @ 656eaae458e045602dc974bae82e15a11e104958
 *
 * Rack's own headers, for the two primitives Bogaudio inherits rather than
 * writes (`dsp::SchmittTrigger`, `dsp::PulseGenerator`):
 *
 *   VCVRack/Rack (include/dsp/digital.hpp), same clone set
 *
 * Every kernel's docblock names its C++ FILE AND FUNCTION — Bogaudio splits a
 * module across `<Module>.cpp` (parameter plumbing) and `dsp/*` (the recurrence),
 * so both are cited. Deviations are numbered D1… below and referenced by number.
 *
 * ── THE UNIT LAW: ONE UNIT IS FIVE VOLTS, ON EVERY WIRE, WITH NO EXCEPTIONS ──
 * This is the block's single scaling decision and it is stated once, here.
 *
 * Rack cables carry ±5 V nominal and ±10 V maximum. Our wires carry ±1 nominal.
 * So `VOLTS_PER_UNIT = 5`: a kernel MULTIPLIES by it the instant a wire value
 * enters, does all of Bogaudio's arithmetic in VOLTS exactly as written, and
 * DIVIDES by it on the way out. Consequences, all of them deliberate:
 *
 *   · FMOp's `static constexpr float amplitude = 5.0f` output lands at exactly
 *     ±1.0 full scale. A patch of these into our Output node needs no trim.
 *   · Rack's ±10 V maximum is ±2.0 here — HEADROOM, not clipping. Float audio
 *     has no ceiling until the DAC, and the modules that clamp (LFO's ±12 V,
 *     Saturator's 12 V limit) still clamp at their own voltages.
 *   · A GATE is a wire like any other: Bogaudio's Schmitt thresholds of 1 V /
 *     0.1 V are 0.2 / 0.02 units (`GATE_HIGH_UNITS` / `GATE_LOW_UNITS`), so a
 *     PowerRP `trigger` port emitting 1.0 is comfortably high.
 *
 * ── THE ONE EXCEPTION, AND IT IS A RULING: A PITCH PORT CARRIES SEMITONES ────
 * `claude_instructions.md` § **R7-UNITS** (lead, 2026-08-06): a V/oct port carries
 * `semitones = 12 × volts`, so `OCTAVES_PER_UNIT = 1/12` and 12 on the wire is one
 * octave. NOT volts ÷ 5, which is what this block shipped for one commit.
 *
 * **THIS FILE ARGUED FOR VOLTS AND THE ARGUMENT LOST ON COST, NOT ON BEING WRONG,
 * and the reasoning is recorded because the cost is still real.** Under a
 * volt-shaped law P5's `AddrSeq → Merge → Split → FMOp[Pitch]` needs no converter,
 * because AddrSeq's step output is a CV on the ÷5 law. Under this one it needs a
 * visible ×60 scaler, recorded as a deviation in that patch. What volts would have
 * bought — one law, no exception — costs a THIRD pitch convention in a codebase
 * that has two (house nodes in hertz, 34 Axoloti nodes in semitones-from-E4), and
 * it would have put those 34 plus VC-1 and VC-5 on the wrong side of it. A scaler
 * per patch is paid once, in the open; a third convention is paid forever, silently.
 *
 * **THE ORIGIN IS C4, NOT E4, AND THAT IS THE TRAP TO KNOW.** A VCV V/oct 0 V is
 * C4; Axoloti's semitone 0 is E4. So an AX pitch wire into one of these ports is
 * FOUR SEMITONES SHARP, and neither corpus is wrong — each keeps its own origin so
 * a harvested patch's numbers copy across unchanged. `REFERENCE_FREQUENCY` below is
 * this block's origin, and `core/audio_specs_vc3a.js`'s `bogaudioSemitonesToHz`
 * (restated there, pinned by the port test) is the display bridge R7-UNITS requires
 * — do NOT reuse `core/audio_nodes.semitonesToHz`, which is E4.
 *
 * TO TRANSCRIBE A RACK PATCH: divide every voltage by 5, EXCEPT a V/oct wire,
 * which is multiplied by 12.
 *
 * KNOBS ARE NOT WIRES and do not follow the ÷5 law: each carries the unit
 * Bogaudio's own ParamQuantity DISPLAYS (seconds, cents, a frequency ratio, a
 * 0…1 fraction), because that is the number an author reads off the module in
 * Rack. Their raw 0…1 param positions and the display curves between the two are
 * D3 below. The one place a knob and a wire share a name is DADSRH's `trigger`,
 * where the C++ itself ADDS the button to the input — so they legitimately share
 * one AudioParam and sum.
 *
 * ── WHY A CV INPUT DEFAULTS TO 2.0 AND NOT TO 0 (D2, AND IT IS A TRAP) ──────
 * Bogaudio's CV inputs SCALE their knob: `level *= clamp(cv / 10, 0, 1)`, applied
 * only `if (input.isConnected())`. An unconnected input therefore means "times
 * one", while a connected input sitting at 0 V means SILENCE. Our engine has no
 * connectedness signal inside the kernel — an unwired AudioParam simply reads its
 * default — so a default of 0 would mute every module the moment it was built.
 * Every `*_cv` param therefore defaults to `CV_UNITY_UNITS` (2.0 = 10 V), which
 * is the value that makes the scaler exactly 1. Wire it and it behaves as Rack's.
 *
 * ── DELIBERATE DEVIATIONS, ALL OF THEM, NAMED ───────────────────────────────
 *
 * D1. FLOAT64 THROUGHOUT; THE C++ IS FLOAT32. Their `Phasor::_update` computes
 *     `(float)(f / fs) * (float)cyclePhase`, and `cyclePhase` (UINT32_MAX) is not
 *     representable in float32 — it rounds UP to 2^32. So their phase increment
 *     carries a float32 rounding we do not. Measured (tests/port_vc3a_test.js):
 *     the tuning difference is below 1e-4 cents. The PHASE ARITHMETIC ITSELF IS
 *     EXACT here, not approximated: phase is an integer-valued float64 below 2^32
 *     plus a separate cycle counter, and the table index is their integer
 *     expression evaluated with `Math.floor`, which float64 represents exactly
 *     (the widest intermediate is `phase·2^16 < 2^48`).
 * D2. CV INPUTS DEFAULT TO UNITY (2.0 = 10 V) — see above. The same absence of a
 *     connectedness signal has one audible corollary: FMOp gates its anti-alias
 *     oversampling on `FM_INPUT.isConnected() && depth > 0.001`, and we can only
 *     test the depth. A patch with depth turned up and NOTHING wired to `fm`
 *     therefore oversamples where Rack would not. Depth defaults to 0, so this is
 *     unreachable until an author asks for FM.
 * D3. KNOBS CARRY DISPLAYED UNITS, NOT RAW PARAM POSITIONS. Rack stores an
 *     envelope segment as 0…1 and shows `v²·10` seconds; we store the SECONDS.
 *     Same for FMOp's ratio (raw −1…1, shown 0.01…10) and fine tune (raw ±1,
 *     shown ±100 cents). What is lost is the knob's TAPER — the feel of a drag,
 *     not the sound — and what is gained is that an equation on the knob means
 *     something (`= 0.25` IS a quarter second) and the Inspector reads in units.
 *     The inverse curves are stated in each spec's `help` so a Rack patch's raw
 *     numbers can be converted by hand.
 * D4. THE `SLOW` AND `SPEED` SWITCHES ARE NOT PORTED, BECAUSE D3 CONSUMED THEM.
 *     LFO's `slow` subtracts 4 octaves from the frequency knob's mapping
 *     (`lfo_base.cpp getPitchOffset`) and DADSRH's `speed` multiplies every stage
 *     time by 100 instead of 10 (`dadsrh_core.cpp knobTime`). Both are RANGE
 *     shifts on a knob whose displayed unit we now store directly, so keeping
 *     them would ship a control that does nothing — which the house rules forbid
 *     outright ("never ship an inert control"). The ranges are widened instead:
 *     the LFO reaches down to the slow mode's bottom, DADSRH's stages up to 100 s.
 *     TO TRANSCRIBE: `hz = 261.626·2^(knob − 7)`, or `− 11` with slow engaged;
 *     `seconds = knob²·10`, or `·100` with speed on slow.
 * D5. THEIR RANDOMNESS IS A GLOBAL RNG; OURS IS A SEED KNOB. LFO's stepped output
 *     reads a 4096-entry table filled by `WhiteNoiseGenerator` off
 *     `Seeds::getInstance()` (`dsp/oscillator.cpp SteppedRandomOscillator`), so
 *     the same patch is a different sequence every launch. Determinism is not
 *     negotiable here (`<app>/CLAUDE.md`, "the three kinds of state"), so the
 *     table is filled by `minstd_rand` — their own generator — from a `seed` knob.
 * D6. THE CIC DECIMATOR IS ITS OWN ALGEBRAIC IDENTITY, NOT ITS int64 FORM.
 *     `dsp/filters/resample.cpp CICDecimator::next` runs four never-reset int64
 *     integrators at 2^32 fixed point and DEPENDS ON int64 WRAPAROUND for the
 *     comb differences to recover a bounded value; float has no wraparound, so a
 *     literal port would drift to infinity. A CIC of N stages and factor R is
 *     exactly `((1 − z^−R)/(1 − z^−1))^N` — N cascaded length-R boxcar SUMS — so
 *     that is what `BoxcarDecimator` computes, with bounded state. Equivalence is
 *     not asserted, it is MEASURED against a BigInt model of the int64 original.
 * D7. NO POLYPHONY. Rack cables carry 16 channels and every module here is
 *     `channels()`-aware; our `audio` wire is mono, so each kernel is one channel
 *     (`c = 0`). Nothing else changes — Bogaudio's per-channel Engine struct IS
 *     the kernel. AddrSeq's `poly_input` and Mix4's `poly_channel_offset` JSON
 *     fields are therefore omitted rather than exposed as knobs that could not
 *     act. Reported to the lead: where a patch's polyphony is load-bearing, it
 *     needs a decision above this block.
 * D8. METERS AND LIGHTS ARE NOT PORTED. `Mix4`'s RootMeanSquare, every module's
 *     stage lights and AddrSeq's step lights compute a number that only a panel
 *     reads. We have `audio_meter` / `audio_spectrum` for that, and PowerRP nodes
 *     carry a `readout` instead. No sample path depends on them.
 * D9. EXPANDERS ARE NOT PORTED. AddrSeq's `AddrSeqX`, Mix4's `Mix4x` and the
 *     mixer's send/return bus are a second module bolted to the right of the
 *     first; there is no adjacency in a node graph. `Mix4`'s expander branch is
 *     therefore the not-connected branch, which is the code Rack runs with no
 *     expander present.
 * D11. `Manual`'s +10 V OUTPUT OPTION IS NOT PORTED, AND THIS IS THE ONE PLACE
 *     R7-UNITS CLAUSE 4 COSTS A RACK FEATURE. Their `_outputScale` doubles all eight
 *     outputs to 10 V, which exists so a gate can satisfy a CV input expecting a
 *     10 V full scale. Clause 4 says a `gate`/`trigger` port carries 0..1 — logic is
 *     not level — so there is no voltage for the option to scale, and keeping it
 *     would have shipped either a control that does nothing or eight `trigger` ports
 *     sitting at 2.0, outside their own declared range. MEASURED: it WAS at 2.0 for
 *     four commits, found by checking against clause 4 rather than by a failure.
 *     Bool's outputs needed no change and that was LUCK, not design: its gate is
 *     5 V and 5/5 = 1, so a volts-shaped expression gave the clause-4 answer. Both
 *     now read `GATE_UNITS`, and the port test sweeps every trigger port of every
 *     module against 0..1 under every option so neither can drift back.
 *     IF THE FEATURE IS WANTED: it needs a `number`-typed output set (a level, not a
 *     gate), which is a lead ruling, not a block decision.
 * D10. THE SINE TABLE IS BUILT WITH `Math.sin`, NOT THEIR QUARTER-WAVE FOLD.
 *     `dsp/table.cpp SineTable::_generate` fills one quarter from `sinf` and
 *     mirrors it; the fold is exact in real arithmetic, so the only difference is
 *     float32 vs float64 rounding of the table ENTRIES. Kept as Float32Array so
 *     the storage matches; the values differ from theirs by < 1e-7. The table is
 *     4096 entries and SHARED (their `StaticSineTable`), lazily built once.
 *
 * Every kernel is a class with `control(c)` and `sample(c, out)`. Both are
 * COMMANDS (they advance the kernel's own state) and neither allocates, because
 * they run on the audio thread. `control()` is the seam for Bogaudio's
 * `modulate()`: `module.cpp BGModule::process` runs it every `_modulationSteps`
 * samples (`sampleRate · 2.5 ms`), NOT every sample, and the processor drives
 * that split. A module whose C++ has no `modulate()` override — AddrSeq, EightOne,
 * DADSRH, Bool, Mix4, Manual — has an EMPTY `control()` and reads its params in
 * `sample()`, which is what those modules really do.
 */

// ── THE UNIT LAW AND THE PLATFORM CONSTANTS ─────────────────────────────────

/** Rack's nominal full scale in volts, and therefore our one unit. See the
 *  header: this is the whole of the block's voltage-scaling decision. */
export const VOLTS_PER_UNIT = 5;

/** An octave, in semitones. Named because it is the whole of the pitch law. */
export const SEMITONES_PER_OCTAVE = 12;

/**
 * THE PITCH LAW (`claude_instructions.md` § R7-UNITS): a V/oct port carries
 * SEMITONES, so one unit on it is one twelfth of an octave. This constant is the
 * seam — every place a pitch wire becomes a frequency multiplies by it — and it is
 * where the ruling would be re-applied if the law ever moved again.
 */
export const OCTAVES_PER_UNIT = 1 / SEMITONES_PER_OCTAVE;

/** …and the same law from the other side, for a reader converting a Rack patch:
 *  a V/oct CABLE's volts times this is what to type on the wire. */
export const SEMITONES_PER_VOLT = SEMITONES_PER_OCTAVE;

/** The value a `*_cv` scaler param takes when nothing is wired to it: 10 V, the
 *  input voltage at which Bogaudio's `clamp(cv / 10, 0, 1)` is exactly 1. D2. */
export const CV_UNITY_UNITS = 10 / VOLTS_PER_UNIT;

/** The divisor in every `clamp(cv / CV_FULL_SCALE_VOLTS, …)` — Bogaudio treats
 *  10 V as a unipolar CV's full scale. */
const CV_FULL_SCALE_VOLTS = 10;

/** …and 5 V as a BIPOLAR CV's full scale (`clamp(cv / 5, −1, 1)`, used by the
 *  LFO's pw/offset inputs and Mix4's pan inputs). */
const BIPOLAR_CV_FULL_SCALE_VOLTS = 5;

/**
 * WHAT A GATE CARRIES — R7-UNITS clause 4, and it is NOT the ÷5 level law: a
 * `gate`/`trigger` port carries 0..1, because logic is not level and the project's
 * trigger convention predates this block. So a full gate is 1, full stop.
 */
export const GATE_UNITS = 1;

/**
 * `rack_overrides.hpp Trigger`'s thresholds as FRACTIONS OF A FULL GATE, which is
 * the only way to state them once clause 4 detaches a gate from volts: Bogaudio
 * fires above 1 V and re-arms below 0.1 V on its own 5 V gate, i.e. at one fifth and
 * one fiftieth of full. The numbers happen to equal `1/VOLTS_PER_UNIT` and
 * `0.1/VOLTS_PER_UNIT`; they are NOT derived from them, and writing them that way
 * is what made Bool accidentally right and Manual accidentally wrong (D11).
 */
export const GATE_HIGH_UNITS = GATE_UNITS / 5;
export const GATE_LOW_UNITS = GATE_UNITS / 50;

/** `module.cpp BGModule::onSampleRateChange`: "modulate every ~2.5ms regardless
 *  of sample rate". This is the ClockDivider the brief warns not to improve away:
 *  a knob read per sample changes how a swept control sounds. */
export const MODULATION_SECONDS = 0.0025;

/** `dsp/pitch.hpp referenceFrequency` — C4, where a Rack 1V/oct CV is zero. Note
 *  it is Bogaudio's OWN 261.626, three digits short of Rack's 261.6256; the port
 *  keeps theirs, because theirs is what tunes their oscillators. */
export const REFERENCE_FREQUENCY = 261.626;

/** `Phasor::cyclePhase` is UINT32_MAX — one LESS than 2^32, which matters: every
 *  reduction below is modulo this, not modulo a power of two. */
export const CYCLE_PHASE = 2 ** 32 - 1;

/** `dsp/table.hpp StaticSineTable` is `StaticTable<SineTable, 12>` = 2^12. */
const SINE_TABLE_LENGTH = 2 ** 12;

/** `dsp/signal.cpp`: `Amplifier::minDecibels`, `maxDecibels`, and the table size
 *  `StaticLevelTable` = `StaticTable<LevelTable, 13>` = 2^13 entries. */
const MIN_DECIBELS = -60;
const MAX_DECIBELS = 20;
const DECIBELS_RANGE = MAX_DECIBELS - MIN_DECIBELS;
const LEVEL_TABLE_LENGTH = 2 ** 13;

/** `Amplifier::LevelTable::_generate`'s ramp-to-zero region: the bottom `rdb` of
 *  the range is linear in amplitude rather than in decibels, so a fader reaching
 *  its floor fades out instead of stepping. */
const LEVEL_TABLE_RAMP_DECIBELS = 6;

/** `dsp/signal.cpp Saturator`. `limit` is volts; `y1` and `offset` are the
 *  Zavalishin curve's own constants, named in the source as "magic". */
const SATURATOR_LIMIT_VOLTS = 12;
const SATURATOR_Y1 = 0.98765;
const SATURATOR_OFFSET = 0.075 / SATURATOR_LIMIT_VOLTS;

const TAU = 2 * Math.PI;

// ── PURE HELPERS ────────────────────────────────────────────────────────────

/**
 * Pure function. `dsp/pitch.hpp cvToFrequency`: a 1V/oct CV in VOLTS to hertz.
 *
 * @param {number} volts - the CV, in volts (0 V is C4)
 * @returns {number} hertz
 *
 * @example cvToFrequency(0) // 261.626
 * @example cvToFrequency(1) // 523.252
 * @example cvToFrequency(-7) // 2.04395... — the LFO's frequency knob at 0
 */
export function cvToFrequency(volts) {
  return 2 ** volts * REFERENCE_FREQUENCY;
}

/**
 * Pure function. `module.cpp`: how many samples one `modulate()` period spans.
 * Truncating, because the C++ assigns a float product to an `int`.
 *
 * @param {number} sampleRate - hertz
 * @returns {number} samples between control ticks
 *
 * @example modulationSteps(48000) // 120
 * @example modulationSteps(44100) // 110
 */
export function modulationSteps(sampleRate) {
  return Math.trunc(sampleRate * MODULATION_SECONDS);
}

/**
 * Pure function. `dsp/oscillator.cpp Phasor::_update` — a frequency as a phase
 * increment on the `CYCLE_PHASE` grid, truncated and reduced exactly as theirs.
 *
 * @param {number} frequency - hertz (may be negative)
 * @param {number} sampleRate - hertz
 * @returns {number} an integer-valued phase increment in (−CYCLE_PHASE, CYCLE_PHASE)
 *
 * @example phaseDelta(0, 48000) // 0
 * @example phaseDelta(24000, 48000) // 2147483647 (half a cycle per sample)
 * @example phaseDelta(48000, 48000) // 0 (one whole cycle per sample wraps to none)
 */
export function phaseDelta(frequency, sampleRate) {
  return Math.trunc((frequency / sampleRate) * CYCLE_PHASE) % CYCLE_PHASE;
}

/**
 * Pure function. `Phasor::radiansToPhase` — a phase OFFSET in radians on the same
 * grid. This is the one conversion FM depth and feedback both go through, so it
 * is where "how much phase is one volt" is finally decided (see FmOpKernel).
 *
 * @param {number} radians - a phase offset, positive or negative
 * @returns {number} an integer-valued phase offset
 *
 * @example radiansToPhase(0) // 0
 * @example radiansToPhase(2 * Math.PI) // 4294967295 (one whole cycle)
 * @example radiansToPhase(-Math.PI) // -2147483647 (half a cycle back)
 */
export function radiansToPhase(radians) {
  return Math.trunc((radians / TAU) * CYCLE_PHASE);
}

/**
 * Pure function. `TablePhasor::nextForPhase`'s opening `phase %= cyclePhase`,
 * INCLUDING what C++ does to a negative offset. Their `phase_t` is `uint64_t`, so
 * a negative sum arrives as `x + 2^64`; and `2^64 ≡ 1 (mod 2^32 − 1)` because
 * `2^32 ≡ 1`, so the reduction of a negative value is one grid step ABOVE the
 * naive answer. One part in 4.3e9 of a cycle, reproduced because it is free.
 *
 * @param {number} phase - an integer-valued phase, any sign
 * @returns {number} the same phase in [0, CYCLE_PHASE)
 *
 * @example reducePhase(0) // 0
 * @example reducePhase(2 ** 32 - 1) // 0
 * @example reducePhase(-1) // 0 (naively CYCLE_PHASE-1; the uint64 +1 lands it on 0)
 * @example reducePhase(-(2 ** 32 - 1) + 5) // 6 (5, plus that same +1)
 */
export function reducePhase(phase) {
  if (phase >= 0) return phase % CYCLE_PHASE;
  return ((phase % CYCLE_PHASE) + 1 + CYCLE_PHASE) % CYCLE_PHASE;
}

/** THE shared 4096-entry sine table (`StaticSineTable`), built on first use. D10. */
let sineTableCache = null;

/**
 * Query (memoises a module-level table; the VALUES are a pure function of the
 * index). `dsp/table.cpp SineTable::_generate`, as a Float32Array so the storage
 * width matches the C++.
 *
 * @returns {Float32Array} 4096 entries, one cycle of sine
 *
 * @example sineTable().length // 4096
 * @example sineTable()[0] // 0
 * @example sineTable()[1024] // 1 (a quarter cycle)
 */
export function sineTable() {
  if (!sineTableCache) {
    sineTableCache = new Float32Array(SINE_TABLE_LENGTH);
    for (let i = 0; i < SINE_TABLE_LENGTH; i++) {
      sineTableCache[i] = Math.sin((TAU * i) / SINE_TABLE_LENGTH);
    }
  }
  return sineTableCache;
}

/** `TablePhasor::Interpolation`, in the order FMOp's menu offers them: "Classic
 *  (extra harmonics)" is INTERPOLATION_OFF and is FMOp's DEFAULT — the stepping
 *  of a 4096-entry table read without interpolation is part of the sound. */
export const SINE_INTERPOLATIONS = ["classic", "clean"];

/**
 * Pure function. `dsp/oscillator.cpp TablePhasor::nextForPhase` for the shared
 * sine table. `classic` is their integer index expression, evaluated exactly;
 * `clean` is their linear interpolation.
 *
 * @param {number} phase - an integer-valued phase, any sign
 * @param {boolean} interpolate - true for "clean" (INTERPOLATION_ON)
 * @returns {number} the sample, in [−1, 1]
 *
 * @example tableSine(0, false) // 0
 * @example Math.abs(tableSine(Math.trunc((2 ** 32 - 1) / 4), true) - 1) < 1e-6 // true
 * @example // the classic path QUANTISES the phase to one of 4096 slots:
 * @example tableSine(1, false) === tableSine(0, false) // true
 */
export function tableSine(phase, interpolate) {
  const table = sineTable();
  const reduced = reducePhase(phase);
  if (!interpolate) {
    // (((phase << 16) / cyclePhase) * tableLength) >> 16, integer throughout.
    const scaled = Math.floor((reduced * 65536) / CYCLE_PHASE);
    const index = Math.floor((scaled * SINE_TABLE_LENGTH) / 65536) % SINE_TABLE_LENGTH;
    return table[index];
  }
  const fi = (reduced / CYCLE_PHASE) * SINE_TABLE_LENGTH;
  let i = Math.trunc(fi);
  if (i >= SINE_TABLE_LENGTH) i = 0;
  const v1 = table[i];
  const v2 = table[i + 1 === SINE_TABLE_LENGTH ? 0 : i + 1];
  return v1 + (fi - i) * (v2 - v1);
}

/**
 * Pure function. `dsp/oscillator.cpp SawOscillator::nextForPhase` — a rising ramp
 * over one cycle, ±1.
 *
 * @param {number} phase - an integer-valued phase
 * @returns {number} in [−1, 1)
 *
 * @example tableSaw(0) // -1
 * @example Math.abs(tableSaw(Math.trunc((2 ** 32 - 1) / 2))) < 1e-6 // true
 */
export function tableSaw(phase) {
  return (reducePhase(phase) / CYCLE_PHASE) * 2 - 1;
}

/**
 * Pure function. `dsp/oscillator.cpp TriangleOscillator::nextForPhase`. Starts at
 * 0, peaks at +1 a quarter of the way through, −1 at three quarters.
 *
 * @param {number} phase - an integer-valued phase
 * @returns {number} in [−1, 1]
 *
 * @example tableTriangle(0) // 0
 * @example Math.abs(tableTriangle(Math.trunc((2 ** 32 - 1) * 0.25)) - 1) < 1e-6 // true
 * @example Math.abs(tableTriangle(Math.trunc((2 ** 32 - 1) * 0.75)) + 1) < 1e-6 // true
 */
export function tableTriangle(phase) {
  const reduced = reducePhase(phase);
  const quarter = CYCLE_PHASE * 0.25;
  const threeQuarters = CYCLE_PHASE * 0.75;
  const p = (reduced / CYCLE_PHASE) * 4;
  if (reduced < quarter) return p;
  if (reduced < threeQuarters) return 2 - p;
  return p - 4;
}

/**
 * Pure function. `dsp/signal.cpp Amplifier::LevelTable::_generate` evaluated at
 * one index — the amplitude a decibel value maps to. Below `min + 6 dB` the curve
 * is LINEAR IN AMPLITUDE down to zero, which is what makes a fader's bottom fade
 * rather than step.
 *
 * @param {number} index - a table slot, 0…LEVEL_TABLE_LENGTH−1
 * @returns {number} an amplitude multiplier
 *
 * @example levelTableEntry(0) // 0
 * @example Math.abs(levelTableEntry(8192 * 60 / 80) - 1) < 0.001 // true (0 dB is unity)
 */
export function levelTableEntry(index) {
  if (index === 0) return 0;
  const thresholdDb = MIN_DECIBELS + LEVEL_TABLE_RAMP_DECIBELS;
  const thresholdAmplitude = 10 ** (thresholdDb * 0.05);
  const db = MIN_DECIBELS + (index / LEVEL_TABLE_LENGTH) * DECIBELS_RANGE;
  if (db <= thresholdDb) return ((db - MIN_DECIBELS) / LEVEL_TABLE_RAMP_DECIBELS) * thresholdAmplitude;
  return 10 ** (db * 0.05);
}

/** THE shared 8192-entry level table (`Amplifier::StaticLevelTable`). */
let levelTableCache = null;

/**
 * Query (memoises a module-level table). `dsp/signal.cpp Amplifier::setLevel` —
 * decibels to an amplitude, THROUGH THEIR TABLE, so the 8192-step quantisation of
 * a fader is reproduced rather than smoothed away.
 *
 * @param {number} db - decibels
 * @returns {number} an amplitude multiplier
 *
 * @example amplifierLevel(-60) // 0 (their floor is silence, not -60 dB)
 * @example Math.abs(amplifierLevel(0) - 1) < 0.001 // true
 * @example amplifierLevel(-120) // 0
 */
export function amplifierLevel(db) {
  if (db <= MIN_DECIBELS) return 0;
  if (db >= MAX_DECIBELS) return 10 ** (db * 0.05);
  if (!levelTableCache) {
    levelTableCache = new Float32Array(LEVEL_TABLE_LENGTH);
    for (let i = 0; i < LEVEL_TABLE_LENGTH; i++) levelTableCache[i] = levelTableEntry(i);
  }
  return levelTableCache[Math.trunc(((db - MIN_DECIBELS) / DECIBELS_RANGE) * LEVEL_TABLE_LENGTH)];
}

/**
 * Pure function. `dsp/signal.cpp Saturator::next` — Zavalishin's soft clip, in
 * VOLTS, saturating towards ±12 V. Odd-symmetric by construction.
 *
 * @param {number} volts - the sample, in volts
 * @returns {number} volts, |result| < 12
 *
 * @example Math.abs(saturate(1) - 1) < 0.01 // true (nearly linear at 1 V — 0.9926)
 * @example saturate(-5) === -saturate(5) // true (odd-symmetric, exactly)
 * @example // NOT exactly zero at zero: their `offset` constant leaves −27 µV of DC.
 * @example saturate(0) // -0.000026578241279828774
 */
export function saturate(volts) {
  const x = volts * (1 / SATURATOR_LIMIT_VOLTS);
  const curve = (u) => {
    const x1 = (u + 1) * 0.5;
    return SATURATOR_LIMIT_VOLTS * (SATURATOR_OFFSET + x1 - Math.sqrt(x1 * x1 - SATURATOR_Y1 * u) * (1 / SATURATOR_Y1));
  };
  return volts < 0 ? -curve(-x) : curve(x);
}

/**
 * Pure function. `dsp/signal.cpp Panner::setPan` — the constant-power pan law,
 * read off the sine table with their integer truncation. TWO FUNCTIONS RATHER
 * THAN ONE RETURNING A PAIR: Mix4 calls this four times per sample on the audio
 * thread, and an object literal there would be four allocations a sample.
 *
 * @param {number} pan - −1 full left, 0 centre, 1 full right
 * @returns {number} the left channel's amplitude multiplier
 *
 * @example Math.abs(panLeft(-1) - 1) < 1e-6 // true (hard left is unity left)
 * @example Math.abs(panLeft(1)) < 1e-6 // true (hard right is silent left)
 * @example Math.abs(panLeft(0) - Math.SQRT1_2) < 0.001 // true (centre is −3 dB)
 */
export function panLeft(pan) {
  const table = sineTable();
  return table[Math.trunc(((1 + pan) / 8 + 0.25) * SINE_TABLE_LENGTH) % SINE_TABLE_LENGTH];
}

/**
 * Pure function. The right half of `Panner::setPan`. See `panLeft`.
 *
 * @param {number} pan - −1 full left, 0 centre, 1 full right
 * @returns {number} the right channel's amplitude multiplier
 *
 * @example Math.abs(panRight(1) - 1) < 1e-6 // true
 * @example Math.abs(panRight(0) - panLeft(0)) < 1e-6 // true (centre is even)
 */
export function panRight(pan) {
  const table = sineTable();
  return table[Math.trunc(((1 + pan) / 8) * SINE_TABLE_LENGTH) % SINE_TABLE_LENGTH];
}

/**
 * Pure function. A unipolar CV scaler: `clamp(volts / 10, 0, 1)`, the expression
 * every Bogaudio CV input in this block applies to its knob.
 *
 * @param {number} units - the wire value, in our units
 * @returns {number} a multiplier in [0, 1]
 *
 * @example unipolarCv(2) // 1 (10 V is unity — see CV_UNITY_UNITS)
 * @example unipolarCv(1) // 0.5
 * @example unipolarCv(-3) // 0
 */
export function unipolarCv(units) {
  const scaled = (units * VOLTS_PER_UNIT) / CV_FULL_SCALE_VOLTS;
  return scaled < 0 ? 0 : (scaled > 1 ? 1 : scaled);
}

/**
 * Pure function. A bipolar CV scaler: `clamp(volts / 5, −1, 1)`.
 *
 * @param {number} units - the wire value, in our units
 * @returns {number} a multiplier in [−1, 1]
 *
 * @example bipolarCv(1) // 1 (5 V)
 * @example bipolarCv(-0.5) // -0.5
 * @example bipolarCv(4) // 1
 */
export function bipolarCv(units) {
  const scaled = (units * VOLTS_PER_UNIT) / BIPOLAR_CV_FULL_SCALE_VOLTS;
  return scaled < -1 ? -1 : (scaled > 1 ? 1 : scaled);
}

/**
 * Pure function. Clamp, spelled once so no kernel writes a nested ternary.
 *
 * @param {number} v - the value
 * @param {number} lo - lower bound
 * @param {number} hi - upper bound
 * @returns {number}
 *
 * @example clamp(5, 0, 1) // 1
 * @example clamp(-5, -1, 1) // -1
 * @example clamp(0.5, 0, 1) // 0.5
 */
export function clamp(v, lo, hi) {
  return v < lo ? lo : (v > hi ? hi : v);
}

/**
 * Pure function. Resolve a discrete knob's value to its index, LOUDLY. Every
 * `set…` in this file goes through it so a typo in a document names its own
 * problem instead of silently selecting option zero.
 *
 * @param {string} what - what is being set, for the message
 * @param {string} name - the option value
 * @param {string[]} options - the legal values, in spec order
 * @returns {number} the index
 *
 * @example pickOption("x", "off", ["off", "on"]) // 0
 * @example pickOption("x", "on", ["off", "on"]) // 1
 */
export function pickOption(what, name, options) {
  const index = options.indexOf(name);
  if (index < 0) {
    throw new Error(`Unknown ${what} ${JSON.stringify(name)}; expected one of ${options.join(", ")}`);
  }
  return index;
}

/**
 * Pure function. `key1`…`keyN`, built ONCE at construction. The kernels below
 * index their control frame by a numbered param name (`step3`, `in7`, `level2`);
 * building that string per sample would allocate on the audio thread, which the
 * worklet's real-time checklist forbids.
 *
 * @param {string} prefix - the param family
 * @param {number} count - how many
 * @returns {string[]} the names, one-based
 *
 * @example numberedKeys("step", 3) // ["step1", "step2", "step3"]
 * @example numberedKeys("in", 1) // ["in1"]
 */
export function numberedKeys(prefix, count) {
  const keys = [];
  for (let i = 1; i <= count; i++) keys.push(`${prefix}${i}`);
  return keys;
}

// ── THE PRIMITIVES BOGAUDIO BUILDS ON ───────────────────────────────────────

/**
 * `Rack include/dsp/digital.hpp TSchmittTrigger<float>`, with Bogaudio's
 * thresholds (`rack_overrides.hpp Trigger`: 1 V high, 0.1 V low) expressed in our
 * units.
 *
 * THE THIRD STATE IS LOAD-BEARING and is why this is not two comparisons: a fresh
 * trigger is UNINITIALIZED, and an input that is already high when the module
 * starts sets the state without FIRING. Otherwise every patch would emit one
 * spurious event on its first sample.
 *
 * Command.
 */
export class SchmittTrigger {
  constructor(highUnits = GATE_HIGH_UNITS, lowUnits = GATE_LOW_UNITS) {
    this.high = highUnits;
    this.low = lowUnits;
    this.reset();
  }

  /** Command. Back to UNINITIALIZED — `Trigger::reset`. */
  reset() {
    this.state = null;
  }

  /** Command. Returns true on a LOW→HIGH transition only. */
  process(units) {
    if (this.state === false && units >= this.high) {
      this.state = true;
      return true;
    }
    if (this.state === true && units <= this.low) {
      this.state = false;
      return false;
    }
    if (this.state === null) {
      if (units >= this.high) this.state = true;
      else if (units <= this.low) this.state = false;
    }
    return false;
  }

  /** Query. Is the gate currently high? */
  isHigh() {
    return this.state === true;
  }
}

/**
 * `dsp/signal.cpp PositiveZeroCrossing` — the LFO's reset detector, which is NOT
 * a Schmitt trigger: it fires on a rising cross of +0.01 V and needs either a
 * cross below −0.01 V or twenty consecutive near-zero samples to re-arm. That
 * zero-count path is what lets it retrigger on a signal that returns to zero
 * without going negative.
 *
 * Command.
 */
export class PositiveZeroCrossing {
  constructor() {
    this.positiveThreshold = 0.01 / VOLTS_PER_UNIT;
    this.negativeThreshold = -this.positiveThreshold;
    this.zeroesForReset = 20;
    this.reset();
  }

  /** Command. `PositiveZeroCrossing::reset` — back to the NEGATIVE state. */
  reset() {
    this.state = "negative";
    this.zeroCount = 0;
  }

  /** Command. Returns true on the rising cross. */
  next(units) {
    if (this.state === "negative") {
      if (units > this.positiveThreshold) {
        this.state = "positive";
        return true;
      }
      return false;
    }
    if (this.state === "positive") {
      if (units < this.negativeThreshold) this.state = "negative";
      else if (units < this.positiveThreshold) {
        this.state = "zeroes";
        this.zeroCount = 1;
      }
      return false;
    }
    if (units >= this.negativeThreshold) {
      this.zeroCount += 1;
      if (this.zeroCount >= this.zeroesForReset) this.state = "negative";
    } else {
      this.state = "negative";
    }
    return false;
  }
}

/**
 * `dsp/signal.cpp SlewLimiter` — a linear rate limit of `range / (ms · fs)` per
 * sample. Bogaudio uses it on KNOB values (a level, a pan), never on audio, which
 * is why its `range` is the knob's span and not a voltage.
 *
 * Command.
 */
export class SlewLimiter {
  constructor(sampleRate, milliseconds, range) {
    this.delta = range / ((milliseconds / 1000) * sampleRate);
    this.last = 0;
  }

  /** Command. One step towards `sample`, at most `delta`. */
  next(sample) {
    if (sample > this.last) {
      this.last = Math.min(this.last + this.delta, sample);
    } else {
      this.last = Math.max(this.last - this.delta, sample);
    }
    return this.last;
  }
}

/**
 * `dsp/signal.cpp ShapedSlewLimiter` — the LFO's smoothing. Unlike SlewLimiter
 * this is a TIME-TO-GO integrator with a shaping exponent, so it eases in and out
 * of a step instead of ramping linearly. The LFO drives it with shape 0.5.
 *
 * Command.
 */
export class ShapedSlewLimiter {
  constructor() {
    this.range = CV_FULL_SCALE_VOLTS / VOLTS_PER_UNIT;
    this.sampleTime = 0;
    this.time = 0;
    this.shapeExponent = 0;
    this.inverseShapeExponent = 0;
    this.last = 0;
  }

  /** Command. `setParams`. A shape within ±0.05 of zero means "no shaping". */
  setParams(sampleRate, milliseconds, shape) {
    this.sampleTime = 1 / sampleRate;
    this.time = milliseconds / 1000;
    this.shapeExponent = shape > -0.05 && shape < 0.05 ? 0 : shape;
    this.inverseShapeExponent = 1 / this.shapeExponent;
  }

  /** Command. `ShapedSlewLimiter::next`. */
  next(sample) {
    const difference = sample - this.last;
    if (this.time < 0.0001) {
      this.last = sample;
      return this.last;
    }
    let ttg = Math.abs(difference) / this.range;
    if (this.shapeExponent !== 0) ttg = ttg ** this.shapeExponent;
    ttg *= this.time;
    ttg = Math.max(0, ttg - this.sampleTime);
    ttg /= this.time;
    if (this.shapeExponent !== 0) ttg = ttg ** this.inverseShapeExponent;
    const y = Math.abs(difference) - ttg * this.range;
    this.last = difference < 0 ? Math.max(this.last - y, sample) : Math.min(this.last + y, sample);
    return this.last;
  }
}

/**
 * `Rack include/dsp/digital.hpp PulseGenerator` — a one-shot whose `process`
 * reports the state BEFORE stepping, so a pulse of one sample time is one sample
 * long.
 *
 * Command.
 */
export class PulseGenerator {
  constructor() {
    this.remaining = 0;
  }

  /** Command. Start (or extend) a pulse of `duration` seconds. */
  trigger(duration) {
    if (duration > this.remaining) this.remaining = duration;
  }

  /** Command. Was the pulse high? Advances by `deltaTime` seconds. */
  process(deltaTime) {
    if (this.remaining > 0) {
      this.remaining -= deltaTime;
      return true;
    }
    return false;
  }
}

/**
 * `dsp/signal.cpp Timer` — counts samples and latches once expired. Used as a
 * DEBOUNCE (AddrSeq suppresses a clock within 1 ms of a reset) and as a startup
 * delay (Manual's trigger-on-load).
 *
 * Command.
 */
export class Timer {
  constructor(sampleRate, seconds) {
    this.durationSteps = sampleRate * seconds;
    this.reset();
  }

  /** Command. `Timer::reset`. */
  reset() {
    this.expired = false;
    this.countSteps = 0;
  }

  /** Command. Returns true while still RUNNING — theirs is inverted like this. */
  next() {
    this.countSteps += 1;
    this.expired = this.expired || this.countSteps >= this.durationSteps;
    return !this.expired;
  }
}

/**
 * `dsp/oscillator.cpp Phasor`, with its accumulator split in two: `phase` inside
 * [0, CYCLE_PHASE) and `cycle` counting wraps.
 *
 * THE SPLIT IS NOT AN OPTIMISATION — IT IS WHAT MAKES TWO WAVEFORMS RIGHT. Their
 * `_phase` is a never-reduced uint64, and `SquareOscillator` divides it by
 * cyclePhase to latch a pulse width once per cycle while `SteppedRandomOscillator`
 * divides it to index its random table. Reducing the phase and throwing the
 * quotient away would freeze the stepped output on its first value. Carrying the
 * unreduced sum in a float64 instead would lose integer exactness after about
 * seventeen minutes at audio rates.
 *
 * Command.
 */
export class Phasor {
  constructor() {
    this.phase = 0;
    this.cycle = 0;
    this.delta = 0;
    this.frequency = 0;
  }

  /** Command. `Oscillator::setFrequency` + `Phasor::_update`. */
  setFrequency(frequency, sampleRate) {
    this.frequency = frequency;
    this.delta = phaseDelta(frequency, sampleRate);
  }

  /** Command. `Phasor::resetPhase` — phase AND cycle, since theirs is one field. */
  resetPhase() {
    this.phase = 0;
    this.cycle = 0;
  }

  /** Command. `advancePhase(n)`. `n` steps of the increment, wraps tracked. */
  advance(steps) {
    this.phase += steps * this.delta;
    while (this.phase >= CYCLE_PHASE) {
      this.phase -= CYCLE_PHASE;
      this.cycle += 1;
    }
    while (this.phase < 0) {
      this.phase += CYCLE_PHASE;
      this.cycle -= 1;
    }
  }
}

/**
 * `dsp/oscillator.cpp SquareOscillator::nextForPhase` — a pulse whose width is
 * LATCHED at each cycle boundary, so modulating it steps once per cycle instead
 * of smearing the edge. `positive` is real state: their comparison is asymmetric
 * (`>=` on the way down, `<` on the way up), so the edge cannot chatter.
 *
 * Command.
 */
export class SquareWave {
  constructor() {
    this.minPulseWidth = 0.03;
    this.maxPulseWidth = 1 - this.minPulseWidth;
    this.pulseWidth = CYCLE_PHASE * 0.5;
    this.nextPulseWidth = CYCLE_PHASE * 0.5;
    this.lastCycle = -1;
    this.positive = true;
  }

  /** Command. `setPulseWidth` — clamped, and staged for the next cycle. */
  setPulseWidth(pw) {
    this.nextPulseWidth = CYCLE_PHASE * clamp(pw, this.minPulseWidth, this.maxPulseWidth);
  }

  /** Command. The sample at a phase; `cycle` is the phasor's wrap count. */
  valueAt(phase, cycle) {
    if (this.lastCycle !== cycle) {
      this.lastCycle = cycle;
      this.pulseWidth = this.nextPulseWidth;
    }
    const reduced = reducePhase(phase);
    if (this.positive) {
      if (reduced >= this.pulseWidth) {
        this.positive = false;
        return -1;
      }
      return 1;
    }
    if (reduced < this.pulseWidth) {
      this.positive = true;
      return 1;
    }
    return -1;
  }
}

/** `minstd_rand`'s constants — the generator `dsp/noise.hpp NoiseGenerator`
 *  actually uses, kept so the sequence is theirs even though the SEED is ours. */
const MINSTD_MULTIPLIER = 48271;
const MINSTD_MODULUS = 2 ** 31 - 1;

/**
 * Pure function. One step of `minstd_rand`. Seed 0 is a fixed point of this
 * recurrence, so callers offset it (see `steppedRandomTable`).
 *
 * @param {number} state - the current state, 1…2^31−2
 * @returns {number} the next state
 *
 * @example minstdNext(1) // 48271
 * @example minstdNext(48271) // 182605794
 */
export function minstdNext(state) {
  return (state * MINSTD_MULTIPLIER) % MINSTD_MODULUS;
}

/** `SteppedRandomOscillator`'s table size and its "prime less than _n" stride. */
const STEPPED_TABLE_LENGTH = 4096;
const STEPPED_TABLE_STRIDE = 4093;

/**
 * Pure function. `dsp/oscillator.cpp SteppedRandomOscillator`'s table, filled
 * from `minstd_rand` off OUR seed instead of their global `Seeds` (D5).
 *
 * @param {number} seed - any non-negative integer; the same seed is the same table
 * @returns {Float32Array} STEPPED_TABLE_LENGTH values in [−1, 1)
 *
 * @example steppedRandomTable(0).length // 4096
 * @example steppedRandomTable(7)[0] === steppedRandomTable(7)[0] // true (reproducible)
 * @example steppedRandomTable(1)[0] !== steppedRandomTable(2)[0] // true
 */
export function steppedRandomTable(seed) {
  const table = new Float32Array(STEPPED_TABLE_LENGTH);
  let state = (Math.trunc(Math.abs(seed)) % (MINSTD_MODULUS - 1)) + 1;
  for (let i = 0; i < STEPPED_TABLE_LENGTH; i++) {
    state = minstdNext(state);
    table[i] = (state / MINSTD_MODULUS) * 2 - 1;
  }
  return table;
}

/**
 * Pure function. `SteppedRandomOscillator::nextForPhase`'s index shuffle — the
 * cycle count folded through their `(seed + i + (seed + i) % k) % n`, which is
 * what stops the sequence being a plain walk through the table.
 *
 * @param {number} seed - the oscillator's seed
 * @param {number} cycle - the phasor's wrap count
 * @returns {number} a table index
 *
 * @example steppedRandomIndex(0, 0) // 0
 * @example steppedRandomIndex(0, 1) // 2
 * @example steppedRandomIndex(0, 4093) // 4093 % 4096 = 4093
 */
export function steppedRandomIndex(seed, cycle) {
  const i = seed + cycle;
  return (i + (i % STEPPED_TABLE_STRIDE)) % STEPPED_TABLE_LENGTH;
}

/** `dsp/filters/resample.hpp CICDecimator`'s defaults, as FMOp uses them. */
const CIC_STAGES = 4;
const OVERSAMPLE = 8;

/**
 * `CICDecimator` BY ITS TRANSFER FUNCTION rather than by its integer form (D6):
 * four cascaded length-`factor` boxcar SUMS over the oversampled stream, read on
 * the last sub-sample of each block, divided by `factor^stages`.
 *
 * Their int64 version needs wraparound to keep its never-reset integrators
 * bounded; float has none, so a literal port drifts to infinity. This computes
 * the same filter with bounded state. `tests/port_vc3a_test.js` measures the two
 * against each other with a BigInt model, which is what makes the swap a fact.
 *
 * Command.
 */
export class BoxcarDecimator {
  constructor(stages = CIC_STAGES, factor = OVERSAMPLE) {
    this.factor = factor;
    this.gainCorrection = 1 / factor ** stages;
    this.buffers = [];
    this.sums = new Float64Array(stages);
    this.cursor = 0;
    for (let s = 0; s < stages; s++) this.buffers.push(new Float64Array(factor));
  }

  /** Command. One decimated output from `factor` input samples. */
  next(buffer) {
    let out = 0;
    for (let i = 0; i < this.factor; i++) {
      let value = buffer[i];
      for (let s = 0; s < this.buffers.length; s++) {
        const ring = this.buffers[s];
        this.sums[s] += value - ring[this.cursor];
        ring[this.cursor] = value;
        value = this.sums[s];
      }
      this.cursor = (this.cursor + 1) % this.factor;
      out = value;
    }
    return this.gainCorrection * out;
  }
}

/** `dsp/envelope.cpp ADSR::setLinearShape` — (attack, decay, release) exponents.
 *  The NON-linear default is not a simple exponential: attack is a SQUARE ROOT
 *  (fast then easing) while decay and release are squares. */
const ADSR_SHAPES_CURVED = [0.5, 2, 2];
const ADSR_SHAPES_LINEAR = [1, 1, 1];

/** `ADSR::setAttack` and friends floor every segment at 1 ms. */
const ADSR_MIN_SECONDS = 0.001;

/** `dsp/envelope.hpp ADSR::Stage`, in their enum order — a readout can name the
 *  stage without a second table. */
export const ADSR_STAGES = ["stopped", "attack", "decay", "sustain", "release"];

/**
 * `dsp/envelope.cpp ADSR` — Bogaudio's SHAPED envelope, and the thing the brief
 * warns is neither linear nor a simple exponential.
 *
 * The recurrence, per sample, with `p` the stage's elapsed seconds:
 *
 *   attack   env = min(1, p/A) ^ attackShape
 *   decay    env = (1 − min(1, p/D)) ^ decayShape · (1 − S) + S
 *   sustain  env = S
 *   release  env = (1 − min(1, p/R)) ^ releaseShape · releaseLevel
 *
 * so with the curved default (0.5, 2, 2) the attack is a square root and the
 * decay/release are squares. TWO CONSEQUENCES worth knowing before changing it:
 * the attack ends when `env >= 1` (not when `p >= A`), and RE-GATING out of
 * release re-enters attack at `p = A · env^releaseShape`, which is why a fast
 * retrigger does not click.
 *
 * Command.
 */
export class AdsrEnvelope {
  constructor(sampleRate, linear) {
    this.sampleTime = 1 / sampleRate;
    this.setLinearShape(linear);
    this.attack = ADSR_MIN_SECONDS;
    this.decay = ADSR_MIN_SECONDS;
    this.sustain = 1;
    this.release = ADSR_MIN_SECONDS;
    this.reset();
  }

  /** Command. `ADSR::reset`. */
  reset() {
    this.stage = 0;
    this.gated = false;
    this.envelope = 0;
    this.stageProgress = 0;
    this.releaseLevel = 0;
  }

  /** Command. `ADSR::setLinearShape`. */
  setLinearShape(linear) {
    const shapes = linear ? ADSR_SHAPES_LINEAR : ADSR_SHAPES_CURVED;
    this.attackShape = shapes[0];
    this.decayShape = shapes[1];
    this.releaseShape = shapes[2];
  }

  /** Command. `ADSR::setGate`. */
  setGate(high) {
    this.gated = high;
  }

  /** Command. Stage times in seconds, floored at 1 ms exactly as theirs. */
  setTimes(attack, decay, sustain, release) {
    this.attack = Math.max(attack, ADSR_MIN_SECONDS);
    this.decay = Math.max(decay, ADSR_MIN_SECONDS);
    this.sustain = sustain;
    this.release = Math.max(release, ADSR_MIN_SECONDS);
  }

  /** Query. Is the envelope in this stage? `ADSR::isStage`. */
  isStage(name) {
    return ADSR_STAGES[this.stage] === name;
  }

  /** Command. `ADSR::_next` — one sample. */
  next() {
    const [STOPPED, ATTACK, DECAY, SUSTAIN, RELEASE] = [0, 1, 2, 3, 4];
    if (this.gated) {
      if (this.stage === STOPPED) {
        this.stage = ATTACK;
        this.stageProgress = 0;
      } else if (this.stage === ATTACK) {
        if (this.envelope >= 1) {
          this.stage = DECAY;
          this.stageProgress = 0;
        }
      } else if (this.stage === DECAY) {
        if (this.stageProgress >= this.decay) {
          this.stage = SUSTAIN;
          this.stageProgress = 0;
        }
      } else if (this.stage === RELEASE) {
        this.stage = ATTACK;
        this.stageProgress = this.attack * this.envelope ** this.releaseShape;
      }
    } else if (this.stage === ATTACK || this.stage === DECAY || this.stage === SUSTAIN) {
      this.stage = RELEASE;
      this.stageProgress = 0;
      this.releaseLevel = this.envelope;
    } else if (this.stage === RELEASE && this.stageProgress >= this.release) {
      this.stage = STOPPED;
    }

    if (this.stage === STOPPED) {
      this.envelope = 0;
    } else if (this.stage === ATTACK) {
      this.stageProgress += this.sampleTime;
      this.envelope = Math.min(1, this.stageProgress / this.attack) ** this.attackShape;
    } else if (this.stage === DECAY) {
      this.stageProgress += this.sampleTime;
      this.envelope = (1 - Math.min(1, this.stageProgress / this.decay)) ** this.decayShape;
      this.envelope *= 1 - this.sustain;
      this.envelope += this.sustain;
    } else if (this.stage === SUSTAIN) {
      this.envelope = this.sustain;
    } else {
      this.stageProgress += this.sampleTime;
      this.envelope = (1 - Math.min(1, this.stageProgress / this.release)) ** this.releaseShape;
      this.envelope *= this.releaseLevel;
    }
    return this.envelope;
  }
}

// ── THE NINE KERNELS ────────────────────────────────────────────────────────

/** FMOp's `static constexpr` block: output amplitude in volts (which is exactly
 *  our one unit), the oversampling factor, and how fast the anti-alias path
 *  crossfades in. */
const FM_AMPLITUDE_VOLTS = 5;
const OVERSAMPLE_MIX_INCREMENT = 0.01;

/** `FMOp::sampleRateChange`: the frequency clamp, and the four slew times in ms. */
const FM_MAX_FREQUENCY_RATIO = 0.475;
const FM_FEEDBACK_SLEW_MS = 5;
const FM_DEPTH_SLEW_MS = 5;
const FM_LEVEL_SLEW_MS = 10;
const FM_SUSTAIN_SLEW_MS = 1;

/** `FMOp::processChannel`'s two thresholds: below `FM_SILENCE_LEVEL` the whole
 *  oscillator is skipped, and below `FM_ACTIVE_THRESHOLD` a feedback or depth
 *  amount does not count as "on" for the anti-alias decision. */
const FM_SILENCE_LEVEL = 0.0001;
const FM_ACTIVE_THRESHOLD = 0.001;

/** `FMOp::modulateChannel`: `frequency += FINE_PARAM / 12` where FINE is ±1, so
 *  the knob spans ±100 cents and one volt is 1200 cents. */
const CENTS_PER_VOLT = 1200;

/** `FMOp::LevelParamQuantity`'s two responses, in menu order. `exponential` is
 *  the DEFAULT (`_linearLevel = false`): the level knob is mapped through
 *  `Amplifier`'s decibel table, not multiplied straight in. */
export const FM_LEVEL_RESPONSES = ["exponential", "linear"];

/** An on/off knob's options, in the order Bogaudio's buttons read (0 then 1). */
export const OFF_ON = ["off", "on"];

/**
 * `Bogaudio-FMOp` — `src/FMOp.cpp` (`modulate`, `modulateChannel`,
 * `processChannel`) over `src/dsp/oscillator.cpp` (`Phasor`, `TablePhasor`),
 * `src/dsp/envelope.cpp` (`ADSR`), `src/dsp/signal.cpp` (`SlewLimiter`,
 * `Amplifier`) and `src/dsp/filters/resample.cpp` (`CICDecimator`).
 *
 * ── WHAT IT IS ──────────────────────────────────────────────────────────────
 * ONE FM operator: a sine oscillator whose phase is offset by its own last output
 * (feedback) and by an external signal (depth), with a built-in ADSR that can be
 * routed to any of level, feedback and depth. Eight of these are the metallic
 * layer of P5 and P20 is built entirely from them.
 *
 * ── THE PHASE OFFSET IS IN RADIANS, AND THAT IS THE FM INDEX (the hard part) ─
 * Both modulation paths land on ONE quantity, an offset added to the phasor's
 * phase before the table is read:
 *
 *   offset_radians = feedback · lastOutputVolts + fmVolts · depth · 2
 *   o              = radiansToPhase(offset_radians)
 *
 * So `feedback` and `depth` are NOT normalised the way a Yamaha operator's are —
 * they are gains on a RADIAN offset, and the volts make the scale:
 *
 *   · FEEDBACK reads `feedbackDelayedSample`, which is the LAST OUTPUT IN VOLTS
 *     (`amplitude · sample`, so ±5 V at full level). Feedback 1.0 therefore means
 *     up to ±5 RADIANS of self-modulation — 0.8 of a cycle, deep into chaos.
 *   · DEPTH reads the FM input in volts and DOUBLES it. A ±5 V modulator at depth
 *     1.0 is a modulation index of β = 10; at depth 0.1 it is β = 1. In OUR units
 *     that is `β = 2 · 5 · A_units · depth`. `tests/port_vc3a_test.js` measures
 *     the Bessel sidebands of exactly that, because a wrong index is the one
 *     error in this module that would leave every FM patch sounding plausible.
 *
 * ── AND THE ANTI-ALIAS PATH, WHICH IS THE DEFAULT ───────────────────────────
 * With feedback or external FM active, the oscillator runs at 8× and comes back
 * through a 4-stage CIC decimator (D6); `oversampleMix` crossfades between the
 * two paths at 0.01 per sample so switching does not click. The phasor is set to
 * `frequency / 8` and advanced 8 times, so BOTH paths advance the same total
 * phase — which is why turning feedback down does not shift the pitch.
 *
 * Deviations: D1, D2 (depth gates the anti-alias path without a connectedness
 * signal), D3 (ratio/fine/times in displayed units), D7.
 * REPRODUCED, NOT FIXED: their envelope is constructed `ADSR(true)` — LINEAR
 * shapes — unlike the ADSR module's curved default. An FM index envelope that
 * eased like the ADSR module's would be a different instrument.
 *
 * Command.
 */
export class FmOpKernel {
  constructor(sampleRate, options = {}) {
    this.sampleRate = sampleRate;
    this.maxFrequency = FM_MAX_FREQUENCY_RATIO * sampleRate;
    this.envelope = new AdsrEnvelope(sampleRate, true);
    this.gateTrigger = new SchmittTrigger();
    this.phasor = new Phasor();
    this.decimator = new BoxcarDecimator();
    this.feedbackSL = new SlewLimiter(sampleRate, FM_FEEDBACK_SLEW_MS, 1);
    this.depthSL = new SlewLimiter(sampleRate, FM_DEPTH_SLEW_MS, 1);
    this.levelSL = new SlewLimiter(sampleRate, FM_LEVEL_SLEW_MS, 1);
    this.sustainSL = new SlewLimiter(sampleRate, FM_SUSTAIN_SLEW_MS, 1);
    this.buffer = new Float64Array(OVERSAMPLE);
    this.oversampleMix = 0;
    this.feedbackDelayedVolts = 0;
    this.feedback = 0;
    this.depth = 0;
    this.level = 0;
    this.envelopeOn = false;
    this.outputCount = 1;
    this.setOscillator(options.oscillator ?? SINE_INTERPOLATIONS[0]);
    this.setLevelResponse(options.levelResponse ?? FM_LEVEL_RESPONSES[0]);
    this.setEnvToLevel(options.envToLevel ?? OFF_ON[0]);
    this.setEnvToFeedback(options.envToFeedback ?? OFF_ON[0]);
    this.setEnvToDepth(options.envToDepth ?? OFF_ON[0]);
    this.setAntialiasFeedback(options.antialiasFeedback ?? OFF_ON[1]);
    this.setAntialiasFm(options.antialiasFm ?? OFF_ON[1]);
  }

  /** Command. "classic" is their non-interpolated table read (the default). */
  setOscillator(name) {
    this.interpolate = pickOption("FMOp oscillator", name, SINE_INTERPOLATIONS) === 1;
  }

  /** Command. Level through the decibel table, or straight multiplication. */
  setLevelResponse(name) {
    this.linearLevel = pickOption("FMOp level response", name, FM_LEVEL_RESPONSES) === 1;
  }

  /** Command. `ENV_TO_LEVEL_PARAM`. */
  setEnvToLevel(name) {
    this.levelEnvelopeOn = pickOption("FMOp env to level", name, OFF_ON) === 1;
  }

  /** Command. `ENV_TO_FEEDBACK_PARAM`. */
  setEnvToFeedback(name) {
    this.feedbackEnvelopeOn = pickOption("FMOp env to feedback", name, OFF_ON) === 1;
  }

  /** Command. `ENV_TO_DEPTH_PARAM`. */
  setEnvToDepth(name) {
    this.depthEnvelopeOn = pickOption("FMOp env to depth", name, OFF_ON) === 1;
  }

  /** Command. `_antiAliasFeedback`. */
  setAntialiasFeedback(name) {
    this.antialiasFeedback = pickOption("FMOp antialias feedback", name, OFF_ON) === 1;
  }

  /** Command. `_antiAliasDepth`. */
  setAntialiasFm(name) {
    this.antialiasFm = pickOption("FMOp antialias fm", name, OFF_ON) === 1;
  }

  control(c) {
    const volts = c.pitch * OCTAVES_PER_UNIT + c.fine / CENTS_PER_VOLT;
    const frequency = clamp(cvToFrequency(volts) * c.ratio, -this.maxFrequency, this.maxFrequency);
    this.phasor.setFrequency(frequency / OVERSAMPLE, this.sampleRate);

    const envelopeOn = this.levelEnvelopeOn || this.feedbackEnvelopeOn || this.depthEnvelopeOn;
    if (envelopeOn && !this.envelopeOn) this.envelope.reset();
    this.envelopeOn = envelopeOn;
    if (envelopeOn) {
      this.envelope.setTimes(
        c.attack,
        c.decay,
        this.sustainSL.next(c.sustain * unipolarCv(c.sustain_cv)),
        c.release,
      );
    }

    this.feedback = c.feedback * unipolarCv(c.feedback_cv);
    this.depth = c.depth * unipolarCv(c.depth_cv);
    this.level = c.level * unipolarCv(c.level_cv);
  }

  sample(c, out) {
    let envelope = 0;
    if (this.envelopeOn) {
      this.gateTrigger.process(c.gate);
      this.envelope.setGate(this.gateTrigger.isHigh());
      envelope = this.envelope.next();
    }

    let feedback = this.feedbackSL.next(this.feedback);
    if (this.feedbackEnvelopeOn) feedback *= envelope;
    const feedbackOn = feedback > FM_ACTIVE_THRESHOLD;

    let level = this.levelSL.next(this.level);
    if (this.levelEnvelopeOn) level *= envelope;

    let offsetRadians = feedbackOn ? feedback * this.feedbackDelayedVolts : 0;
    let depth = this.depthSL.next(this.depth);
    if (this.depthEnvelopeOn) depth *= envelope;
    offsetRadians += c.fm * VOLTS_PER_UNIT * depth * 2;
    const depthOn = depth > FM_ACTIVE_THRESHOLD;

    let sample = 0;
    if (level > FM_SILENCE_LEVEL) {
      const o = radiansToPhase(offsetRadians);
      if ((feedbackOn && this.antialiasFeedback) || (depthOn && this.antialiasFm)) {
        if (this.oversampleMix < 1) this.oversampleMix += OVERSAMPLE_MIX_INCREMENT;
      } else if (this.oversampleMix > 0) {
        this.oversampleMix -= OVERSAMPLE_MIX_INCREMENT;
      }

      if (this.oversampleMix > 0) {
        for (let i = 0; i < OVERSAMPLE; i++) {
          this.phasor.advance(1);
          this.buffer[i] = tableSine(this.phasor.phase + o, this.interpolate);
        }
        sample = this.oversampleMix * this.decimator.next(this.buffer);
      } else {
        this.phasor.advance(OVERSAMPLE);
      }
      if (this.oversampleMix < 1) {
        sample += (1 - this.oversampleMix) * tableSine(this.phasor.phase + o, this.interpolate);
      }

      if (this.linearLevel) sample *= level;
      else sample = amplifierLevel((1 - level) * MIN_DECIBELS) * sample;
    } else {
      this.phasor.advance(OVERSAMPLE);
    }

    this.feedbackDelayedVolts = FM_AMPLITUDE_VOLTS * sample;
    out[0] = this.feedbackDelayedVolts / VOLTS_PER_UNIT;
  }
}

/** `LFO.hpp`: the LFO's own output amplitude in volts, and `lfo_base.cpp`'s two
 *  pitch offsets — normal and slow — which D4 folds into the frequency knob. */
const LFO_AMPLITUDE_VOLTS = 5;
export const LFO_PITCH_OFFSET_NORMAL = -3 - 4;
export const LFO_PITCH_OFFSET_SLOW = -3 - 8;

/** `LFOBase::setFrequency`'s hard cap, and `LFO::updateOutput`'s output clamp. */
const LFO_MAX_HZ = 2000;
const LFO_CLAMP_VOLTS = 12;

/** `LFOBase::Smoother::setParams`: the slew's shaping exponent, and the `×10` on
 *  its time so the knob's top end can smooth a whole half cycle. */
const LFO_SMOOTH_SHAPE = 0.5;
const LFO_SMOOTH_TIME_SCALE = 10;

/** `LFO::modulateChannel`: sampling divides the cycle into at most a quarter. */
const LFO_MAX_SAMPLE_FRACTION = 4;

/** `lfo_base.cpp`'s offset range menu, in menu order: ±5 V then ±10 V. */
export const LFO_OFFSET_RANGES = ["5v", "10v"];

/** `LFO`'s `offset_cv_to_smoothing` JSON field, as a two-way choice: which knob
 *  the ONE offset CV input scales. */
export const LFO_OFFSET_CV_TARGETS = ["offset", "smooth"];

/** Which of the six outputs `LFO::processChannel` allows the SAMPLE hold to act
 *  on, in output order. Square and stepped are excluded there by passing
 *  `useSample = false` at the call site; this array is that call site. */
const LFO_HOLDABLE = Object.freeze([true, true, false, true, true, false]);

/**
 * `Bogaudio-LFO` — `src/LFO.cpp` + `src/lfo_base.cpp` over
 * `src/dsp/oscillator.cpp` (`Phasor`, `TablePhasor`, `TriangleOscillator`,
 * `SawOscillator`, `SquareOscillator`, `SteppedRandomOscillator`) and
 * `src/dsp/signal.cpp` (`ShapedSlewLimiter`, `PositiveZeroCrossing`).
 *
 * SIX OUTPUTS FROM ONE ACCUMULATOR, and that is the module's whole point: ramp
 * up, ramp down, square, triangle, sine and stepped random are all read from the
 * SAME phase, so they are phase-locked to each other forever. Wiring two of them
 * into different destinations is how one LFO becomes a whole modulation section.
 *
 *   f = cvToFrequency(knobVolts + pitchVolts) capped at 2000 Hz
 *   out = clamp(smooth(wave(phase) · 5 V · scale + offset), ±12 V)
 *
 * `sample` DECIMATES every continuous output by holding it for up to a quarter
 * cycle (square and stepped are exempt — they are already stepped); `smooth`
 * shapes the steps back out again with a slew whose time is set from the CURRENT
 * frequency, so it stays proportional as the rate changes.
 *
 * Deviations: D1, D2, D4 (`slow` folded into the frequency knob), D5 (the stepped
 * output's table is seeded), D7.
 *
 * Command.
 */
export class BogLfoKernel {
  constructor(sampleRate, options = {}) {
    this.sampleRate = sampleRate;
    this.phasor = new Phasor();
    this.square = new SquareWave();
    this.resetTrigger = new PositiveZeroCrossing();
    this.smoothers = [];
    this.samples = new Float64Array(LFO_HOLDABLE.length);
    this.waves = new Float64Array(LFO_HOLDABLE.length);
    for (let i = 0; i < this.samples.length; i++) this.smoothers.push(new ShapedSlewLimiter());
    this.steppedTable = steppedRandomTable(options.seed ?? 0);
    this.steppedSeed = Math.trunc(Math.abs(options.seed ?? 0));
    this.sampleSteps = 1;
    // `LFO::Engine::reset` really does `sampleStep = phasor._sampleRate` — an int
    // assigned a sample rate, which just means "larger than any step count", so the
    // first sample resets the counter instead of holding. Ported literally: a 0 here
    // would put the hold pattern one sample out of phase with theirs forever.
    this.sampleStep = sampleRate;
    this.offset = 0;
    this.scale = 0;
    this.smooth = 0;
    this.started = false;
    this.outputCount = LFO_HOLDABLE.length;
    this.setOffsetRange(options.offsetRange ?? LFO_OFFSET_RANGES[0]);
    this.setOffsetCvTarget(options.offsetCvTarget ?? LFO_OFFSET_CV_TARGETS[0]);
  }

  /** Command. `_offsetScale` — 1 for ±5 V, 2 for ±10 V. */
  setOffsetRange(name) {
    this.offsetScale = pickOption("LFO offset range", name, LFO_OFFSET_RANGES) + 1;
  }

  /** Command. `_useOffsetCvForSmooth`. */
  setOffsetCvTarget(name) {
    this.offsetCvToSmooth = pickOption("LFO offset CV target", name, LFO_OFFSET_CV_TARGETS) === 1;
  }

  control(c) {
    // `LFOBase::setFrequency`: `cvToFrequency(knobCv + pitchVolts)`, capped. The
    // knob already carries HERTZ (D3/D4), and adding volts to a CV is
    // multiplying its frequency by 2^volts — so the exponential is the pitch
    // input's alone and the knob needs no round trip through a logarithm.
    const frequency = Math.min(c.frequency * 2 ** (c.pitch * OCTAVES_PER_UNIT), LFO_MAX_HZ);
    this.phasor.setFrequency(frequency, this.sampleRate);

    let pw = c.pw * bipolarCv(c.pw_cv);
    pw *= 1 - 2 * this.square.minPulseWidth;
    pw *= 0.5;
    pw += 0.5;
    this.square.setPulseWidth(pw);

    const sampleAmount = c.sample * unipolarCv(c.sample_cv);
    const maxSampleSteps = (this.sampleRate / Math.max(frequency, Number.MIN_VALUE)) / LFO_MAX_SAMPLE_FRACTION;
    this.sampleSteps = clamp(Math.trunc(sampleAmount * maxSampleSteps), 1, Math.max(1, Math.trunc(maxSampleSteps)));

    let smooth = c.smooth;
    if (this.offsetCvToSmooth) smooth *= unipolarCv(c.offset_cv);
    const milliseconds = ((1 / Math.max(frequency, Number.MIN_VALUE)) / 2) * 1000 * (smooth * smooth * LFO_SMOOTH_TIME_SCALE);
    for (const smoother of this.smoothers) smoother.setParams(this.sampleRate, milliseconds, LFO_SMOOTH_SHAPE);

    let offset = c.offset;
    if (!this.offsetCvToSmooth) offset *= bipolarCv(c.offset_cv);
    this.offset = (offset * this.offsetScale * LFO_AMPLITUDE_VOLTS) / VOLTS_PER_UNIT;
    this.scale = c.scale * unipolarCv(c.scale_cv);
  }

  sample(c, out) {
    if (this.resetTrigger.next(c.reset)) this.phasor.resetPhase();
    this.phasor.advance(1);

    let useSample = false;
    if (this.sampleSteps > 1) {
      this.sampleStep += 1;
      if (this.sampleStep >= this.sampleSteps) this.sampleStep = 0;
      else useSample = this.started;
    }

    const amplitude = (LFO_AMPLITUDE_VOLTS / VOLTS_PER_UNIT) * this.scale;
    const phase = this.phasor.phase;
    const cycle = this.phasor.cycle;
    // Their output order (the `OutputsIds` enum): ramp up, ramp down, square,
    // triangle, sine, stepped. Written into a preallocated buffer rather than a
    // literal array — this runs per sample on the audio thread.
    this.waves[0] = tableSaw(phase);
    this.waves[1] = -this.waves[0];
    this.waves[2] = this.square.valueAt(phase, cycle);
    this.waves[3] = tableTriangle(phase);
    this.waves[4] = tableSine(phase, false);
    this.waves[5] = this.steppedTable[steppedRandomIndex(this.steppedSeed, cycle)];
    const limit = LFO_CLAMP_VOLTS / VOLTS_PER_UNIT;
    for (let i = 0; i < this.waves.length; i++) {
      // `updateOutput`'s useSample is FALSE for square and stepped: both are
      // already stepped, so holding them would only lengthen a step at random.
      if (!(useSample && LFO_HOLDABLE[i])) this.samples[i] = this.waves[i] * amplitude + this.offset;
      out[i] = clamp(this.smoothers[i].next(this.samples[i]), -limit, limit);
    }
    this.started = true;
  }
}

/** `ADSR.cpp`: the envelope output is `env · 10 V`, and `_invert` is ±1. */
const ADSR_OUTPUT_VOLTS = 10;

/** `ADSR`'s two shape modes and its invert option, in menu order. */
export const ADSR_SHAPE_MODES = ["logarithmic", "linear"];
export const ADSR_POLARITIES = ["normal", "inverted"];

/**
 * `Bogaudio-ADSR` — `src/ADSR.cpp` (`modulateChannel`, `processChannel`) over
 * `src/dsp/envelope.cpp` (`ADSR`, whose curve AdsrEnvelope documents).
 *
 * A plain ADSR whose default shape is CURVED (attack √, decay and release
 * squared), unlike FMOp's linear one. `linear` switches to straight lines;
 * `polarity` inverts the output, which is their context-menu `invert` field.
 *
 *   out = env · 10 V · ±1
 *
 * Deviations: D3 (times in seconds), D7.
 *
 * Command.
 */
export class BogAdsrKernel {
  constructor(sampleRate, options = {}) {
    this.envelope = new AdsrEnvelope(sampleRate, false);
    this.gateTrigger = new SchmittTrigger();
    this.outputCount = 1;
    this.setShape(options.shape ?? ADSR_SHAPE_MODES[0]);
    this.setPolarity(options.polarity ?? ADSR_POLARITIES[0]);
  }

  /** Command. `LINEAR_PARAM`. */
  setShape(name) {
    this.linear = pickOption("ADSR shape", name, ADSR_SHAPE_MODES) === 1;
    this.envelope.setLinearShape(this.linear);
  }

  /** Command. `_invert`. */
  setPolarity(name) {
    this.invert = pickOption("ADSR polarity", name, ADSR_POLARITIES) === 1 ? -1 : 1;
  }

  control(c) {
    this.envelope.setTimes(c.attack, c.decay, c.sustain, c.release);
    this.envelope.setLinearShape(this.linear);
  }

  sample(c, out) {
    this.gateTrigger.process(c.gate);
    this.envelope.setGate(this.gateTrigger.isHigh());
    out[0] = (this.envelope.next() * ADSR_OUTPUT_VOLTS * this.invert) / VOLTS_PER_UNIT;
  }
}

/** `dadsrh_core.cpp step`: the shape exponent pair, the output scaling, the
 *  end-of-cycle pulse width and the level at which release counts as finished. */
const DADSRH_SHAPE_EXPONENT = 2;
const DADSRH_INVERSE_SHAPE_EXPONENT = 0.5;
const DADSRH_OUTPUT_VOLTS = 10;
const DADSRH_STAGE_GATE_VOLTS = 5;
const DADSRH_END_PULSE_SECONDS = 0.001;
const DADSRH_RELEASE_FLOOR = 0.001;

/** Their non-delay stage floor: `fmaxf(t, 0.001) · 10`, so 10 ms in seconds. */
const DADSRH_MIN_STAGE_SECONDS = 0.01;

/** `DADSRH`'s three shape switches, in the order their labels read for ATTACK
 *  (`{Logarithmic, Linear, Exponential}`). DECAY and RELEASE use the same three
 *  exponents with the outer two SWAPPED — that is theirs, not a slip: shape 1 is
 *  the "fast then slow" end of each stage, which is logarithmic rising and
 *  exponential falling. */
export const DADSRH_ATTACK_SHAPES = ["logarithmic", "linear", "exponential"];
export const DADSRH_FALL_SHAPES = ["exponential", "linear", "logarithmic"];

/** `MODE_PARAM`, `LOOP_PARAM` and `RETRIGGER_PARAM`, each in its label order. */
export const DADSRH_MODES = ["triggered", "gated"];
export const DADSRH_LOOPS = ["loop", "stop"];
export const DADSRH_RETRIGGERS = ["reset", "resume"];

/** DADSRH's stage names, in `DADSRHCore::Stage` order. */
export const DADSRH_STAGES = ["stopped", "delay", "attack", "decay", "sustain", "release"];

/**
 * `Bogaudio-DADSRH` — `src/DADSRH.cpp` + `src/dadsrh_core.cpp` (`step`,
 * `stepAmount`, `knobTime`, `knobAmount`). NOT built on `dsp/envelope.cpp`: this
 * is its own envelope with a DELAY before the attack, a HOLD that ends the
 * sustain by itself, three per-stage shapes and two retrigger behaviours.
 *
 * ── WHY HOLD AND MODE INTERACT, WHICH IS THE MODULE'S REAL SUBTLETY ─────────
 * `hold` is a timer that runs from the START of the delay stage and forces the
 * release when it expires. In `triggered` mode that timer is what ends the note,
 * so the envelope is fire-and-forget; in `gated` mode the GATE ends it and the
 * hold is irrelevant — except that the timer keeps accumulating anyway, "in case
 * we switch mid-cycle" (their comment), so flipping the switch mid-note does the
 * right thing. Both are ported, including the accumulation.
 *
 * `retrigger: resume` re-enters the attack at the phase matching the CURRENT
 * envelope level (inverting the attack shape) and rewinds `hold` to where it
 * would have been then, so a retriggered note has the same shape as a fresh one.
 * `loop` restarts from delay when the release finishes — that is how this module
 * becomes an LFO with a shape.
 *
 * Deviations: D3, D4 (`speed` folded into the time knobs, so they reach 100 s),
 * D7, D8 (their five per-stage gate outputs are not ported — the three that
 * carry a value are: env, inv and the end-of-cycle trigger).
 *
 * Command.
 */
export class DadsrhKernel {
  constructor(sampleRate, options = {}) {
    this.sampleTime = 1 / sampleRate;
    this.trigger = new SchmittTrigger();
    this.endPulse = new PulseGenerator();
    this.stage = 0;
    this.envelope = 0;
    this.stageProgress = 0;
    this.holdProgress = 0;
    this.releaseLevel = 0;
    this.outputCount = 3;
    this.setAttackShape(options.attackShape ?? DADSRH_ATTACK_SHAPES[0]);
    this.setDecayShape(options.decayShape ?? DADSRH_FALL_SHAPES[0]);
    this.setReleaseShape(options.releaseShape ?? DADSRH_FALL_SHAPES[0]);
    this.setMode(options.mode ?? DADSRH_MODES[1]);
    this.setLoop(options.loop ?? DADSRH_LOOPS[1]);
    this.setRetrigger(options.retrigger ?? DADSRH_RETRIGGERS[1]);
  }

  /** Command. `ATTACK_SHAPE_PARAM` — 1, 2 or 3 in their switch. */
  setAttackShape(name) {
    this.attackShape = pickOption("DADSRH attack shape", name, DADSRH_ATTACK_SHAPES) + 1;
  }

  /** Command. `DECAY_SHAPE_PARAM`. */
  setDecayShape(name) {
    this.decayShape = pickOption("DADSRH decay shape", name, DADSRH_FALL_SHAPES) + 1;
  }

  /** Command. `RELEASE_SHAPE_PARAM`. */
  setReleaseShape(name) {
    this.releaseShape = pickOption("DADSRH release shape", name, DADSRH_FALL_SHAPES) + 1;
  }

  /** Command. `MODE_PARAM` — gated holds while the trigger is high. */
  setMode(name) {
    this.gateMode = pickOption("DADSRH mode", name, DADSRH_MODES) === 1;
  }

  /** Command. `LOOP_PARAM` — "loop" restarts when the release finishes. */
  setLoop(name) {
    this.looping = pickOption("DADSRH loop", name, DADSRH_LOOPS) === 0;
  }

  /** Command. `RETRIGGER_PARAM`. */
  setRetrigger(name) {
    this.resumeAttack = pickOption("DADSRH retrigger", name, DADSRH_RETRIGGERS) === 1;
  }

  /** Command, and EMPTY ON PURPOSE: this module's C++ has no `modulate()`
   *  override, so Bogaudio reads its params every sample rather than every
   *  2.5 ms. Moving anything here would make a swept knob step. */
  control(c) {}

  /** Pure-ish helper (reads only its arguments). `dadsrh_core.cpp knobTime` with
   *  D4 applied: the knob already IS the time, so only their floor remains. */
  stageSeconds(seconds, allowZero) {
    return Math.max(seconds, allowZero ? 0 : DADSRH_MIN_STAGE_SECONDS);
  }

  /** Pure-ish helper. `stepAmount` — a stage's per-sample progress fraction. */
  stageStep(seconds, allowZero) {
    return this.sampleTime / this.stageSeconds(seconds, allowZero);
  }

  /** Command. `rise(p, shape)` — the attack's three curves. */
  rise(progress, shape) {
    if (shape === 2) return progress;
    if (shape === 3) return progress ** DADSRH_SHAPE_EXPONENT;
    return progress ** DADSRH_INVERSE_SHAPE_EXPONENT;
  }

  /** Command. `fall(p, shape)` — the decay's and release's three curves. */
  fall(progress, shape) {
    if (shape === 2) return 1 - progress;
    if (progress >= 1) return 0;
    if (shape === 3) return (1 - progress) ** DADSRH_INVERSE_SHAPE_EXPONENT;
    return (1 - progress) ** DADSRH_SHAPE_EXPONENT;
  }

  sample(c, out) {
    const [STOPPED, DELAY, ATTACK, DECAY, SUSTAIN, RELEASE] = [0, 1, 2, 3, 4, 5];
    if (this.trigger.process(c.trigger)) {
      if (this.stage === STOPPED || !this.resumeAttack) {
        this.stage = DELAY;
        this.holdProgress = 0;
        this.stageProgress = 0;
        this.envelope = 0;
      } else if (this.stage === DELAY) {
        this.stage = ATTACK;
        this.stageProgress = 0;
        this.envelope = 0;
        this.holdProgress = Math.min(1, this.stageSeconds(c.delay, true) / this.stageSeconds(c.hold, false));
      } else if (this.stage !== ATTACK) {
        this.stage = ATTACK;
        if (this.attackShape === 2) this.stageProgress = this.envelope;
        else if (this.attackShape === 3) this.stageProgress = this.envelope ** DADSRH_INVERSE_SHAPE_EXPONENT;
        else this.stageProgress = this.envelope ** DADSRH_SHAPE_EXPONENT;
        const delayTime = this.stageSeconds(c.delay, true);
        const attackTime = this.stageSeconds(c.attack, false);
        this.holdProgress = Math.min(1, (delayTime + this.stageProgress * attackTime) / this.stageSeconds(c.hold, false));
      }
    } else if (this.stage === DELAY || this.stage === ATTACK || this.stage === DECAY || this.stage === SUSTAIN) {
      let holdComplete = this.holdProgress >= 1;
      if (!holdComplete) {
        // Runs even in gate mode, "in case we switch mid-cycle" — their comment.
        this.holdProgress += this.stageStep(c.hold, false);
        holdComplete = this.holdProgress >= 1;
      }
      if (this.gateMode ? !this.trigger.isHigh() : holdComplete) {
        this.stage = RELEASE;
        this.stageProgress = 0;
        this.releaseLevel = this.envelope;
      }
    }

    let complete = false;
    if (this.stage === DELAY) {
      this.stageProgress += this.stageStep(c.delay, true);
      if (this.stageProgress >= 1) {
        this.stage = ATTACK;
        this.stageProgress = 0;
      }
    } else if (this.stage === ATTACK) {
      this.stageProgress += this.stageStep(c.attack, false);
      this.envelope = this.rise(this.stageProgress, this.attackShape);
      if (this.envelope >= 1) {
        this.stage = DECAY;
        this.stageProgress = 0;
      }
    } else if (this.stage === DECAY) {
      const sustainLevel = clamp(c.sustain, 0, 1);
      this.stageProgress += this.stageStep(c.decay, false);
      this.envelope = this.fall(this.stageProgress, this.decayShape);
      this.envelope *= 1 - sustainLevel;
      this.envelope += sustainLevel;
      if (this.envelope <= sustainLevel) this.stage = SUSTAIN;
    } else if (this.stage === SUSTAIN) {
      this.envelope = clamp(c.sustain, 0, 1);
    } else if (this.stage === RELEASE) {
      this.stageProgress += this.stageStep(c.release, false);
      this.envelope = this.fall(this.stageProgress, this.releaseShape) * this.releaseLevel;
      if (this.envelope <= DADSRH_RELEASE_FLOOR) {
        complete = true;
        this.envelope = 0;
        if (!this.gateMode && (this.looping || this.trigger.isHigh())) {
          this.stage = DELAY;
          this.holdProgress = 0;
          this.stageProgress = 0;
        } else {
          this.stage = STOPPED;
        }
      }
    }

    const envVolts = this.envelope * DADSRH_OUTPUT_VOLTS;
    if (complete) this.endPulse.trigger(DADSRH_END_PULSE_SECONDS);
    out[0] = envVolts / VOLTS_PER_UNIT;
    out[1] = (DADSRH_OUTPUT_VOLTS - envVolts) / VOLTS_PER_UNIT;
    out[2] = this.endPulse.process(this.sampleTime) ? DADSRH_STAGE_GATE_VOLTS / VOLTS_PER_UNIT : 0;
  }
}

/** `addressable_sequence.cpp`: the reset debounce, and the step count the
 *  `STEPS_PARAM` curve is written against. */
const SEQUENCE_RESET_DEBOUNCE_SECONDS = 0.001;
const SEQUENCE_LOCAL_STEPS = 8;

/** `AddrSeq`'s direction switch, in its label order. */
export const SEQUENCE_DIRECTIONS = ["reverse", "forward"];

/** `output_range.hpp`'s Range menu, in menu order, as `[offset, scale]`. The
 *  offset is added to the ±1 step knob BEFORE the scale, which is how the same
 *  ten entries express both bipolar and unipolar ranges. */
export const OUTPUT_RANGES = Object.freeze({
  "+/-10v": [0, 10],
  "+/-5v": [0, 5],
  "+/-3v": [0, 3],
  "+/-2v": [0, 2],
  "+/-1v": [0, 1],
  "0-10v": [1, 5],
  "0-5v": [1, 2.5],
  "0-3v": [1, 1.5],
  "0-2v": [1, 1],
  "0-1v": [1, 0.5],
});

/** Every OUTPUT_RANGES key, in declaration order — the spec's option list. */
export const OUTPUT_RANGE_NAMES = Object.freeze(Object.keys(OUTPUT_RANGES));

/**
 * `addressable_sequence.cpp AddressableSequenceModule::nextStep` — THE
 * addressed-sequencer core, shared by AddrSeq and EightOne, which is why it is a
 * class here rather than code in either kernel.
 *
 * ── ADDRESSED, NOT CLOCKED: THE TWO POSITIONS ARE INDEPENDENT ───────────────
 * `_step` advances on a clock (forward or reverse, wrapping at `steps`), and
 * `select` is an ABSOLUTE offset added to it. Their sum modulo 8 is the active
 * step. That is the module's whole idea: a clock walks the sequence while a CV
 * transposes WHICH part of it is being walked, so one sequencer is eight.
 *
 * Three of their context-menu fields change how that composes and all three are
 * ported: `triggeredSelect` makes the select input a step-advance rather than a
 * position, `selectOnClock` samples the select only on a clock edge (so a smooth
 * CV cannot slide between steps mid-note), and `wrapSelectAtSteps` wraps the sum
 * at `steps` instead of 8 (so a shortened sequence stays inside itself).
 *
 * A RESET SUPPRESSES A CLOCK FOR 1 ms (their `Timer`), because a reset and a
 * clock arriving together would otherwise advance past step 0.
 *
 * Command.
 */
export class AddressedSequence {
  constructor(sampleRate) {
    this.clock = new SchmittTrigger();
    this.negativeClock = new SchmittTrigger();
    this.resetTrigger = new SchmittTrigger();
    this.selectTrigger = new SchmittTrigger();
    this.timer = new Timer(sampleRate, SEQUENCE_RESET_DEBOUNCE_SECONDS);
    this.step = 0;
    this.select = 0;
  }

  /**
   * Command. One sample: which of `SEQUENCE_LOCAL_STEPS` is active now.
   *
   * @param {object} c - the control frame (clock, reset, select_cv, steps, select)
   * @param {object} flags - {forward, triggeredSelect, selectOnClock, wrapSelectAtSteps, reverseOnNegativeClock}
   * @returns {number} a step index, 0…7
   */
  next(c, flags) {
    const n = SEQUENCE_LOCAL_STEPS;
    const reset = this.resetTrigger.process(c.reset);
    if (reset) this.timer.reset();
    const timer = this.timer.next();
    const clocked = this.clock.process(c.clock) && !timer;
    const negativeClocked = this.negativeClock.process(-c.clock) && flags.reverseOnNegativeClock && !timer && !clocked;

    // Their `steps` curve maps a 1…8 knob onto 1…n; with no expander n IS 8, so
    // it is the identity — kept in this shape so an expander could change n.
    const s = clamp(c.steps, 1, SEQUENCE_LOCAL_STEPS);
    const steps = Math.trunc(((s - 1) / (SEQUENCE_LOCAL_STEPS - 1)) * (n - 1) + 1);

    const reverse = flags.forward ? 1 : -1;
    this.step = (this.step + reverse * (clocked ? 1 : 0) + -reverse * (negativeClocked ? 1 : 0)) % steps;
    if (this.step < 0) this.step += steps;
    if (reset) this.step = 0;

    let select = (clamp(c.select, 0, SEQUENCE_LOCAL_STEPS - 1) / (SEQUENCE_LOCAL_STEPS - 1)) * (n - 1);
    if (flags.triggeredSelect) {
      if (this.selectTrigger.process(c.select_cv)) {
        this.select = (1 + Math.trunc(this.select)) % (Math.trunc(select) + 1);
      }
      if (reset) this.select = 0;
    } else {
      select += (clamp(c.select_cv * VOLTS_PER_UNIT, -9.99, 9.99) / 10) * n;
      if (!flags.selectOnClock || clocked) this.select = select;
    }

    const modulus = flags.wrapSelectAtSteps ? steps : n;
    const active = (this.step + Math.trunc(this.select)) % modulus;
    return active < 0 ? n + active : active;
  }
}

/**
 * `Bogaudio-AddrSeq` — `src/AddrSeq.cpp processChannel` over
 * `src/addressable_sequence.cpp` (`nextStep`, in AddressedSequence above) and
 * `src/output_range.hpp` (the Range menu).
 *
 * Eight step knobs, an addressed position, and one output:
 *
 *   out = (step[active] + rangeOffset) · rangeScale volts
 *
 * Nine of these are P5's modulation farm and four are in P14 — which is exactly
 * why the `select` path matters more than the step values: with `select` on a
 * slow CV, one AddrSeq produces a sequence whose PHRASE moves, and no two of the
 * nine land on the same pattern.
 *
 * Deviations: D1, D7 (no `poly_input`), D8 (no step lights), D9 (no AddrSeqX).
 *
 * Command.
 */
export class AddrSeqKernel {
  constructor(sampleRate, options = {}) {
    this.sequence = new AddressedSequence(sampleRate);
    this.stepKeys = numberedKeys("step", SEQUENCE_LOCAL_STEPS);
    this.outputCount = 1;
    this.flags = { forward: true, triggeredSelect: false, selectOnClock: false, wrapSelectAtSteps: false, reverseOnNegativeClock: false };
    this.setDirection(options.direction ?? SEQUENCE_DIRECTIONS[1]);
    this.setRange(options.range ?? OUTPUT_RANGE_NAMES[0]);
    this.setTriggeredSelect(options.triggeredSelect ?? OFF_ON[0]);
    this.setSelectOnClock(options.selectOnClock ?? OFF_ON[0]);
    this.setWrapSelectAtSteps(options.wrapSelectAtSteps ?? OFF_ON[0]);
    this.setReverseOnNegativeClock(options.reverseOnNegativeClock ?? OFF_ON[0]);
  }

  /** Command. `DIRECTION_PARAM` — which way a clock walks the sequence. */
  setDirection(name) {
    this.flags.forward = pickOption("AddrSeq direction", name, SEQUENCE_DIRECTIONS) === 1;
  }

  /** Command. `_rangeOffset` / `_rangeScale`, from the Range menu. */
  setRange(name) {
    const range = OUTPUT_RANGES[OUTPUT_RANGE_NAMES[pickOption("AddrSeq range", name, OUTPUT_RANGE_NAMES)]];
    this.rangeOffset = range[0];
    this.rangeScale = range[1];
  }

  /** Command. `_triggeredSelect`. */
  setTriggeredSelect(name) {
    this.flags.triggeredSelect = pickOption("AddrSeq triggered select", name, OFF_ON) === 1;
  }

  /** Command. `_selectOnClock`. */
  setSelectOnClock(name) {
    this.flags.selectOnClock = pickOption("AddrSeq select on clock", name, OFF_ON) === 1;
  }

  /** Command. `_wrapSelectAtSteps`. */
  setWrapSelectAtSteps(name) {
    this.flags.wrapSelectAtSteps = pickOption("AddrSeq wrap select", name, OFF_ON) === 1;
  }

  /** Command. `_reverseOnNegativeClock`. */
  setReverseOnNegativeClock(name) {
    this.flags.reverseOnNegativeClock = pickOption("AddrSeq reverse on negative clock", name, OFF_ON) === 1;
  }

  /** Command, and EMPTY ON PURPOSE: this module's C++ has no `modulate()`
   *  override, so Bogaudio reads its params every sample rather than every
   *  2.5 ms. Moving anything here would make a swept knob step. */
  control(c) {}

  sample(c, out) {
    const active = this.sequence.next(c, this.flags);
    const value = c[this.stepKeys[active]];
    out[0] = ((value + this.rangeOffset) * this.rangeScale) / VOLTS_PER_UNIT;
  }
}

/**
 * `Bogaudio-EightOne` — `src/EightOne.cpp processChannel` over the same
 * `addressable_sequence.cpp` core.
 *
 * The demultiplexer half of AddrSeq: the addressed position selects which of
 * eight INPUTS reaches the output instead of which of eight knobs. Same clock,
 * reset, steps, direction and select semantics, so a patch can drive an AddrSeq
 * and an EightOne from one clock and have them stay in step.
 *
 * Deviations: D1, D7, D8.
 *
 * Command.
 */
export class EightOneKernel {
  constructor(sampleRate, options = {}) {
    this.sequence = new AddressedSequence(sampleRate);
    this.inputKeys = numberedKeys("in", SEQUENCE_LOCAL_STEPS);
    this.outputCount = 1;
    this.flags = { forward: true, triggeredSelect: false, selectOnClock: false, wrapSelectAtSteps: false, reverseOnNegativeClock: false };
    this.setDirection(options.direction ?? SEQUENCE_DIRECTIONS[1]);
    this.setTriggeredSelect(options.triggeredSelect ?? OFF_ON[0]);
    this.setSelectOnClock(options.selectOnClock ?? OFF_ON[0]);
    this.setWrapSelectAtSteps(options.wrapSelectAtSteps ?? OFF_ON[0]);
    this.setReverseOnNegativeClock(options.reverseOnNegativeClock ?? OFF_ON[0]);
  }

  /** Command. `DIRECTION_PARAM`. */
  setDirection(name) {
    this.flags.forward = pickOption("EightOne direction", name, SEQUENCE_DIRECTIONS) === 1;
  }

  /** Command. `_triggeredSelect`. */
  setTriggeredSelect(name) {
    this.flags.triggeredSelect = pickOption("EightOne triggered select", name, OFF_ON) === 1;
  }

  /** Command. `_selectOnClock`. */
  setSelectOnClock(name) {
    this.flags.selectOnClock = pickOption("EightOne select on clock", name, OFF_ON) === 1;
  }

  /** Command. `_wrapSelectAtSteps`. */
  setWrapSelectAtSteps(name) {
    this.flags.wrapSelectAtSteps = pickOption("EightOne wrap select", name, OFF_ON) === 1;
  }

  /** Command. `_reverseOnNegativeClock`. */
  setReverseOnNegativeClock(name) {
    this.flags.reverseOnNegativeClock = pickOption("EightOne reverse on negative clock", name, OFF_ON) === 1;
  }

  /** Command, and EMPTY ON PURPOSE: this module's C++ has no `modulate()`
   *  override, so Bogaudio reads its params every sample rather than every
   *  2.5 ms. Moving anything here would make a swept knob step. */
  control(c) {}

  sample(c, out) {
    const active = this.sequence.next(c, this.flags);
    out[0] = c[this.inputKeys[active]];
  }
}

/** `Bool.cpp` compares against 1 V and emits 5 V — one fifth of a full gate and a
 *  full gate, under clause 4's fractions. */
const BOOL_THRESHOLD = GATE_HIGH_UNITS;

/**
 * `Bogaudio-Bool` — `src/Bool.cpp processAll`. No DSP library involved and no
 * parameters at all.
 *
 * Two inputs compared against 1 V give AND, OR and XOR; a third, separate input
 * gives NOT. Every output is 0 V or 5 V. The comparison is a BARE THRESHOLD, not
 * a Schmitt trigger — so a signal hovering at 1 V chatters, which is theirs and
 * is why the module is for gates rather than for audio.
 *
 * `NOT` HAS A CONNECTEDNESS TEST WE CANNOT MAKE (their
 * `isConnected() && voltage < 1`), so an unwired NOT input reads 0 V and this
 * kernel emits 5 V where Rack emits 0 V. Named here rather than hidden: it is D2
 * again, and the honest reading is that NOT of nothing is true.
 *
 * Deviations: D2, D7.
 *
 * Command.
 */
export class BoolKernel {
  constructor() {
    this.outputCount = 4;
    this.gate = GATE_UNITS;
    this.threshold = BOOL_THRESHOLD;
  }

  /** Command, and EMPTY ON PURPOSE: this module's C++ has no `modulate()`
   *  override, so Bogaudio reads its params every sample rather than every
   *  2.5 ms. Moving anything here would make a swept knob step. */
  control(c) {}

  sample(c, out) {
    const a = c.a > this.threshold;
    const b = c.b > this.threshold;
    out[0] = a && b ? this.gate : 0;
    out[1] = a || b ? this.gate : 0;
    out[2] = a !== b ? this.gate : 0;
    out[3] = c.not < this.threshold ? this.gate : 0;
  }
}

/** `mixer.cpp`: a channel's fader range in decibels and its slew time. */
const MIXER_MAX_DECIBELS = 6;
const MIXER_LEVEL_SLEW_MS = 5;
const MIXER_PAN_SLEW_MS = 10;

/** `Mix4`'s mute switch, in its four label positions — 2 and 3 are both SOLO,
 *  which is how one control carries mute and solo (right-click adds 2). */
export const MIXER_MUTE_STATES = ["unmuted", "muted", "soloed"];

/** The index in MIXER_MUTE_STATES at and above which a channel counts as SOLOED
 *  — their `> 1.5f` test, expressed against this list rather than against 1.5. */
const MIXER_SOLO_STATE = MIXER_MUTE_STATES.indexOf("soloed");

/** `mixer.cpp DimmableMixerWidget`'s dim menu, in menu order. */
export const MIXER_DIM_DECIBELS = ["6", "12", "18", "24"];

/** `Mix4`'s level CV response, in menu order. `exponential` is the default: the
 *  CV scales the fader's DECIBELS, which is why a CV sweep sounds like a fader
 *  move rather than like a multiply. */
export const MIXER_CV_RESPONSES = ["exponential", "linear"];

/** How many channels a Mix4 has. Named because it indexes four param families. */
const MIXER_CHANNELS = 4;

/**
 * `Bogaudio-Mix4` — `src/Mix4.cpp processAll` over `src/mixer.cpp`
 * (`MixerChannel::next`) and `src/dsp/signal.cpp` (`Amplifier`, `Panner`,
 * `SlewLimiter`, `Saturator`).
 *
 * Four channels with fader, mute/solo and pan into a master fader, then a
 * SATURATOR — so pushing it does not clip, it compresses. Five of these are P5's
 * bus and it also carries P9 and P14.
 *
 *   channel  out = amplifier(minDb + level·cv·(maxDb − minDb)) · in
 *   master   L,R = saturate(amplifier(masterDb) · Σ pan(out))
 *
 * TWO THINGS THAT LOOK LIKE BUGS AND ARE NOT. The master amplifier is applied
 * SEPARATELY to left and right (`_amplifier.next` called twice), which matters
 * because `Amplifier` is stateless per call — so it is fine, and it is why the
 * code reads that way. And SOLO INVERTS THE WHOLE MUTE TEST: with any channel
 * soloed, `muted = mute < 2`, so an unmuted channel goes quiet. That single line
 * is the entire solo feature.
 *
 * Deviations: D2 (level and pan CVs default to unity), D7, D8 (no RMS meter),
 * D9 (the expander branch is the not-connected branch).
 *
 * Command.
 */
export class Mix4Kernel {
  constructor(sampleRate, options = {}) {
    this.levelSLs = [];
    this.levelCvSLs = [];
    this.panSLs = [];
    for (let i = 0; i < MIXER_CHANNELS; i++) {
      this.levelSLs.push(new SlewLimiter(sampleRate, MIXER_LEVEL_SLEW_MS, MIXER_MAX_DECIBELS - MIN_DECIBELS));
      this.levelCvSLs.push(new SlewLimiter(sampleRate, MIXER_LEVEL_SLEW_MS, 1));
      this.panSLs.push(new SlewLimiter(sampleRate, MIXER_PAN_SLEW_MS, 2));
    }
    this.masterSL = new SlewLimiter(sampleRate, MIXER_LEVEL_SLEW_MS, MIXER_MAX_DECIBELS - MIN_DECIBELS);
    this.masterCvSL = new SlewLimiter(sampleRate, MIXER_LEVEL_SLEW_MS, 1);
    this.channelOuts = new Float64Array(MIXER_CHANNELS);
    this.inputKeys = numberedKeys("in", MIXER_CHANNELS);
    this.levelKeys = numberedKeys("level", MIXER_CHANNELS);
    this.levelCvKeys = numberedKeys("cv", MIXER_CHANNELS);
    this.panKeys = numberedKeys("pan", MIXER_CHANNELS);
    this.panCvKeys = this.panKeys.map((key) => `${key}_cv`);
    this.outputCount = 2;
    this.setCvResponse(options.cvResponse ?? MIXER_CV_RESPONSES[0]);
    this.setDimDecibels(options.dimDecibels ?? MIXER_DIM_DECIBELS[1]);
    this.setMasterMute(options.masterMute ?? OFF_ON[0]);
    this.setMasterDim(options.masterDim ?? OFF_ON[0]);
    this.mutes = [];
    for (let i = 0; i < MIXER_CHANNELS; i++) this.mutes.push(0);
    for (let i = 0; i < MIXER_CHANNELS; i++) this.setMute(i + 1, options[`mute${i + 1}`] ?? MIXER_MUTE_STATES[0]);
  }

  /** Command. `_linearCV`. */
  setCvResponse(name) {
    this.linearCv = pickOption("Mix4 CV response", name, MIXER_CV_RESPONSES) === 1;
  }

  /** Command. `_dimDb`. */
  setDimDecibels(name) {
    this.dimDb = Number(MIXER_DIM_DECIBELS[pickOption("Mix4 dim", name, MIXER_DIM_DECIBELS)]);
  }

  /** Command. `MIX_MUTE_PARAM`. */
  setMasterMute(name) {
    this.masterMute = pickOption("Mix4 master mute", name, OFF_ON) === 1;
  }

  /** Command. `MIX_DIM_PARAM`. */
  setMasterDim(name) {
    this.masterDim = pickOption("Mix4 master dim", name, OFF_ON) === 1;
  }

  /** Command. One channel's mute switch: 0 unmuted, 1 muted, 2 soloed. */
  setMute(channel, name) {
    this.mutes[channel - 1] = pickOption(`Mix4 mute ${channel}`, name, MIXER_MUTE_STATES);
  }

  /** Command. `setMute1`…`setMute4`, so the processor's naming convention finds
   *  one setter per knob rather than needing a channel argument. */
  setMute1(name) { this.setMute(1, name); }
  setMute2(name) { this.setMute(2, name); }
  setMute3(name) { this.setMute(3, name); }
  setMute4(name) { this.setMute(4, name); }

  /** Command, and EMPTY ON PURPOSE: this module's C++ has no `modulate()`
   *  override, so Bogaudio reads its params every sample rather than every
   *  2.5 ms. Moving anything here would make a swept knob step. */
  control(c) {}

  sample(c, out) {
    let solo = false;
    for (let i = 0; i < MIXER_CHANNELS; i++) if (this.mutes[i] >= MIXER_SOLO_STATE) solo = true;
    for (let i = 0; i < MIXER_CHANNELS; i++) {
      const cv = unipolarCv(c[this.levelCvKeys[i]]);
      // THE WHOLE SOLO FEATURE: with anything soloed the mute test INVERTS, so an
      // unmuted channel is the one that goes quiet (`mixer.cpp MixerChannel::next`).
      const muted = solo ? this.mutes[i] < MIXER_SOLO_STATE : this.mutes[i] > 0;
      let db = MIN_DECIBELS;
      if (!muted) {
        let level = clamp(c[this.levelKeys[i]], 0, 1);
        if (!this.linearCv) level *= cv;
        db = level * (MIXER_MAX_DECIBELS - MIN_DECIBELS) + MIN_DECIBELS;
      }
      let value = amplifierLevel(this.levelSLs[i].next(db)) * c[this.inputKeys[i]];
      if (this.linearCv) value *= this.levelCvSLs[i].next(cv);
      this.channelOuts[i] = value;
    }

    const masterCv = unipolarCv(c.mix_cv);
    let masterDb = MIN_DECIBELS;
    if (!this.masterMute) {
      let level = clamp(c.mix, 0, 1);
      if (!this.linearCv) level *= masterCv;
      masterDb = level * (MIXER_MAX_DECIBELS - MIN_DECIBELS) + MIN_DECIBELS;
      if (this.masterDim) masterDb = Math.max(MIN_DECIBELS, masterDb - this.dimDb);
    }
    const masterLevel = amplifierLevel(this.masterSL.next(masterDb));
    const smoothedCv = this.masterCvSL.next(masterCv);

    let left = 0;
    let right = 0;
    for (let i = 0; i < MIXER_CHANNELS; i++) {
      const pan = this.panSLs[i].next(clamp(c[this.panKeys[i]], -1, 1) * bipolarCv(c[this.panCvKeys[i]]));
      left += panLeft(pan) * this.channelOuts[i];
      right += panRight(pan) * this.channelOuts[i];
    }

    left *= masterLevel;
    right *= masterLevel;
    if (this.linearCv) {
      left *= smoothedCv;
      right *= smoothedCv;
    }
    out[0] = saturate(left * VOLTS_PER_UNIT) / VOLTS_PER_UNIT;
    out[1] = saturate(right * VOLTS_PER_UNIT) / VOLTS_PER_UNIT;
  }
}

/** `Manual.cpp`: the pulse it extends a press to, and the startup delay before a
 *  trigger-on-load fires. Its `_outputScale` is D11 — see the kernel. */
const MANUAL_PULSE_SECONDS = 0.001;
const MANUAL_STARTUP_SECONDS = 0.01;

/**
 * `Bogaudio-Manual` — `src/Manual.cpp processAll` over `src/trigger_on_load.hpp`
 * and Rack's `PulseGenerator`.
 *
 * One button, eight identical outputs. Its two subtleties are both about TIME:
 * the output is held for at least 1 ms after the button goes low (so a one-frame
 * press still produces a usable trigger), and `triggerOnLoad` fires once 10 ms
 * after the module starts — which is what makes a patch self-starting, and is
 * exactly why P4 uses it.
 *
 * OUR BUTTON IS A KNOB, and that is the interesting difference: in Rack the
 * button is a momentary gesture, here it is keyframable property state, so
 * "press at 2.5 s" is a keyframe rather than a performance.
 *
 * Deviations: D7, D11 (their +10 V output option is not ported — a `trigger` port
 * carries 0..1 and has no volts for the option to scale).
 *
 * Command.
 */
export class ManualKernel {
  constructor(sampleRate, options = {}) {
    this.sampleTime = 1 / sampleRate;
    this.trigger = new SchmittTrigger();
    this.pulse = new PulseGenerator();
    this.startupDelay = new Timer(sampleRate, MANUAL_STARTUP_SECONDS);
    this.startupDone = false;
    this.outputCount = 8;
    this.setTriggerOnLoad(options.triggerOnLoad ?? OFF_ON[1]);
  }

  /** Command. `_triggerOnLoad`. */
  setTriggerOnLoad(name) {
    this.triggerOnLoad = pickOption("Manual trigger on load", name, OFF_ON) === 1;
  }

  /** Command, and EMPTY ON PURPOSE: this module's C++ has no `modulate()`
   *  override, so Bogaudio reads its params every sample rather than every
   *  2.5 ms. Moving anything here would make a swept knob step. */
  control(c) {}

  sample(c, out) {
    let initialPulse = false;
    if (!this.startupDone && !this.startupDelay.next()) {
      initialPulse = true;
      this.startupDone = true;
    }
    const fired = this.trigger.process(c.trigger);
    if (fired || this.trigger.isHigh() || (initialPulse && this.triggerOnLoad)) {
      this.pulse.trigger(MANUAL_PULSE_SECONDS);
    }
    const high = this.pulse.process(this.sampleTime);
    const value = high ? GATE_UNITS : 0;
    for (let i = 0; i < this.outputCount; i++) out[i] = value;
  }
}
