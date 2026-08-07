/**
 * THE VC-10 KERNELS — fifteen VCV Rack modules' arithmetic, and nothing else.
 *
 * No AudioNode, no AudioWorklet, no DOM: a plain ES module, so
 * `tests/port_vc10_test.js` can run every recurrence in BARE NODE against a
 * transcription of the original. THE ARITHMETIC IS THE DELIVERABLE, so the
 * arithmetic has to be reachable by a test that needs no browser — the reasoning
 * that put AX-2's minBLEP table and VC-3b's Butterworth solver in a kernels module.
 *
 * `worklets/processors_vc10.js` imports this and wraps each kernel in an
 * AudioWorkletProcessor; `modules_vc10.js` wires those into engine modules.
 *
 * ⚠ THE WORKLET URL IS NOT HERE AND MUST NOT BE. `synth/worklet_urls.js` holds
 * every block's `?worker&url` specifier — read its header. A Vite specifier
 * anywhere in this import graph takes the entire bare-node test lane down.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE DERIVATION RECORD — THREE TIERS, AND EACH NODE SAYS WHICH IT IS
 * ═══════════════════════════════════════════════════════════════════════════
 * R7-17, user: *"it's so we can debug shit and find flaws in the emulation."*
 * A port whose fidelity is overstated is worse than no port, because the patch
 * sounds wrong and nothing says why. So every kernel below declares its TIER:
 *
 *  **SOURCE** — ported line by line from published C++. The recurrence in the
 *      docblock is diffable against a named function in a named file at a named
 *      commit. Five nodes: Super, F2, Filt, FrequencyShifter, WVCO.
 *
 *  **DSP-SOURCE + BEHAVIOUR ASSEMBLY** — the Rack module is CLOSED, but its
 *      author publishes the DSP building blocks it is built from, in the Vult
 *      language, and the module's own manual names the topology. The CORE is a
 *      real port of the author's own code; how the module wires those cores
 *      together, and every knob law, is derived from the manual and is a MODEL,
 *      not a transcription. Seven nodes: Vessek, Caudal, Tangents, Basal, Bleak,
 *      Unstabile, Lateralus.
 *
 *  **BEHAVIOUR ONLY** — closed source, no published DSP. Everything is derived
 *      from the vendor's own user manual, cited by URL and date. Three nodes:
 *      øchd, saïch, athrú. These will not sound identical to the originals and
 *      each one's spec `help` says so in its own words.
 *
 * ── THE SOURCES, CLONED READ-ONLY AND READ AT THESE COMMITS ON 2026-08-06 ───
 *   github.com/squinkylabs/SquinkyVCV-main @ 8b0411e2d1b5a11ffa11280cca00253813212dc7
 *   github.com/vult-dsp/vult              @ cc56038e06ae4745b17bcd7e611e7b21d87ea51c
 *   github.com/modlfo/VultModules (gh-pages, the per-module MANUALS)
 *                                         @ 99629d35103eaba67acf35f1b906c4b5bcfb22ff
 *   instruomodular.com manuals: Ochd-Manual-A5.pdf, Athru-Manual-A5.pdf,
 *                               saïch-Manual.pdf   (read 2026-08-06)
 *
 * Squinky's `composites/*.h` are the modules; the recurrences live in `dsp/`.
 * Every kernel cites BOTH, because a wrong sound is usually in the first and a
 * wrong ALGORITHM in the second.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * BLOCK-WIDE DEVIATIONS — named and numbered, as AX-2 does
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ── D0. THE VOLTAGE LAW — ONE UNIT, STATED ONCE, APPLIED EVERYWHERE ─────────
 * Rack cables carry volts: ±5 V nominal, ±10 V max, and V/oct is `FREQ_C4 · 2^v`.
 * Our `audio` wires are ±1 and our `number` wires carry real units.
 *
 *   **1.0 on a PowerRP audio wire IS 5 V in Rack.** `RACK_VOLTS_PER_UNIT = 5`.
 *
 * So every kernel below computes IN VOLTS — every transcribed line is directly
 * diffable against the original — and the conversion happens at exactly two
 * places, both in `worklets/processors_vc10.js`: `volts = sample · 5` on the way
 * in, `sample = volts / 5` on the way out. Same law VC-1 measured and VC-3b
 * restated; this block adds no clause.
 *
 * ── D1. PITCH IS SEMITONES, AND THE ORIGIN IS PER MODULE FAMILY ─────────────
 * R7-UNITS clause 3 and clause 5. A V/oct port carries SEMITONES (`12 · volts`),
 * so a pitch wire is passed through UNSCALED. The origin is whatever the module's
 * own tuning implies, and this block contains THREE of them:
 *
 *   squinkylabs  0 st is **C4 = 261.626 Hz**. Both Super and WVCO write
 *                `const float q = float(log2(261.626))` and add it to the pitch
 *                before `exp2` — so porting means porting THEIR six digits, not
 *                Rack's `dsp::FREQ_C4` (261.6256). `squinkySemitonesToHz`.
 *   Vult         0 st is **C1 = 32.703 Hz**, and this is MEASURED rather than
 *                guessed. `examples/util/util.vult` defines
 *                `cvToPitch(cv) = cv·120 + 24` and
 *                `f = 8.175798915643707 · 2^(pitch/12)`; a Rack V/oct arrives as
 *                `cv = volts/10`, so 0 V is MIDI 24, which is C1 — and Vessek's
 *                own manual says in as many words "Zero volts corresponds to a
 *                C1 note". `vultSemitonesToHz`.
 *   Vult, +2 oct Basal's and Bleak's manuals say "Zero volts corresponds to a C3
 *                note" for the SAME DSP, so those two carry a +24 semitone panel
 *                offset. Modelled as exactly that, not as a second tuning.
 *   Instruo      no V/oct port exists on any of the three ported nodes except
 *                saïch's, whose manual gives no origin. It uses C4 with
 *                `squinkySemitonesToHz` and its spec says the origin is assumed.
 *
 * A pitch wire crossing the semitone/volt boundary is wrong by SIXTY and sounds
 * like a bad port rather than like a units bug. That is why this is a law.
 *
 * ── D2. GATES ARE 0…1 LOGIC, MAPPED TO RACK'S 10 V ─────────────────────────
 * R7-UNITS clause 4. Squinky's `GateTrigger` is a Schmitt trigger at
 * 0.8 V / 1.6 V (`sqsrc/util/Constants.h`), so a LEVEL-scaled gate of 1.0 would
 * arrive at 5 V — fine — but a gate of 0.2 would arrive at 1.0 V and sit BELOW
 * the high threshold while looking like a gate. ×10 puts a full gate an order of
 * magnitude clear of it, which is what a Rack patch's 10 V gate really does.
 *
 * ── D3. CV INLETS ARE `audio` PORTS, NOT AudioParams ────────────────────────
 * VC-3b's finding, and it binds here for two more reasons of this block's own:
 * Super's `isStereo`, Filt's four routing MODES and WVCO's four
 * `…Connected_m` flags all branch on `isConnected()`, and a connected cable
 * sitting at 0 V is a different sound from no cable. No AudioParam can express
 * that — one number cannot distinguish "absent" from "zero" — so every CV inlet
 * here is an `audio` input at its own worklet input index and the processor reads
 * connectedness as `inputs[i].length > 0`. The kernels take `wired` as an
 * explicit map so `tests/port_vc10_test.js` drives both branches directly.
 *
 * ── D4. THE CONTROL DIVIDERS ARE PORTED, NOT "IMPROVED" ────────────────────
 * `process(const ProcessArgs&)` runs at SAMPLE rate; anything inside a
 * `dsp::ClockDivider` runs at sample-rate/N. Super reads its knobs every 4
 * samples (`inputSubSample = 4`), F2 every 4 with a second pass every 16, Filt
 * every 4, WVCO every 4 AND every 16. Running those per sample changes every
 * sweep, so each roster row declares its `controlDivisor` and the kernels that
 * need a SECOND, slower rate count it themselves. R7-11's rule.
 *
 * ── D5. RANDOMNESS IS SEEDED, AND SQUINKY'S ALREADY WAS ────────────────────
 * `AudioMath::random()` is `static std::default_random_engine generator{57}` —
 * libstdc++ spells that `minstd_rand0`, the Lehmer generator
 * `x ← 16807·x mod (2^31 − 1)`, and it is seeded with a CONSTANT. So Super's
 * trigger-randomised phases are already reproducible and this port keeps the
 * generator, the multiplier AND the seed. `Minstd0` is that generator; the
 * `seed` knob defaults to 57, their own number. `16807 · 2^31 ≈ 3.6e13 < 2^53`,
 * so JavaScript numbers reproduce it exactly. Nothing here reads a wall clock.
 *
 * ── D6. TRIMS DEFAULT TO UNITY AND ARE LINEAR ──────────────────────────────
 * Rack's attenuverters default to 0 and run through
 * `makeScalerWithBipolarAudioTrim`'s bipolar audio taper. Two changes, both
 * deliberate:
 *   - the DEFAULT is 1, not 0. VC-3a's finding generalised: a 0 default means a
 *     patched cable does nothing, and this block exists to make the demo patches'
 *     cables live. A trim of 0 is still reachable and still means "ignore the CV".
 *   - the TAPER is linear. The bipolar audio taper is monotone through
 *     (−1,−1), (0,0) and (1,1) — the endpoints and the centre are EXACT in both,
 *     and only the feel of the middle differs. Reproducing a 64-bin lookup table
 *     to change the feel of a knob nobody in a ported patch has touched is cost
 *     with no picture behind it.
 *
 * ── D7. LOOKUP TABLES ARE EVALUATED, NOT TABULATED — EXCEPT WHERE THE TABLE
 *        IS THE SOUND ──────────────────────────────────────────────────────
 * Squinky caches `exp2`, `tanh` and the audio taper in 256-bin lookup tables for
 * SPEED. Evaluating the function instead is more accurate, not less, and the
 * error it removes is below −90 dBFS. So the smooth ones are evaluated.
 * TWO ARE NOT, because their table is doing something the function does not:
 *   - `EdgeTables` (Filt) tabulates a function with a STEP at edge = 0.5, and
 *     the 20-bin table SMOOTHS that step across one bin. `uniformTable` is that
 *     table, ported, because the smoothing is audible on an edge sweep.
 *   - Vult's `@[table(size = N, min, max)]` annotation is part of the LANGUAGE:
 *     the compiler emits the table and the DSP is tuned against its resolution.
 *     `vultTable` is that mechanism.
 *
 * ── D8. POLYPHONY IS NOT PORTED ────────────────────────────────────────────
 * Rack cables carry up to 16 channels. Super runs one `SuperDsp` per channel,
 * F2 four SIMD banks, WVCO four, Filt sixteen. Our `audio` wire is MONO, so each
 * kernel is the channel-0 engine; the per-channel arithmetic is unchanged and
 * what is lost is one cable carrying a chord. Reported to the lead rather than
 * invented around — a poly wire type is a document-model decision, not a port's.
 *
 * ── D9. AN UNCONNECTED OUTPUT CANNOT BE SEEN ───────────────────────────────
 * Super's `isStereo` and Filt's mode decoder read OUTPUT connectedness, and the
 * AudioWorklet API exposes none: an output's buffer exists whether or not
 * anything reads it. Both nodes therefore take the output half of that decision
 * as a KNOB (`stereo` on Super, and Filt's mode is decided from its INPUTS
 * alone with both outputs always driven). Named here because a silent guess
 * would be the exact failure this record exists to prevent.
 *
 * ── D10. RACK'S FAST APPROXIMATIONS ARE REPLACED BY THE EXACT FUNCTION ─────
 * `rack::dsp::approxExp2_taylor5` (F2) is a 5th-order Taylor exp2 accurate to
 * about 1e-6 relative over its domain. `Math.pow(2, x)` is exact. WVCO's
 * `SimdBlocks::sinTwoPi` is NOT in this class and is ported verbatim: its error
 * is percent-level and shapes the oscillator's own harmonic content.
 */

// ═══════════════════════════════════════════════════════════════════════════
// 0. THE LAWS EVERY KERNEL IN THIS FILE OBEYS
// ═══════════════════════════════════════════════════════════════════════════

/** D0: 1.0 on a PowerRP audio wire is this many Rack volts. See the header. */
export const RACK_VOLTS_PER_UNIT = 5;

/** D1: a V/oct wire carries twelve semitones per Rack volt. */
export const VC10_SEMITONES_PER_VOLT = 12;

/** D2: a full 0…1 gate is Rack's 10 V. Squinky's Schmitt trigger is at 1.6 V. */
export const VC10_GATE_VOLTS = 10;

const SEMITONES_PER_OCTAVE = 12;

/**
 * Squinky's own C4, to the six digits BOTH `SuperDsp::updatePhaseInc` and
 * `WVCO::stepm` spell as `float(log2(261.626))`. NOT Rack's `dsp::FREQ_C4`
 * (261.6256) — porting means porting their number, and the difference is
 * 0.0015 cents, which matters only because a reader who finds 261.6256 here
 * would not know which of the two is the bug.
 */
export const SQUINKY_C4_HZ = 261.626;

/**
 * Pure function. Semitones from C4 to hertz, in squinkylabs' own tuning (D1).
 *
 * @param {number} semitones - semitones from C4, which is 0
 * @returns {number} hertz
 *
 * @example squinkySemitonesToHz(0) // 261.626
 * @example squinkySemitonesToHz(12) // 523.252
 * @example squinkySemitonesToHz(-12) // 130.813
 */
export function squinkySemitonesToHz(semitones) {
  return SQUINKY_C4_HZ * Math.pow(2, semitones / SEMITONES_PER_OCTAVE);
}

/** Vult's MIDI-note root, from `examples/util/util.vult`: their frequency law is
 *  `8.175798915643707 · exp(0.057762265046662105 · pitch)`, and the exponent is
 *  `ln(2)/12` to sixteen digits, so this IS `root · 2^(pitch/12)`. */
export const VULT_MIDI_ROOT_HZ = 8.175798915643707;

/** `cvToPitch(cv) = cv·120 + 24` with a Rack V/oct arriving as `volts/10`, so
 *  0 V is MIDI 24 — C1, exactly what Vessek's manual says. See D1. */
export const VULT_ZERO_VOLT_MIDI = 24;

/**
 * Pure function. Semitones from Vult's own zero (C1) to hertz (D1).
 *
 * @param {number} semitones - semitones above C1, which is 0
 * @returns {number} hertz
 *
 * @example vultSemitonesToHz(0) // 32.70319566257483
 * @example vultSemitonesToHz(12) // 65.40639132514966
 * @example vultSemitonesToHz(36) // 261.6255653005986
 */
export function vultSemitonesToHz(semitones) {
  return VULT_MIDI_ROOT_HZ * Math.pow(2, (VULT_ZERO_VOLT_MIDI + semitones) / SEMITONES_PER_OCTAVE);
}

/** Basal's and Bleak's manuals put 0 V at C3 for the same DSP Vessek puts at
 *  C1, so those two carry a two-octave panel offset. D1. */
export const VULT_C3_PANEL_OFFSET_SEMITONES = 24;

/**
 * Pure function. Clamp, spelled once so twenty call sites do not spell it three
 * ways. `std::clamp` and `rack::simd::clamp` in the originals.
 *
 * @param {number} x
 * @param {number} lo
 * @param {number} hi
 * @returns {number}
 *
 * @example vc10Clamp(3, 0, 1) // 1
 * @example vc10Clamp(-3, -1, 1) // -1
 * @example vc10Clamp(0.5, 0, 1) // 0.5
 */
export function vc10Clamp(x, lo, hi) {
  return x < lo ? lo : x > hi ? hi : x;
}

/**
 * Pure function. `AudioMath::quadraticBipolar` (`dsp/utils/AudioMath.h:46`) —
 * square the magnitude, keep the sign. Super's FM depth knob runs through it,
 * which is why its bottom half barely moves.
 *
 * @param {number} x
 * @returns {number} x² with x's sign
 *
 * @example quadraticBipolar(0.5) // 0.25
 * @example quadraticBipolar(-0.5) // -0.25
 * @example quadraticBipolar(1) // 1
 */
export function quadraticBipolar(x) {
  const x2 = x * x;
  return x >= 0 ? x2 : -x2;
}

/**
 * Pure function. `AudioMath::fold` (`dsp/utils/AudioMath.h:207`) — the TRIANGLE
 * fold that both Filt's fold voicings and WVCO's `SimdBlocks::fold` use. Folds
 * about ±1 as many times as it takes; the result is always in [−1, 1].
 *
 * @param {number} x
 * @returns {number} in [-1, 1]
 *
 * @example audioMathFold(0.5) // 0.5
 * @example audioMathFold(1.5) // 0.5
 * @example audioMathFold(2.5) // -0.5
 * @example audioMathFold(-1.5) // -0.5
 */
export function audioMathFold(x) {
  const bias = x < 0 ? -1 : 1;
  const phase = Math.trunc((x + bias) / 2);
  const isEven = !(phase & 1);
  return isEven ? x - 2 * phase : -x + 2 * phase;
}

/** `LookupTableFactory::audioTaperKnee()` — the decibel the taper's linear
 *  bottom quarter reaches. Both Filt's drive and F2's output volume use it. */
const AUDIO_TAPER_KNEE_DB = -24;

/** Where the taper switches from its linear bottom to its exponential top. */
const AUDIO_TAPER_KNEE_X = 0.25;

/**
 * Pure function. `AudioMath::makeFunc_AudioTaper` (`dsp/utils/AudioMath.cpp:57`),
 * evaluated rather than tabulated (D7). Linear from (0, 0) to (0.25, g), then
 * exponential from there to (1, 1), where g is the knee gain.
 *
 * @param {number} x - 0…1 knob position
 * @param {number} [dbAtten] - the knee, in decibels
 * @returns {number} 0…1 gain
 *
 * @example audioTaper(0) // 0
 * @example audioTaper(1) // 1
 * @example Math.abs(audioTaper(0.25) - 0.0630957) < 1e-6 // true
 * @example Math.abs(audioTaper(0.5) - 0.158489) < 1e-6 // true
 */
export function audioTaper(x, dbAtten = AUDIO_TAPER_KNEE_DB) {
  const gainAtKnee = Math.pow(10, dbAtten / 20);
  if (x <= AUDIO_TAPER_KNEE_X) return (gainAtKnee / AUDIO_TAPER_KNEE_X) * x;
  const a = (Math.log(1) - Math.log(gainAtKnee)) / (1 - AUDIO_TAPER_KNEE_X);
  const b = Math.log(gainAtKnee) - a * AUDIO_TAPER_KNEE_X;
  return Math.exp(a * x + b);
}

/** `AudioMath::makeLinearScaler`'s CV domain: a Rack CV is ±5 V. */
const SCALER_CV_SPAN_VOLTS = 5;

/**
 * Pure function. `AudioMath_4::makeScalerWithBipolarAudioTrim(x0, x1, y0, y1)`
 * (`dsp/utils/AutioMath_4.cpp:9`) — the CV, the knob and the attenuverter
 * combined into one value: `clamp(cv·trim + knob, x0, x1)` mapped linearly from
 * [x0, x1] onto [y0, y1]. Per D6 the trim is linear rather than audio-tapered.
 *
 * THE FOUR-ARGUMENT DOMAIN IS LOAD-BEARING AND WAS MEASURED, not assumed. F2
 * calls the SIMD version with `(0, 10, 0, 10)` — a 0…10 knob domain — while Filt
 * and Super call the scalar `AudioMath::makeScalerWithBipolarAudioTrim(y0, y1)`,
 * whose domain is hard-coded ±5. Reading the scalar signature into F2 puts its
 * default cutoff knob at clamp(5)→10 V, i.e. 16.7 kHz instead of 523 Hz — a
 * filter defaulting to wide open, which is exactly the kind of self-consistent
 * wrong this record exists to catch.
 *
 * @param {number} cv - the CV inlet, in volts
 * @param {number} knob - the knob, in the original's own domain
 * @param {number} trim - the attenuverter, −1…1 (D6: unity by default)
 * @param {number} x0 - the bottom of the knob's domain
 * @param {number} x1 - the top of it
 * @param {number} y0 - the value at x0
 * @param {number} y1 - the value at x1
 * @returns {number}
 *
 * @example trimScaler(0, 0, 1, -5, 5, 0, 1) // 0.5
 * @example trimScaler(0, 5, 1, -5, 5, 0, 1) // 1
 * @example trimScaler(5, 0, 1, -5, 5, 0, 1) // 1
 * @example trimScaler(5, 0, 0, -5, 5, 0, 1) // 0.5
 * @example trimScaler(0, 5, 1, 0, 10, 0, 10) // 5
 */
export function trimScaler(cv, knob, trim, x0, x1, y0, y1) {
  const a = (y1 - y0) / (x1 - x0);
  const b = y0 - a * x0;
  return a * vc10Clamp(cv * trim + knob, x0, x1) + b;
}

/**
 * Pure function. The scalar `AudioMath::makeLinearScaler(y0, y1)` and
 * `makeScalerWithBipolarAudioTrim(y0, y1)`, whose knob domain is ±5 V.
 *
 * @param {number} cv - the CV inlet, in volts
 * @param {number} knob - the knob, in the original's own ±5 domain
 * @param {number} trim - the attenuverter, −1…1
 * @param {number} y0 - the value at −5
 * @param {number} y1 - the value at +5
 * @returns {number}
 *
 * @example linearScaler(0, 0, 1, 0, 1) // 0.5
 * @example linearScaler(0, 5, 1, 0, 1) // 1
 * @example linearScaler(-5, 0, 1, 0, 1) // 0
 */
export function linearScaler(cv, knob, trim, y0, y1) {
  return trimScaler(cv, knob, trim, -SCALER_CV_SPAN_VOLTS, SCALER_CV_SPAN_VOLTS, y0, y1);
}

// ── SEEDED RANDOMNESS (D5) ──────────────────────────────────────────────────

/** `minstd_rand0`'s multiplier — libstdc++'s `std::default_random_engine`. */
const MINSTD0_MULTIPLIER = 16807;

/** Its modulus, the Mersenne prime 2^31 − 1. */
const MINSTD0_MODULUS = 2147483647;

/** `AudioMath::random()`'s own seed, spelled `generator{57}` in their source. */
export const SQUINKY_RANDOM_SEED = 57;

/**
 * The Lehmer generator libstdc++ calls `std::default_random_engine`, ported
 * exactly (D5). Near-pure (it advances its own state); deterministic given a
 * seed, which is the whole point.
 *
 * @example // const rng = new Minstd0(1); rng.next01() // 16807 / 2147483647
 */
export class Minstd0 {
  /**
   * @param {number} seed - any integer; 0 is illegal for a Lehmer generator and
   *        is mapped to their own 57 rather than silently producing all zeros
   */
  constructor(seed = SQUINKY_RANDOM_SEED) {
    const s = Math.abs(Math.trunc(seed)) % MINSTD0_MODULUS;
    this.state = s === 0 ? SQUINKY_RANDOM_SEED : s;
  }

  /** Command (advances state). The next value in [0, 1). */
  next01() {
    this.state = (MINSTD0_MULTIPLIER * this.state) % MINSTD0_MODULUS;
    return this.state / MINSTD0_MODULUS;
  }
}

// ── LOOKUP TABLES (D7) ──────────────────────────────────────────────────────

/**
 * Pure function. `LookupTable<T>::init` + `lookup` — a uniform table of `bins`
 * intervals over [xMin, xMax], read with linear interpolation and clamped at
 * both ends. Ported rather than evaluated only where the table's RESOLUTION is
 * part of the sound (D7).
 *
 * @param {function(number): number} fn - the function to tabulate
 * @param {number} bins - interval count; the table holds bins + 1 points
 * @param {number} xMin
 * @param {number} xMax
 * @returns {function(number): number} the interpolating reader
 *
 * @example uniformTable((x) => x * x, 4, 0, 1)(0.5) // 0.25
 * @example uniformTable((x) => x * x, 4, 0, 1)(0.125) // 0.03125
 * @example uniformTable((x) => x * x, 4, 0, 1)(2) // 1
 */
export function uniformTable(fn, bins, xMin, xMax) {
  const points = new Float64Array(bins + 1);
  for (let i = 0; i <= bins; i++) points[i] = fn(xMin + ((xMax - xMin) * i) / bins);
  const scale = bins / (xMax - xMin);
  return (x) => {
    const position = vc10Clamp((x - xMin) * scale, 0, bins);
    const index = Math.min(Math.floor(position), bins - 1);
    const frac = position - index;
    return points[index] + frac * (points[index + 1] - points[index]);
  };
}

/**
 * Pure function. `NonUniformLookupTable<T>` (`dsp/utils/NonUniformLookupTable.h`)
 * — a piecewise-linear reader over UNEVENLY spaced points, which is how Squinky
 * stores both the sawtooth detune curve and the ladder's feedback ceiling.
 * Sorted here rather than at every call, and clamped to the end values exactly
 * as their `lower_bound` walk does.
 *
 * @param {Array<[number, number]>} points - [x, y] pairs, any order
 * @returns {function(number): number}
 *
 * @example nonUniformTable([[0, 0], [1, 10]])(0.5) // 5
 * @example nonUniformTable([[0, 0], [1, 10]])(-1) // 0
 * @example nonUniformTable([[0, 0], [1, 10]])(2) // 10
 */
export function nonUniformTable(points) {
  const sorted = [...points].sort((a, b) => a[0] - b[0]);
  const xs = Float64Array.from(sorted, (p) => p[0]);
  const ys = Float64Array.from(sorted, (p) => p[1]);
  const slopes = new Float64Array(xs.length);
  for (let i = 0; i < xs.length - 1; i++) slopes[i] = (ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]);
  return (x) => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[xs.length - 1]) return ys[ys.length - 1];
    let i = 0;
    while (i < xs.length - 1 && xs[i + 1] < x) i++;
    return slopes[i] * (x - xs[i]) + ys[i];
  };
}

/**
 * Pure function. `AudioMath::distributeEvenly` (`AudioMath.h:248`) — n numbers in
 * geometric progression with the given ratio, scaled so their PRODUCT is 1. Filt
 * uses it for both the per-stage edge gains and the capacitor spread.
 *
 * @param {number} n
 * @param {number} ratio
 * @returns {Float64Array}
 *
 * @example Array.from(distributeEvenly(2, 1)) // [1, 1]
 * @example Math.abs(distributeEvenly(2, 4)[0] - 0.5) < 1e-12 // true
 * @example Math.abs(distributeEvenly(2, 4)[1] - 2) < 1e-12 // true
 */
export function distributeEvenly(n, ratio) {
  const data = new Float64Array(n);
  let x = 1;
  for (let i = 0; i < n; i++) {
    data[i] = x;
    x *= ratio;
  }
  let product = 1;
  for (let i = 0; i < n; i++) product *= data[i];
  const k = Math.exp(-Math.log(product) / n);
  for (let i = 0; i < n; i++) data[i] *= k;
  return data;
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. THE SHARED SQUINKY DSP BLOCKS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * A cascade of `N` biquads in the form `BiquadFilter<T>::run`
 * (`dsp/filters/BiquadFilter.h:63`) uses, sign conventions included:
 *   `x = in + A1·z0 + A2·z1;  out = B0·x + B1·z0 + B2·z1;  z1 = z0;  z0 = x`
 * so `A1 = −a1/a0` and `A2 = −a2/a0` against the textbook difference equation.
 * Keeping their form is what lets a wrong coefficient be found by eye.
 *
 * Command (mutates its own delay line). Untested as a unit; exercised through
 * every filter that holds one, and its magnitude response is measured in
 * `tests/port_vc10_test.js`.
 */
export class BiquadCascade {
  /** @param {Array<number[]>} stages - [B0, B1, B2, A1, A2] per stage */
  constructor(stages) {
    this.stages = stages;
    this.z0 = new Float64Array(stages.length);
    this.z1 = new Float64Array(stages.length);
  }

  /** Command. One sample through every stage. */
  run(input) {
    let value = input;
    for (let s = 0; s < this.stages.length; s++) {
      const [b0, b1, b2, a1, a2] = this.stages[s];
      const x = value + (a1 * this.z0[s] + a2 * this.z1[s]);
      value = b0 * x + b1 * this.z0[s] + b2 * this.z1[s];
      this.z1[s] = this.z0[s];
      this.z0[s] = x;
    }
    return value;
  }

  /** Command. Clear the delay line — a rebuild, not a per-sample operation. */
  reset() {
    this.z0.fill(0);
    this.z1.fill(0);
  }
}

/** A six-pole Butterworth has three quadratic sections; these are their Qs,
 *  `1 / (2·cos(π(2k+1)/12))` for k = 0, 1, 2. */
const BUTTERWORTH_6P_Q = Object.freeze([
  1 / (2 * Math.cos(Math.PI / 12)),
  1 / (2 * Math.cos((3 * Math.PI) / 12)),
  1 / (2 * Math.cos((5 * Math.PI) / 12)),
]);

/**
 * Pure function. `ButterworthFilterDesigner::designSixPoleLowpass` — the
 * coefficients `ObjectCache::get6PLPParams` caches and every Squinky
 * up/down-sampler in this block runs on. DSPFilters designs it by mapping the
 * analog Butterworth poles through a prewarped bilinear transform, which for a
 * conjugate pair is algebraically the RBJ lowpass biquad at the same Q — so this
 * is the same filter written the short way, not an approximation of it.
 *
 * @param {number} normalizedFc - cutoff as a fraction of the sample rate
 * @returns {Array<number[]>} three [B0, B1, B2, A1, A2] stages
 *
 * @example sixPoleLowpassStages(1 / 16).length // 3
 * @example // DC gain is unity: the three stages' B sums over their A sums == 1
 */
export function sixPoleLowpassStages(normalizedFc) {
  const w0 = 2 * Math.PI * normalizedFc;
  const cosw = Math.cos(w0);
  const sinw = Math.sin(w0);
  return BUTTERWORTH_6P_Q.map((q) => {
    const alpha = sinw / (2 * q);
    const a0 = 1 + alpha;
    return [
      (1 - cosw) / 2 / a0,
      (1 - cosw) / a0,
      (1 - cosw) / 2 / a0,
      (2 * cosw) / a0,
      (alpha - 1) / a0,
    ];
  });
}

/**
 * `IIRDecimator<T>` (`dsp/utils/IIRDecimator.h`) — filter every oversampled
 * sample through a six-pole Butterworth at `1/(4·oversample)` and RETURN THE
 * LAST ONE. Not an average: averaging would add a high-frequency roll-off they
 * deliberately do not want.
 *
 * Command (mutates the biquad state).
 */
export class IIRDecimator {
  /** @param {number} oversample */
  constructor(oversample) {
    this.oversample = oversample;
    this.filter = new BiquadCascade(sixPoleLowpassStages(1 / (4 * oversample)));
  }

  /** Command. One output sample from `oversample` input samples. */
  process(buffer) {
    let x = 0;
    for (let i = 0; i < this.oversample; i++) x = this.filter.run(buffer[i]);
    return x;
  }
}

/**
 * `IIRUpsampler` (`dsp/utils/IIRUpsampler.h`) — ZERO-PACK by `oversample` (not
 * repeat: repeating would add the roll-off) and filter. The input is multiplied
 * by `oversample` first because zero packing divides the energy by exactly that.
 *
 * Command (mutates the biquad state).
 */
export class IIRUpsampler {
  /** @param {number} oversample */
  constructor(oversample) {
    this.oversample = oversample;
    this.filter = new BiquadCascade(sixPoleLowpassStages(1 / (4 * oversample)));
  }

  /** Command. Fill `buffer` (length `oversample`) from one input sample. */
  process(buffer, input) {
    let value = input * this.oversample;
    for (let i = 0; i < this.oversample; i++) {
      buffer[i] = this.filter.run(value);
      value = 0;
    }
  }
}

/**
 * `StateVariableFilter<T>` (`dsp/filters/StateVariableFilter.h:40`), the ONE-pole
 * -pair Chamberlin form Super's high-pass is built from — including the ±1000
 * clamp on the band node their own comment calls "figure out why we get these
 * crazy values".
 *
 * Command (mutates z1/z2).
 */
export class ChamberlinSvf {
  constructor() {
    this.z1 = 0;
    this.z2 = 0;
    this.fcGain = 0.001;
    this.qGain = 1;
  }

  /** Command. `params.setFreq`: `fcGain = 2π·fc`, no high-frequency warping. */
  setFreq(fc) {
    this.fcGain = 2 * Math.PI * fc;
  }

  /** Command. `params.setQ`: the internal gain is 1/Q. */
  setQ(q) {
    this.qGain = 1 / q;
  }

  /** Command. One sample; returns {low, high, band}. */
  run(input) {
    const low = this.z2 + this.fcGain * this.z1;
    const high = input - (this.z1 * this.qGain + low);
    let band = high * this.fcGain + this.z1;
    if (band >= SVF_BAND_CLAMP) band = SVF_BAND_CLAMP - 1;
    if (band < -SVF_BAND_CLAMP) band = -(SVF_BAND_CLAMP - 1);
    this.z1 = band;
    this.z2 = low;
    return { low, high, band };
  }
}

/** Their own band-node clamp, verbatim from `StateVariableFilter.h:47`. */
const SVF_BAND_CLAMP = 1000;

/** `StateVariable4PHP`'s two section Qs (`dsp/filters/StateVariable4PHP.h:22`) —
 *  a fourth-order Butterworth high-pass split into two Chamberlin sections. */
const HP4_Q = Object.freeze([0.54119, 1.30656296]);

/**
 * `StateVariable4PHP` (`dsp/filters/StateVariable4PHP.h`) — the four-pole
 * high-pass Super puts on its saw stack to kill the DC the seven detuned ramps
 * leave behind. Two Chamberlin sections in series, both in high-pass mode.
 *
 * Command (mutates both sections).
 */
export class StateVariable4PHP {
  constructor() {
    this.sections = HP4_Q.map((q) => {
      const svf = new ChamberlinSvf();
      svf.setQ(q);
      return svf;
    });
  }

  /** Command. Both sections take the same cutoff. */
  setCutoff(fc) {
    for (const section of this.sections) section.setFreq(fc);
  }

  /** Command. One sample through both sections' HIGH outputs. */
  run(input) {
    let value = input;
    for (const section of this.sections) value = section.run(value).high;
    return value;
  }
}

/**
 * `StateVariableFilter2<T>` (`dsp/filters/StateVariableFilter2.h`) — the form F2
 * runs, which differs from `ChamberlinSvf` in two ways that matter: there is NO
 * band clamp, and `setFreq` MINIMUMS `fcGain` at 0.79 so a cutoff past the
 * stability edge saturates rather than exploding.
 *
 * Command (mutates z1/z2).
 */
export class Svf2 {
  constructor() {
    this.z1 = 0;
    this.z2 = 0;
    this.fcGain = 0.001;
    this.qGain = 1;
  }

  /** Command. `setFreq`, including their 0.79 ceiling. */
  setFreq(fc) {
    this.fcGain = Math.min(Math.PI * 2 * fc, SVF2_FC_GAIN_MAX);
  }

  /** Command. `setQ`, including their 0.49 floor. */
  setQ(q) {
    this.qGain = 1 / Math.max(q, SVF2_Q_MIN);
  }

  /** Command. ONE pass. F2 runs four of these per sample (its 4× oversample),
   *  which is why the mode selection reads the LAST pass's node. */
  run(input) {
    const low = this.z2 + this.fcGain * this.z1;
    const high = input - (this.z1 * this.qGain + low);
    const band = high * this.fcGain + this.z1;
    this.z1 = band;
    this.z2 = low;
    return { low, high, band };
  }
}

/** `StateVariableFilterParams2<float>::setFreq`'s ceiling. */
const SVF2_FC_GAIN_MAX = 0.79;

/** …and `setQ`'s floor. */
const SVF2_Q_MIN = 0.49;

/**
 * `TrapezoidalLowpass<T>` (`dsp/filters/TrapezoidalLowpass.h:28`) — the one-pole
 * each of the ladder's four stages is. Their comment: 6 dB less control-voltage
 * feedthrough than a naive one-pole.
 *
 *   temp = (vin − z)·g2;  out = temp + z;  z = out + temp
 *
 * Command (mutates z).
 */
export class TrapezoidalLowpass {
  constructor() {
    this.z = 0;
  }

  /** Command. One sample at pole gain `g2`. */
  run(vin, g2) {
    const temp = (vin - this.z) * g2;
    const output = temp + this.z;
    this.z = output + temp;
    return output;
  }
}

/**
 * `SchmidtTrigger` + `GateTrigger` (`sqsrc/util/SchmidtTrigger.h`,
 * `dsp/utils/GateTrigger.h`) — the 0.8 V / 1.6 V hysteresis every Squinky gate
 * inlet is conditioned by, plus the RESET LOGIC: a gate that is already high at
 * construction is ignored until it goes low, so a patch that boots with a gate
 * up does not fire a spurious trigger.
 *
 * Command (mutates its latches).
 */
export class GateTrigger {
  /** @param {boolean} wantResetLogic */
  constructor(wantResetLogic = true) {
    this.high = false;
    this.lastGate = false;
    this.triggered = false;
    this.resetting = wantResetLogic;
  }

  /** Command. Clock one sample in volts; `triggered` is the rising edge. */
  go(volts) {
    if (this.high) {
      if (volts < GATE_LOW_VOLTS) this.high = false;
    } else if (volts > GATE_HIGH_VOLTS) this.high = true;
    const newGate = this.high;
    if (this.resetting) {
      if (newGate) {
        this.triggered = false;
        return;
      }
      this.resetting = false;
    }
    this.triggered = newGate && !this.lastGate;
    this.lastGate = newGate;
  }
}

/** `cGateLow` / `cGateHi`, `sqsrc/util/Constants.h:6` and `:11`. */
const GATE_LOW_VOLTS = 0.8;
const GATE_HIGH_VOLTS = 1.6;

/**
 * `MultiLag2` + `Limiter` (`dsp/filters/MultiLag2.h`, `dsp/utils/Limiter.h`) —
 * F2's output limiter. A one-pole peak follower with separate attack and release
 * poles, and a divide-down whenever it exceeds the threshold. The `2π`
 * correction in `setTimes` is theirs and is what makes their millisecond numbers
 * mean what they say.
 *
 * Command (mutates the follower's memory).
 */
export class SquinkyLimiter {
  constructor() {
    this.memory = 0;
    this.lAttack = 0;
    this.lRelease = 0;
    this.inputGain = 1;
    this.threshold = LIMITER_THRESHOLD_VOLTS;
  }

  /** Command. `Limiter::setTimes`, verbatim including the 2π. */
  setTimes(attackMs, releaseMs, sampleTime) {
    const correction = 2 * Math.PI;
    const normAttack = ((1000 / (attackMs * correction)) * sampleTime);
    const normRelease = ((1000 / (releaseMs * correction)) * sampleTime);
    this.lAttack = Math.exp(-2 * Math.PI * normAttack);
    this.lRelease = Math.exp(-2 * Math.PI * normRelease);
  }

  /** Command. `Limiter::setInputGain`. */
  setInputGain(g) {
    this.inputGain = g;
  }

  /** Command. One sample. */
  step(input) {
    const value = input * this.inputGain;
    const magnitude = Math.abs(value);
    const l = magnitude >= this.memory ? this.lAttack : this.lRelease;
    this.memory = value === 0 && this.memory === 0 ? 0 : magnitude * (1 - l) + this.memory * l;
    const gain = this.memory > this.threshold ? this.threshold / this.memory : 1;
    return gain * value;
  }
}

/** `Limiter`'s own ceiling, `float_4 threshold = 5` — Rack's nominal ±5 V. */
const LIMITER_THRESHOLD_VOLTS = 5;

/**
 * `SimdBlocks::sinTwoPi` (`dsp/SimdBlocks.h:118`) — WVCO's own sine, ported
 * VERBATIM rather than replaced by `Math.sin` (D10). It is a quartic with a
 * hand-tuned correction term, accurate to about 0.1%, and that error is not
 * noise: it is a fixed harmonic colour on every note the oscillator plays.
 *
 * IT IS NOT EXACTLY ZERO AT ZERO, and that is theirs rather than a defect:
 * `simdSinTwoPi(0)` measures −5.019e-6, which is the quartic's residual at the
 * bottom of its range and is two orders of magnitude inside the ~1e-3 peak error
 * the pinning test bounds. A first example asserting `< 1e-9` shipped here and
 * was FALSE; it is corrected to the measured envelope rather than to the exact
 * number, because the value is an artefact of the polynomial and not a constant
 * anyone should depend on.
 *
 * @param {number} x - radians, accurate for 0 ≤ x ≤ 2π
 * @returns {number}
 *
 * @example Math.abs(simdSinTwoPi(0)) < 1e-5 // true — see below, it is NOT 0
 * @example Math.abs(simdSinTwoPi(Math.PI / 2) - 1) < 0.01 // true
 * @example Math.abs(simdSinTwoPi(Math.PI)) < 0.01 // true
 */
export function simdSinTwoPi(x) {
  const twoPi = 2 * Math.PI;
  let value = x - (x > Math.PI ? twoPi : 0);
  const negative = value < 0;
  const offset = value + (negative ? Math.PI / 2 : -Math.PI / 2);
  const squared = offset * offset;
  let ret = squared * (1 / 24);
  const correction = ret * squared * (0.02 / 0.254);
  ret += -0.5;
  ret *= squared;
  ret += 1;
  ret -= correction;
  return negative ? -ret : ret;
}

/**
 * Pure function. `SimdBlocks::wrapPhase01` — `x − floor(x)`, so a negative phase
 * (through-zero FM really does produce one) wraps forward rather than staying
 * negative.
 *
 * @param {number} x
 * @returns {number} in [0, 1)
 *
 * @example wrapPhase01(1.25) // 0.25
 * @example wrapPhase01(-0.25) // 0.75
 */
export function wrapPhase01(x) {
  return x - Math.floor(x);
}

/** `rack::dsp::FREQ_C4`, which F2 uses where Super and WVCO use their own
 *  261.626. Both numbers appear in this block ON PURPOSE — see D1. */
export const RACK_FREQ_C4_HZ = 261.6256;

/**
 * Pure function. Refuse an option a kernel does not know, LOUDLY. Every
 * discrete setter below goes through this rather than falling through to a
 * default — a silently ignored option is an Inspector row that does nothing.
 *
 * @param {string} kernel - for the message
 * @param {string} option
 * @param {*} value
 * @param {string[]} allowed
 * @returns {string} the accepted value
 *
 * @example vc10Option("F2Kernel", "mode", "lowpass", ["lowpass"]) // "lowpass"
 */
export function vc10Option(kernel, option, value, allowed) {
  if (!allowed.includes(value)) {
    throw new Error(`${kernel}.${option}: ${JSON.stringify(value)} is not one of ${allowed.join(", ")}`);
  }
  return value;
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. SUPER — squinkylabs "Saws". TIER: SOURCE.
// ═══════════════════════════════════════════════════════════════════════════

/** `SuperDsp::numSaws` — seven ramps, the middle one undetuned. */
const SUPER_SAWS = 7;

/** `SuperDsp::detuneFactors` — the frequency ratio each saw sits at when the
 *  detune curve is fully open. Note they are NOT symmetric about 1. */
const SUPER_DETUNE_FACTORS = Object.freeze([0.89, 0.94, 0.98, 1, 1.02, 1.06, 1.107]);

/** `SuperDsp::sawGainsNorm` — the stereo spread, left row then right row. */
const SUPER_GAINS_NORM = Object.freeze([
  Object.freeze([1, 0.26, 0.87, 0.71, 0.5, 0.97, 0]),
  Object.freeze([0, 0.97, 0.5, 0.71, 0.87, 0.26, 1]),
]);

/** `SuperDsp::sawGainsHardPan` — the same, hard-panned. */
const SUPER_GAINS_HARDPAN = Object.freeze([
  Object.freeze([1.1, 0, 1.1, 1, 0, 1.1, 0]),
  Object.freeze([0, 1.1, 0, 1, 1.1, 0, 1.1]),
]);

/** `runSaws`'s output trim, their comment: "too low 2 too high 10". */
const SUPER_MONO_GAIN = 4.5;

/** `updatePhaseInc`'s ceiling — "limit so saws don't go crazy". */
const SUPER_MAX_PHASE_INC = 0.4;

/** `updateHPFilters`'s ceiling on the DC-blocker's corner. */
const SUPER_HPF_MAX_CUTOFF = 0.1;

/** `Super::getOverSampleRate` — the three CLEAN_PARAM settings. */
export const SUPER_ALIAS_MODES = Object.freeze(["classic", "clean", "clean2"]);
const SUPER_OVERSAMPLE = Object.freeze({ classic: 1, clean: 4, clean2: 16 });

/** `updateMix`'s two polynomials, fitted by ear by their author. */
const SUPER_MIX_CENTER = Object.freeze([-0.55366, 0.99785]);
const SUPER_MIX_SIDES = Object.freeze([-0.73764, 1.2841, 0.044372]);

/** `SawtoothDetuneCurve`'s sixteen points (`SuperDsp.h:20-40`). Their comment
 *  says the data "is pretty regular — could use uniform table"; it is NOT, and
 *  the jump from 0.392 at 0.937 to 1.0 at 1.0 is where the knob's top opens up. */
const superDetuneCurve = nonUniformTable([
  [0, 0], [0.0551, 0.00967], [0.118, 0.022], [0.181, 0.04], [0.244, 0.0467],
  [0.307, 0.059], [0.37, 0.0714], [0.433, 0.0838], [0.496, 0.0967], [0.559, 0.121],
  [0.622, 0.147], [0.748, 0.243], [0.811, 0.293], [0.874, 0.343], [0.937, 0.392], [1, 1],
]);

/**
 * SUPER — seven detuned sawtooths, the supersaw squinkylabs calls "Saws".
 *
 * ── DERIVATION RECORD (TIER: SOURCE) ────────────────────────────────────────
 * squinkylabs/SquinkyVCV-main @ 8b0411e2d1b5a11ffa11280cca00253813212dc7
 *   composites/Super.h        `Super<TBase>::stepn`, `::step`, `::getOversampleRate`
 *   composites/SuperDsp.h     `SuperDsp::updatePhaseInc`, `::updateMix`,
 *                             `::updateStereoGains`, `::runSaws`,
 *                             `::runSawsStereo`, `::updateTrigger`,
 *                             `SawtoothDetuneCurve`
 *   dsp/filters/StateVariable4PHP.h, dsp/utils/IIRDecimator.h
 *
 * ── THE RECURRENCE, IN FLOAT ────────────────────────────────────────────────
 * Every 4 samples (`inputSubSample`, D4):
 *     pitch = 1 + round(octave) + semi/12 + fine/12 + cv + quadBipolar(fm)·fmCV
 *     freq  = 2^(pitch + log2(261.626))
 *     gInc  = freq / fs
 *     d     = detuneCurve(scale(detuneCV, detune, detuneTrim))
 *     inc_i = min(gInc · (1 + (F_i − 1)·d), 0.4) / oversample
 *     m     = scale(mixCV, mix, mixTrim)
 *     gC    = −0.55366·m + 0.99785
 *     gS    = −0.73764·m² + 1.2841·m + 0.044372
 * Every sample, per oversampled tick:
 *     p_i  ← p_i + inc_i,  wrapped by SUBTRACTING 1 (not by floor — see D-WRAP)
 *     mono  = 4.5 · Σ (p_i − 0.5) · (i == 3 ? gC : gS)
 *     out   = hp4(mono),   hp4 cutoff = min(gInc, 0.1)
 * and on a rising trigger every phase is redrawn from `minstd_rand0{57}`.
 *
 * ── DEVIATIONS ──────────────────────────────────────────────────────────────
 * D0, D1 (C4 = 261.626), D2, D3, D4 (÷4), D5 (their seed 57, exposed), D6, D8.
 * D9  — `isStereo` reads OUTPUT connectedness, which a worklet cannot see, so it
 *       is the `stereo` knob. Default ON, because a node whose second output is
 *       a copy of the first is the case an author notices least.
 * D-WRAP — their wrap is `if (phase > 1) phase -= 1`, not `phase - floor(phase)`.
 *       Identical while `inc < 1`, which their own `assert(phaseIncI < .1)`
 *       guarantees, and kept because at a pathological increment the two differ
 *       and theirs is what the module does.
 * D-DECIM — `IIRDecimator` is a six-pole Butterworth designed by DSPFilters'
 *       pole mapping; `sixPoleLowpassStages` is the algebraically identical RBJ
 *       form. Measured in tests/port_vc10_test.js against the Butterworth
 *       magnitude response rather than against a coefficient dump.
 */
export class SuperKernel {
  /**
   * @param {number} sampleRate
   * @param {object} [options] - construct knobs; `seed` (D5)
   */
  constructor(sampleRate, options = {}) {
    this.sampleTime = 1 / sampleRate;
    this.rng = new Minstd0(options.seed === undefined ? SQUINKY_RANDOM_SEED : options.seed);
    this.phase = new Float64Array(SUPER_SAWS);
    this.phaseInc = new Float64Array(SUPER_SAWS);
    this.gainCenter = 0;
    this.gainSides = 0;
    this.stereoGains = [new Float64Array(SUPER_SAWS), new Float64Array(SUPER_SAWS)];
    this.hpfLeft = new StateVariable4PHP();
    this.hpfRight = new StateVariable4PHP();
    this.gate = new GateTrigger(true);
    this.globalPhaseInc = 0;
    this.aliasMode = "classic";
    this.hardPan = false;
    this.stereo = true;
    this.setAliasMode("classic");
  }

  /** Command. CLEAN_PARAM — rebuilds the decimators, so it is an option and not
   *  an AudioParam (its buffers are sized by it). */
  setAliasMode(value) {
    this.aliasMode = vc10Option("SuperKernel", "aliasMode", value, SUPER_ALIAS_MODES);
    this.oversample = SUPER_OVERSAMPLE[this.aliasMode];
    this.decimatorLeft = new IIRDecimator(this.oversample);
    this.decimatorRight = new IIRDecimator(this.oversample);
    this.bufferLeft = new Float64Array(this.oversample);
    this.bufferRight = new Float64Array(this.oversample);
  }

  /** Command. HARD_PAN_PARAM. */
  setHardPan(value) {
    this.hardPan = vc10Option("SuperKernel", "hardPan", value, ["off", "on"]) === "on";
  }

  /** Command. D9's stand-in for `outputs[RIGHT].isConnected()`. */
  setStereo(value) {
    this.stereo = vc10Option("SuperKernel", "stereo", value, ["off", "on"]) === "on";
  }

  /** Command. `Super::stepn` — every 4 samples (D4). */
  control(knobs, signals) {
    const pitchVolts = 1 + Math.round(knobs.octave) + knobs.semi / SEMITONES_PER_OCTAVE
      + knobs.fine / SEMITONES_PER_OCTAVE
      + signals.pitch / VC10_SEMITONES_PER_VOLT
      + quadraticBipolar(knobs.fm) * signals.fm;
    const freq = Math.pow(2, pitchVolts + Math.log2(SQUINKY_C4_HZ));
    this.globalPhaseInc = this.sampleTime * freq;

    const detune = superDetuneCurve(linearScaler(signals.detune_cv, knobs.detune, knobs.detuneTrim, 0, 1));
    for (let i = 0; i < SUPER_SAWS; i++) {
      let inc = Math.min(this.globalPhaseInc * (1 + (SUPER_DETUNE_FACTORS[i] - 1) * detune), SUPER_MAX_PHASE_INC);
      if (this.oversample > 1) inc /= this.oversample;
      this.phaseInc[i] = inc;
    }

    const cutoff = Math.min(this.globalPhaseInc, SUPER_HPF_MAX_CUTOFF);
    this.hpfLeft.setCutoff(cutoff);
    this.hpfRight.setCutoff(cutoff);

    const mix = linearScaler(signals.mix_cv, knobs.mix, knobs.mixTrim, 0, 1);
    this.gainCenter = SUPER_MIX_CENTER[0] * mix + SUPER_MIX_CENTER[1];
    this.gainSides = SUPER_MIX_SIDES[0] * mix * mix + SUPER_MIX_SIDES[1] * mix + SUPER_MIX_SIDES[2];

    const spread = this.hardPan ? SUPER_GAINS_HARDPAN : SUPER_GAINS_NORM;
    for (let i = 0; i < SUPER_SAWS; i++) {
      const monoGain = SUPER_MONO_GAIN * (i === (SUPER_SAWS >> 1) ? this.gainCenter : this.gainSides);
      this.stereoGains[0][i] = monoGain * spread[0][i];
      this.stereoGains[1][i] = monoGain * spread[1][i];
    }
  }

  /** Command. `SuperDsp::runSaws` — advance every phase, sum, apply the trim. */
  runSaws() {
    let mix = 0;
    for (let i = 0; i < SUPER_SAWS; i++) {
      this.phase[i] += this.phaseInc[i];
      if (this.phase[i] > 1) this.phase[i] -= 1;
      mix += (this.phase[i] - 0.5) * (i === (SUPER_SAWS >> 1) ? this.gainCenter : this.gainSides);
    }
    return mix * SUPER_MONO_GAIN;
  }

  /** Command. `SuperDsp::runSawsStereo`, which does NOT apply the 4.5 — the
   *  stereo gain table already carries it (`updateStereoGains`). */
  runSawsStereo(out) {
    let left = 0;
    let right = 0;
    for (let i = 0; i < SUPER_SAWS; i++) {
      this.phase[i] += this.phaseInc[i];
      if (this.phase[i] > 1) this.phase[i] -= 1;
      left += (this.phase[i] - 0.5) * this.stereoGains[0][i];
      right += (this.phase[i] - 0.5) * this.stereoGains[1][i];
    }
    out[0] = left;
    out[1] = right;
  }

  /** Command. `Super::step` — one sample into `frame` as [left, right] volts. */
  sample(knobs, signals, wired, frame) {
    if (this.oversample === 1) {
      if (this.stereo) {
        this.runSawsStereo(frame);
        frame[0] = this.hpfLeft.run(frame[0]);
        frame[1] = this.hpfRight.run(frame[1]);
      } else {
        const mono = this.hpfLeft.run(this.runSaws());
        frame[0] = mono;
        frame[1] = mono;
      }
    } else if (this.stereo) {
      for (let i = 0; i < this.oversample; i++) {
        this.runSawsStereo(SUPER_STEREO_SCRATCH);
        this.bufferLeft[i] = SUPER_STEREO_SCRATCH[0];
        this.bufferRight[i] = SUPER_STEREO_SCRATCH[1];
      }
      frame[0] = this.decimatorLeft.process(this.bufferLeft);
      frame[1] = this.decimatorRight.process(this.bufferRight);
    } else {
      for (let i = 0; i < this.oversample; i++) this.bufferLeft[i] = this.runSaws();
      const mono = this.decimatorLeft.process(this.bufferLeft);
      frame[0] = mono;
      frame[1] = mono;
    }

    // `SuperDsp::updateTrigger` runs at FULL rate, after the audio, and redraws
    // every phase from the seeded generator (D5).
    this.gate.go(signals.trigger);
    if (this.gate.triggered) {
      for (let i = 0; i < SUPER_SAWS; i++) this.phase[i] = this.rng.next01();
    }
  }
}

/** One two-element scratch pair, allocated once: `runSawsStereo` returns two
 *  numbers and `process()` may not allocate (the worklet's real-time rule). */
const SUPER_STEREO_SCRATCH = new Float64Array(2);

// ═══════════════════════════════════════════════════════════════════════════
// 3. F2 — squinkylabs' two-peak state-variable filter. TIER: SOURCE.
// ═══════════════════════════════════════════════════════════════════════════

/** `F2_Poly::Topology`. */
export const F2_TOPOLOGIES = Object.freeze(["single", "series", "parallel", "parallelInv"]);

/** `StateVariableFilter2<T>::Mode`, in their enum order — the MODE_PARAM index
 *  is cast straight to it (`setupModes`), so the order is the wire format. */
export const F2_MODES = Object.freeze(["lowpass", "bandpass", "highpass", "notch"]);

/** `F2_Poly::oversample` — four SVF passes per sample, per bank. */
const F2_OVERSAMPLE = 4;

/** `fastQFunc`'s two exponents: one stage is steeper than two. */
const F2_Q_EXP_ONE_STAGE = 1 / 1.5;
const F2_Q_EXP_TWO_STAGES = 1 / 2.5;

/** `fastFcFunc2`: `FREQ_C4 · 2^(v + 30 − 4) / 2^30`, i.e. `FREQ_C4 · 2^(v − 4)`.
 *  So a 0…10 V control spans 16.35 Hz to 16.7 kHz. */
const F2_FC_VOLT_OFFSET = 4;

/** `setupVolume`: `4·√2 · audioTaper(v/100)`. */
const F2_VOLUME_GAIN = 4 * Math.SQRT2;

/** `ENDPROC`'s hard ceiling, in volts. */
const F2_OUTPUT_CLAMP_VOLTS = 20;

/** `setupLimiter`'s two settings, `(attack ms, release ms, input gain)`. */
const F2_LIMITER_NORMAL = Object.freeze([1, 100, 4]);
const F2_LIMITER_ALT = Object.freeze([3, 20, 20]);

/** `stepm`'s divider is 16 samples and `stepn`'s is 4, so stepm is every FOURTH
 *  control call. See D4. */
const F2_STEPM_EVERY = 4;

/**
 * Pure function. `F2_Poly::fastQFunc` — the resonance control's exponential law.
 * The exponent differs by topology, which is why the Q knob means a different Q
 * in `single` than in `series`.
 *
 * @param {number} qVolts - 0…10
 * @param {number} numStages - 1 or 2
 * @returns {number} the filter Q
 *
 * @example Math.abs(f2Q(0, 1) - 0.5) < 1e-12 // true
 * @example Math.abs(f2Q(3, 1) - (Math.pow(2, 2) - 0.5)) < 1e-12 // true
 * @example f2Q(10, 2) < f2Q(10, 1) // true
 */
export function f2Q(qVolts, numStages) {
  return Math.pow(2, qVolts * (numStages === 1 ? F2_Q_EXP_ONE_STAGE : F2_Q_EXP_TWO_STAGES)) - 0.5;
}

/**
 * Pure function. `F2_Poly::processR_fast` — the peak-separation control. Below
 * 3 V it is halved ("make less sensitive for low value"); above, it is offset.
 * The kink at 3 is theirs.
 *
 * @param {number} rVolts - 0…10
 * @returns {number} the ratio the two peaks are spread by
 *
 * @example Math.abs(f2R(0) - 1) < 1e-12 // true
 * @example Math.abs(f2R(6) - Math.pow(2, 1.5)) < 1e-12 // true
 */
export function f2R(rVolts) {
  const r = rVolts > 3 ? rVolts - 1.5 : rVolts * 0.5;
  return Math.pow(2, r / 3);
}

/**
 * Pure function. `F2_Poly::computeGain_fast` — the makeup gain applied when the
 * limiter is OFF, so a high-Q sweep does not blow up. Their "half bass suck":
 * one stage gets 1/√Q, two get a blend of 1/Q and 1/Q² that depends on how far
 * apart the peaks are.
 *
 * @param {boolean} twoStages
 * @param {number} q
 * @param {number} r
 * @returns {number} a gain
 *
 * @example Math.abs(f2OutputGain(false, 4, 1) - 0.5) < 1e-12 // true
 * @example Math.abs(f2OutputGain(true, 4, 3) - 0.5) < 1e-12 // true
 */
export function f2OutputGain(twoStages, q, r) {
  const oneOverQ = 1 / q;
  if (!twoStages) return Math.sqrt(oneOverQ);
  const oneOverQSq = 1 / (q * q);
  const interp = r * 0.5;
  const blended = interp * oneOverQ + (1 - interp) * oneOverQSq;
  return Math.sqrt(r > 2 ? oneOverQ : blended);
}

/**
 * Pure function. The 0…10 V cutoff control a hertz knob means, inverting
 * `fastFcFunc2`. R7-UNITS clause 2: the knob carries HERTZ, so the mapping to
 * their volts happens here rather than in the author's head.
 *
 * @param {number} hz
 * @returns {number} volts, clamped to their 0…10
 *
 * @example Math.abs(f2CutoffVolts(261.6256 * 2) - 5) < 1e-9 // true
 * @example f2CutoffVolts(1) // 0
 * @example f2CutoffVolts(1e6) // 10
 */
export function f2CutoffVolts(hz) {
  return vc10Clamp(Math.log2(Math.max(hz, 1e-6) / RACK_FREQ_C4_HZ) + F2_FC_VOLT_OFFSET, 0, 10);
}

/**
 * F2 — one or two state-variable peaks, 4× oversampled, in four topologies.
 *
 * ── DERIVATION RECORD (TIER: SOURCE) ────────────────────────────────────────
 * squinkylabs/SquinkyVCV-main @ 8b0411e2d1b5a11ffa11280cca00253813212dc7
 *   composites/F2_Poly.h  `F2_Poly<TBase>::setupFreq`, `::stepn`, `::stepm`,
 *                         `::processGeneric`, `::fastQFunc`, `::fastFcFunc2`,
 *                         `::processR_fast`, `::computeGain_fast`,
 *                         `::setupVolume`, `::setupLimiter`
 *   dsp/filters/StateVariableFilter2.h  `runLP4` / `runBP4` / `runHP4` / `runN4`
 *   dsp/utils/Limiter.h, dsp/filters/MultiLag2.h
 *
 * **`composites/F2.h` IS NOT THE SOURCE** and cannot be: its whole body is
 * inside `#if 0`, its `process()` is `assert(false)`, and line 4 is the literal
 * text `A B C       // don't include this file!`. Their own comment says "This
 * file is out of date! The poly one is the one we use now." A port taken from it
 * would compile, would look right, and would be a filter nobody ships.
 *
 * ── THE RECURRENCE, IN FLOAT ────────────────────────────────────────────────
 * Every 4 samples (D4):
 *     R   = 2^(((r > 3) ? r − 1.5 : r/2) / 3)
 *     Q   = 2^(q · (stages == 1 ? 1/1.5 : 1/2.5)) − 0.5
 *     f   = 261.6256 · 2^(fc − 4) / (4 · fs)
 *     f1  = stages == 2 ? f/R : f,   f2 = stages == 2 ? f·R : f
 * Every sample, FOUR passes of each active SVF (`runLP4` unrolls the same three
 * lines four times):
 *     low  = z2 + fcGain·z1
 *     high = in − (z1·qGain + low)
 *     band = high·fcGain + z1;   z1 = band;  z2 = low
 * then the topology combines the two banks, the limiter or the makeup gain is
 * applied, and the result is scaled by `4√2 · audioTaper(volume/100)` and
 * clamped to ±20 V.
 *
 * ── DEVIATIONS ──────────────────────────────────────────────────────────────
 * D0, D1 (the CV inlet is SEMITONES; the knob is HERTZ), D3, D4, D6, D8, D10.
 * D-CVCACHE — their `setupFreq` skips recomputation when no knob or CV changed.
 *     That is a SPEED cache with no audible effect; recomputing every control
 *     tick is the same filter and one fewer state machine to be wrong.
 * D-VU — the four level lights and their peak detector are panel, not sound.
 */
export class F2Kernel {
  /** @param {number} sampleRate */
  constructor(sampleRate) {
    this.sampleTime = 1 / sampleRate;
    this.svf1 = new Svf2();
    this.svf2 = new Svf2();
    this.limiter = new SquinkyLimiter();
    this.topology = "single";
    this.mode = "lowpass";
    this.limiterEnabled = true;
    this.altLimiter = true;
    this.outputGain = 1;
    this.volume = 1;
    this.controlTick = 0;
    this.applyLimiterTimes();
  }

  /** Command. `setupLimiter` — the alt setting is faster and hits harder. */
  applyLimiterTimes() {
    const [attack, release, gain] = this.altLimiter ? F2_LIMITER_ALT : F2_LIMITER_NORMAL;
    this.limiter.setTimes(attack, release, this.sampleTime);
    this.limiter.setInputGain(gain);
  }

  /** Command. TOPOLOGY_PARAM. */
  setTopology(value) {
    this.topology = vc10Option("F2Kernel", "topology", value, F2_TOPOLOGIES);
  }

  /** Command. MODE_PARAM. */
  setMode(value) {
    this.mode = vc10Option("F2Kernel", "mode", value, F2_MODES);
  }

  /** Command. LIMITER_PARAM. */
  setLimiter(value) {
    this.limiterEnabled = vc10Option("F2Kernel", "limiter", value, ["off", "on"]) === "on";
  }

  /** Command. ALT_LIMITER_PARAM — changes the limiter's own time constants. */
  setAltLimiter(value) {
    this.altLimiter = vc10Option("F2Kernel", "altLimiter", value, ["off", "on"]) === "on";
    this.applyLimiterTimes();
  }

  /** Command. `stepn` (every 4 samples) plus `stepm` (every 16) — D4. */
  control(knobs, signals) {
    const numStages = this.topology === "single" ? 1 : 2;

    const rVolts = trimScaler(vc10Clamp(signals.r_cv, 0, 10), knobs.r, knobs.rTrim, 0, 10, 0, 10);
    const r = f2R(rVolts);

    const qVolts = trimScaler(vc10Clamp(signals.q_cv, 0, 10), knobs.q, knobs.qTrim, 0, 10, 0, 10);
    const q = f2Q(qVolts, numStages);
    this.svf1.setQ(q);
    this.svf2.setQ(q);
    this.outputGain = f2OutputGain(numStages === 2, q, r);

    // D1: the CV inlet carries SEMITONES, so it is twelfth-ed into their volts.
    const fcVolts = trimScaler(
      signals.fc_cv / VC10_SEMITONES_PER_VOLT, f2CutoffVolts(knobs.fc), knobs.fcTrim, 0, 10, 0, 10,
    );
    const freq = ((RACK_FREQ_C4_HZ * Math.pow(2, fcVolts - F2_FC_VOLT_OFFSET)) / F2_OVERSAMPLE) * this.sampleTime;
    this.svf1.setFreq(numStages === 2 ? freq / r : freq);
    this.svf2.setFreq(numStages === 2 ? freq * r : freq);

    this.volume = F2_VOLUME_GAIN * audioTaper(knobs.volume / 100);
    this.controlTick = this.controlTick + 1 >= F2_STEPM_EVERY ? 0 : this.controlTick + 1;
  }

  /** Command. Four SVF passes, returning the selected node of the LAST one —
   *  `StateVariableFilter2<T>::runLP4` and its three siblings. */
  runOversampled(svf, input) {
    let nodes = null;
    for (let i = 0; i < F2_OVERSAMPLE; i++) nodes = svf.run(input);
    if (this.mode === "lowpass") return nodes.low;
    if (this.mode === "bandpass") return nodes.band;
    if (this.mode === "highpass") return nodes.high;
    return nodes.low + nodes.high;
  }

  /** Command. `processGeneric` for one bank. */
  sample(knobs, signals, wired, frame) {
    const input = signals.audio;
    let output;
    if (this.topology === "series") {
      output = this.runOversampled(this.svf2, this.runOversampled(this.svf1, input));
    } else if (this.topology === "parallel") {
      output = this.runOversampled(this.svf1, input) + this.runOversampled(this.svf2, input);
    } else if (this.topology === "parallelInv") {
      output = this.runOversampled(this.svf1, input) - this.runOversampled(this.svf2, input);
    } else {
      output = this.runOversampled(this.svf1, input);
    }
    output = this.limiterEnabled ? this.limiter.step(output) : output * this.outputGain;
    frame[0] = vc10Clamp(output * this.volume, -F2_OUTPUT_CLAMP_VOLTS, F2_OUTPUT_CLAMP_VOLTS);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. FREQUENCY SHIFTER — squinkylabs "Booty Shifter". TIER: SOURCE.
// ═══════════════════════════════════════════════════════════════════════════

/** `Dsp::leftPoles` and `Dsp::rightPoles` (`HilbertFilterDesigner.cpp:22`, `:31`)
 *  — the two six-pole all-pass networks whose phase responses stay 90° apart.
 *  Their comment: good from 4 Hz to 4 kHz, ripple about ±0.15°. */
const HILBERT_LEFT_POLES = Object.freeze([0.3609, 2.7412, 11.1573, 44.7581, 179.6242, 798.4578]);
const HILBERT_RIGHT_POLES = Object.freeze([1.2524, 5.5671, 22.3423, 89.6271, 364.7914, 2770.1114]);

/** `Dsp::shift` — the design's cutoff in hertz, which SCALES every pole. */
const HILBERT_SHIFT_HZ = 4;

/**
 * Pure function. The digital pole each analog Hilbert pole becomes, through
 * DSPFilters' `LowPassTransform`: prewarp `F = tan(π·fc/fs)`, then bilinear
 * `z = (1 + F·s)/(1 − F·s)`. An analog pole at `−p` and a zero at `+p` therefore
 * become `a` and `1/a`, which is exactly a first-order ALL-PASS — the whole
 * point of the design.
 *
 * @param {number} pole - the analog pole, in the prototype's own units
 * @param {number} sampleRate
 * @returns {number} the digital all-pass coefficient, in (0, 1)
 *
 * @example hilbertAllpassCoefficient(0.3609, 48000) < 1 // true
 * @example hilbertAllpassCoefficient(0.3609, 48000) > 0.99 // true
 */
export function hilbertAllpassCoefficient(pole, sampleRate) {
  const f = Math.tan((Math.PI * HILBERT_SHIFT_HZ) / sampleRate);
  return (1 - f * pole) / (1 + f * pole);
}

/**
 * A cascade of first-order all-passes: `y[n] = a·y[n−1] + x[n−1] − a·x[n]`,
 * which is `(z⁻¹ − a)/(1 − a·z⁻¹)` and is unity at DC.
 *
 * ── WHY THIS IS SIX FIRST-ORDER SECTIONS AND NOT THREE BIQUADS ──────────────
 * `HilbertFilterDesigner` hands DSPFilters six REAL poles and six real zeros,
 * and `Cascade` pairs them into three biquads purely so the SIMD path has three
 * stages instead of six. The transfer function is the PRODUCT either way; six
 * first-order sections is the same filter with no pairing convention to get
 * wrong. `tests/port_vc10_test.js` measures the phase difference between the two
 * paths rather than comparing coefficients, which is the property that matters.
 *
 * Command (mutates its delay line).
 */
export class AllpassCascade {
  /** @param {number[]} coefficients */
  constructor(coefficients) {
    this.a = Float64Array.from(coefficients);
    this.xPrev = new Float64Array(coefficients.length);
    this.yPrev = new Float64Array(coefficients.length);
  }

  /** Command. One sample through every section. */
  run(input) {
    let value = input;
    for (let i = 0; i < this.a.length; i++) {
      const y = this.a[i] * this.yPrev[i] + this.xPrev[i] - this.a[i] * value;
      this.xPrev[i] = value;
      this.yPrev[i] = y;
      value = y;
    }
    return value;
  }
}

/** `BootyModule.cpp:132`'s `values[5]` — the shift-range menu. `exp` is 0, which
 *  is what `step()`'s `freqRange > .2` test switches on. */
export const FREQ_SHIFTER_RANGES = Object.freeze(["5hz", "50hz", "500hz", "5khz", "exp"]);
const FREQ_SHIFTER_RANGE_HZ = Object.freeze({ "5hz": 5, "50hz": 50, "500hz": 500, "5khz": 5000, exp: 0 });

/** `step()`'s exponential branch: `cvTotal += 7` then `2^x / 2`, so ±5 V spans
 *  2 Hz to 2 kHz. Their comment: "shift up to GE 2 … down to 2..2k". */
const FREQ_SHIFTER_EXP_OFFSET = 7;

/**
 * FREQUENCY SHIFTER — a true single-sideband shifter (NOT a pitch shifter: it
 * ADDS hertz, so harmonic ratios are destroyed and everything goes bell-like).
 *
 * ── DERIVATION RECORD (TIER: SOURCE) ────────────────────────────────────────
 * squinkylabs/SquinkyVCV-main @ 8b0411e2d1b5a11ffa11280cca00253813212dc7
 *   composites/FrequencyShifter.h  `FrequencyShifter<TBase>::step`
 *   dsp/filters/HilbertFilterDesigner.cpp  `Dsp::Hilb::Design`, the two pole lists
 *   dsp/generators/SinOscillator.h, dsp/generators/SawOscillator.h  `runQuadrature`
 *   src/BootyModule.cpp:124-138  the five-entry range menu (a `dataToJson` field,
 *                                so R7-11 makes it a KNOB, not a hidden variable)
 *
 * ── THE RECURRENCE, IN FLOAT ────────────────────────────────────────────────
 *     v      = clamp(pitchKnob + cv, ±5)
 *     shift  = range > 0.2 ? v·range/5 : 2^(v + 7)/2          [hertz]
 *     φ     ← φ + shift/fs   (wrapping at 1; NEGATIVE increments wrap up)
 *     x      = sin(2πφ),  y = sin(2π·frac(φ + 0.25))          [quadrature pair]
 *     hS     = allpassRight(in),  hC = allpassLeft(in)        [90° apart]
 *     SIN    = x·hS + y·hC        (down-shifted sideband)
 *     COS    = x·hS − y·hC        (up-shifted sideband)
 * The two sidebands are on separate jacks, which is what makes this module a
 * shifter you can hear both halves of rather than a black box.
 *
 * ── DEVIATIONS ──────────────────────────────────────────────────────────────
 * D0, D3, D6 (no trims exist here), D7 (their 2048-bin sine table is evaluated;
 *     the table's own SNR is about 92 dB and `Math.sin` has none of that error),
 * D8.
 * D-ALLPASS — six first-order sections rather than DSPFilters' three paired
 *     biquads. Same transfer function; see `AllpassCascade`.
 * D-STEREO — the L and R halves share the oscillator PARAMS but keep separate
 *     phase accumulators, exactly as `oscState` / `oscStateR` do. They therefore
 *     drift apart only if one is reset, which nothing does — so in practice they
 *     stay locked, and that is the original's behaviour, not a simplification.
 */
export class FreqShifterKernel {
  /** @param {number} sampleRate */
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    this.hilbertSin = new AllpassCascade(HILBERT_RIGHT_POLES.map((p) => hilbertAllpassCoefficient(p, sampleRate)));
    this.hilbertCos = new AllpassCascade(HILBERT_LEFT_POLES.map((p) => hilbertAllpassCoefficient(p, sampleRate)));
    this.hilbertSinR = new AllpassCascade(HILBERT_RIGHT_POLES.map((p) => hilbertAllpassCoefficient(p, sampleRate)));
    this.hilbertCosR = new AllpassCascade(HILBERT_LEFT_POLES.map((p) => hilbertAllpassCoefficient(p, sampleRate)));
    this.phase = 0;
    this.phaseR = 0;
    this.phaseIncrement = 0;
    this.range = "5hz";
  }

  /** Command. The range menu (`BootyModule::dataToJson`'s `range` field). */
  setRange(value) {
    this.range = vc10Option("FreqShifterKernel", "range", value, FREQ_SHIFTER_RANGES);
  }

  /** Command. `step()`'s first half — runs at FULL rate in their code, so this
   *  kernel's roster row declares a control divisor of 1. */
  control(knobs, signals) {
    const cvTotal = vc10Clamp(knobs.pitch + signals.cv, -5, 5);
    const rangeHz = FREQ_SHIFTER_RANGE_HZ[this.range];
    const shiftHz = rangeHz > 0.2
      ? (cvTotal * rangeHz) / 5
      : Math.pow(2, cvTotal + FREQ_SHIFTER_EXP_OFFSET) / 2;
    // `SinOscillator::setFrequency` asserts |f| <= .5; theirs cannot exceed it
    // because the widest range is 5 kHz. Ours clamps rather than asserting,
    // because our `cv` inlet is not bounded by a panel.
    this.phaseIncrement = vc10Clamp(shiftHz / this.sampleRate, -0.5, 0.5);
  }

  /** Command. `SawOscillator::runQuadrature` — returns the phase BEFORE the
   *  increment, and the quadrature tap is a quarter cycle ahead. */
  advance(which) {
    const phase = which === 0 ? this.phase : this.phaseR;
    let next = phase + this.phaseIncrement;
    if (next >= 1) next -= 1;
    if (next < 0) next += 1;
    if (which === 0) this.phase = next; else this.phaseR = next;
    const quadrature = phase + 0.25 >= 1 ? phase + 0.25 - 1 : phase + 0.25;
    FREQ_SHIFTER_SCRATCH[0] = Math.sin(phase * 2 * Math.PI);
    FREQ_SHIFTER_SCRATCH[1] = Math.sin(quadrature * 2 * Math.PI);
  }

  /** Command. One sample; frame is [sin, cos, sin_r, cos_r] in volts. */
  sample(knobs, signals, wired, frame) {
    this.advance(0);
    const x = FREQ_SHIFTER_SCRATCH[0] * this.hilbertSin.run(signals.audio);
    const y = FREQ_SHIFTER_SCRATCH[1] * this.hilbertCos.run(signals.audio);
    this.advance(1);
    const xR = FREQ_SHIFTER_SCRATCH[0] * this.hilbertSinR.run(signals.audio_r);
    const yR = FREQ_SHIFTER_SCRATCH[1] * this.hilbertCosR.run(signals.audio_r);
    frame[0] = x + y;
    frame[1] = x - y;
    frame[2] = xR + yR;
    frame[3] = xR - yR;
  }
}

/** The quadrature pair, allocated once (the worklet's no-allocation rule). */
const FREQ_SHIFTER_SCRATCH = new Float64Array(2);

// ═══════════════════════════════════════════════════════════════════════════
// 5. WVCO — squinkylabs "Kitchen Sink". TIER: SOURCE.
// ═══════════════════════════════════════════════════════════════════════════

/** `WVCODsp::oversampleRate`. */
const WVCO_OVERSAMPLE = 4;

/** `WVCODsp::WaveForm`, in their enum order (the param is cast to it). */
export const WVCO_WAVEFORMS = Object.freeze(["sine", "fold", "sawTri"]);

/** `ADSR16`'s time span: `MIN_TIME` 0.5 ms, `MAX_TIME` 10 s, and the lambda base
 *  is their ratio — so the knob is exponential across four and a half decades. */
const ADSR_MIN_TIME = 0.5e-3;
const ADSR_MAX_TIME = 10;
const ADSR_LAMBDA_BASE = ADSR_MAX_TIME / ADSR_MIN_TIME;

/** `ADSR16::step`'s attack target — it aims PAST 1 and stops when it arrives,
 *  which is what gives the attack its curve rather than an asymptote. */
const ADSR_ATTACK_TARGET = 1.2;

/** `WVCO::stepm`'s three snap settings, as the clip factor `k` each produces. */
export const WVCO_SNAP_MODES = Object.freeze(["off", "soft", "hard"]);
const WVCO_SNAP_K = Object.freeze({ off: 1, soft: 0.6, hard: 0.3 });

/** `stepm`'s per-waveform output normalisation and DC offset. */
const WVCO_LEVEL_BY_WAVEFORM = Object.freeze({ sine: 5, fold: (5 * 5) / 5.6, sawTri: 10 });
const WVCO_OFFSET_BY_WAVEFORM = Object.freeze({ sine: 0, fold: 0, sawTri: -0.5 });

/** `updateShapes_n`'s fold pedestal, so shape 0 still folds a little. */
const WVCO_FOLD_PEDESTAL = 0.095;
const WVCO_FOLD_GAIN = 10;

/** `stepm`: `basePitch = -4 + round(octave) + fine/12`, before the C4 shift. */
const WVCO_OCTAVE_OFFSET = -4;

/** `stepm`'s three magic scalings, their comment: "just values found by
 *  experimenting - no math". */
const WVCO_FM_DEPTH_GAIN = 0.3;
const WVCO_LINEAR_FM_GAIN = 0.003;
const WVCO_FEEDBACK_GAIN = (3 * 2) / 1000;

/** Every CV inlet on this module is scaled by a tenth — `getPolyVoltage · .1`,
 *  i.e. a 10 V CV is unity. */
const WVCO_CV_TO_UNITY = 0.1;

/** `stepn_fullRate`'s gate threshold, in volts. */
const WVCO_GATE_THRESHOLD_VOLTS = 1;

/** `stepm`'s divider is 16 and `stepn`'s is 4, so stepm is every FOURTH control
 *  call (D4). */
const WVCO_STEPM_EVERY = 4;

/**
 * `ADSR16` (`composites/ADSR16.h`), the one-channel case. Their envelope is the
 * VCV Fundamental ADSR with a SNAP: the output is clipped at `s + k(1 − s)` and
 * then multiplied back up by `1/clip`, which steepens the attack without
 * changing its endpoints.
 *
 * Command (mutates env/attacking).
 */
export class Adsr16 {
  constructor() {
    this.env = 0;
    this.attacking = false;
    this.attackLambda = 0;
    this.decayLambda = 0;
    this.releaseLambda = 0;
    this.sustain = 0;
    this.clipValue = 1;
    this.makeupGain = 1;
  }

  /** Command. `ADSR16::setParamValues`; a, d, s, r and k are all 0…1. */
  setParamValues(a, d, s, r, k) {
    this.attackLambda = Math.pow(ADSR_LAMBDA_BASE, -vc10Clamp(a, 0, 1)) / ADSR_MIN_TIME;
    this.decayLambda = Math.pow(ADSR_LAMBDA_BASE, -vc10Clamp(d, 0, 1)) / ADSR_MIN_TIME;
    this.releaseLambda = Math.pow(ADSR_LAMBDA_BASE, -vc10Clamp(r, 0, 1)) / ADSR_MIN_TIME;
    this.sustain = vc10Clamp(s, 0, 1);
    const clipLevel = Math.max(s + k * (1 - s), 0.001);
    this.clipValue = clipLevel;
    this.makeupGain = 1 / clipLevel;
  }

  /** Command. One sample. `gate` is a boolean, `sampleTime` is 1/fs. */
  step(gate, sampleTime) {
    const target = gate ? (this.attacking ? ADSR_ATTACK_TARGET : this.sustain) : 0;
    const lambda = gate ? (this.attacking ? this.attackLambda : this.decayLambda) : this.releaseLambda;
    this.env += (target - this.env) * lambda * sampleTime;
    if (this.env >= 1) this.attacking = false;
    if (!gate) this.attacking = true;
  }

  /** Query. `ADSR16::get` — clipped and made up, so the peak is always 1. */
  get() {
    return this.makeupGain * Math.min(this.env, this.clipValue);
  }
}

/**
 * WVCO — squinkylabs' "Kitchen Sink": a through-zero FM operator with three
 * waveforms, phase feedback, hard sync and its own ADSR routed to four places.
 *
 * ── DERIVATION RECORD (TIER: SOURCE) ────────────────────────────────────────
 * squinkylabs/SquinkyVCV-main @ 8b0411e2d1b5a11ffa11280cca00253813212dc7
 *   composites/WVCO.h  `WVCO<TBase>::stepm`, `::updateFreq_n`,
 *                      `::updateShapes_n`, `::stepn_fullRate`, `::step`,
 *                      `TriFormula::getLeftA`, `::getRightAandB`
 *   dsp/generators/WVCODsp.h  `WVCODsp::step`, `::stepOversampled`, `::doSync`
 *   composites/ADSR16.h  `ADSR16::step`, `::setParamValues`, `::get`
 *   dsp/SimdBlocks.h  `sinTwoPi`, `fold`, `wrapPhase01`
 *
 * ── THE RECURRENCE, IN FLOAT ────────────────────────────────────────────────
 * Every 16 samples (D4):
 *     base   = −4 + round(octave) + fine/12 + log2(261.626)
 *     depth  = 0.3 · audioTaper(fmDepth/100)
 *     shape0 = waveshapeGain/100, audio-tapered ONLY in fold mode
 *     level  = outputLevel/100 · {sine 5, fold 25/5.6, sawTri 10}
 * Every 4 samples:
 *     f      = 2^(base + voct + fm·depth) · round(multiplier)
 *     inc    = clamp(f/fs, ±0.5) / 4
 *     shape  = shape0 · (shapeCV connected ? clamp(shapeCV/10, 0, 1) : 1) · env
 *              then  fold: (shape + 0.095)·10;  sawTri: 0.5 + shape/2
 *     sawTri also solves k = 0.5 + clamp(shape, .01, .99)/2 into the two
 *     line segments  y = x/k  and  y = (x − 1)/(k − 1).
 * Every sample, four oversampled ticks:
 *     mod   = feedback·lastOut + fmIn
 *     φ    ← frac(φ + inc);  φ = 0 at the sync tick
 *     s     = W(frac(φ + mod))
 *     out   = decimate(s) + offset,  then × level
 *
 * ── DEVIATIONS ──────────────────────────────────────────────────────────────
 * D0, D1 (C4 = 261.626), D2 (the gate inlet), D3 (four `isConnected` branches
 *     really are here — sync, linear FM, its depth CV, and feedback CV), D4,
 *     D7, D8, D10 (`sinTwoPi` is NOT replaced — see its docblock).
 * D-OFFSETLAG — `stepm` assigns `dsp[bank].waveformOffset = baseOffset_m` BEFORE
 *     the switch that recomputes `baseOffset_m`, so a waveform change applies
 *     the PREVIOUS waveform's DC offset for one 16-sample block. Reproduced,
 *     because it is a real (if tiny) click on a waveform switch and silently
 *     fixing it would make a bug report unreproducible.
 * D-SNAP2 — `SNAP2_PARAM` is dead in their own code ("This is unused now"); only
 *     `SNAP_PARAM`'s three positions survive, as the `snap` option.
 * D-PATCHVER — `PATCH_VERSION_PARAM` and `convertOldShapeGain` exist to migrate
 *     1.0 patches. Nothing here can hold a 1.0 patch, so neither is ported.
 */
export class WvcoKernel {
  /** @param {number} sampleRate */
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    this.sampleTime = 1 / sampleRate;
    this.adsr = new Adsr16();
    this.decimator = new IIRDecimator(WVCO_OVERSAMPLE);
    this.buffer = new Float64Array(WVCO_OVERSAMPLE);
    this.phaseAcc = 0;
    this.lastOutput = 0;
    this.lastSyncValue = 0;
    this.normalizedFreq = 0;
    this.waveform = "sine";
    this.snap = "off";
    this.adsrToShape = false;
    this.adsrToFeedback = false;
    this.adsrToLevel = false;
    this.adsrToFm = false;
    this.baseShapeGain = 0;
    this.baseOutputLevel = 1;
    this.baseOffset = 0;
    this.waveformOffset = 0;
    this.depth = 0;
    this.baseFmDepth = 0;
    this.baseFeedback = 0;
    this.freqMultiplier = 1;
    this.basePitch = 0;
    this.correctedShape = 1;
    this.aLeft = 2;
    this.aRight = -2;
    this.bRight = 2;
    this.controlTick = 0;
  }

  /** Command. WAVE_SHAPE_PARAM. */
  setWaveform(value) {
    this.waveform = vc10Option("WvcoKernel", "waveform", value, WVCO_WAVEFORMS);
  }

  /** Command. SNAP_PARAM's three positions. */
  setSnap(value) {
    this.snap = vc10Option("WvcoKernel", "snap", value, WVCO_SNAP_MODES);
  }

  /** Command. ADSR_SHAPE_PARAM. */
  setAdsrToShape(value) {
    this.adsrToShape = vc10Option("WvcoKernel", "adsrToShape", value, ["off", "on"]) === "on";
  }

  /** Command. ADSR_FBCK_PARAM. */
  setAdsrToFeedback(value) {
    this.adsrToFeedback = vc10Option("WvcoKernel", "adsrToFeedback", value, ["off", "on"]) === "on";
  }

  /** Command. ADSR_OUTPUT_LEVEL_PARAM. */
  setAdsrToLevel(value) {
    this.adsrToLevel = vc10Option("WvcoKernel", "adsrToLevel", value, ["off", "on"]) === "on";
  }

  /** Command. ADSR_LFM_DEPTH_PARAM. */
  setAdsrToFm(value) {
    this.adsrToFm = vc10Option("WvcoKernel", "adsrToFm", value, ["off", "on"]) === "on";
  }

  /** Command. `WVCO::stepm` — every 16 samples (D4). */
  stepm(knobs) {
    this.basePitch = WVCO_OCTAVE_OFFSET + Math.round(knobs.octave)
      + knobs.fineTune / SEMITONES_PER_OCTAVE + Math.log2(SQUINKY_C4_HZ);
    this.depth = WVCO_FM_DEPTH_GAIN * audioTaper(knobs.fmDepth * 0.01);
    this.freqMultiplier = Math.round(knobs.frequencyMultiplier);
    this.baseFmDepth = knobs.linearFmDepth * WVCO_LINEAR_FM_GAIN;

    this.baseShapeGain = knobs.waveshapeGain / 100;
    if (this.waveform === "fold") this.baseShapeGain = audioTaper(this.baseShapeGain);

    // D-OFFSETLAG: theirs publishes the PREVIOUS block's offset here, before the
    // switch below recomputes it. Reproduced deliberately.
    this.waveformOffset = this.baseOffset;

    this.baseFeedback = knobs.feedback * WVCO_FEEDBACK_GAIN;
    this.baseOutputLevel = (knobs.outputLevel / 100) * WVCO_LEVEL_BY_WAVEFORM[this.waveform];
    this.baseOffset = WVCO_OFFSET_BY_WAVEFORM[this.waveform];

    this.adsr.setParamValues(
      knobs.attack * 0.01, knobs.decay * 0.01, knobs.sustain * 0.01, knobs.release * 0.01,
      WVCO_SNAP_K[this.snap],
    );
  }

  /** Command. `stepn_lowerRate` — every 4 samples, plus `stepm` every fourth of
   *  those. */
  control(knobs, signals, wired) {
    if (this.controlTick === 0) this.stepm(knobs);
    this.controlTick = this.controlTick + 1 >= WVCO_STEPM_EVERY ? 0 : this.controlTick + 1;

    // updateFreq_n. D1: the `voct` port is SEMITONES, so it is twelfth-ed here.
    const pitch = this.basePitch + signals.voct / VC10_SEMITONES_PER_VOLT + signals.fm * this.depth;
    const freq = Math.pow(2, pitch) * this.freqMultiplier;
    this.normalizedFreq = vc10Clamp(freq * this.sampleTime, -0.5, 0.5) / WVCO_OVERSAMPLE;

    // updateShapes_n.
    const envMult = this.adsrToShape ? this.adsr.get() : 1;
    let baseGain = this.baseShapeGain;
    if (wired.shape) baseGain = vc10Clamp(baseGain * signals.shape * WVCO_CV_TO_UNITY, 0, 1);
    let corrected = baseGain * envMult;
    if (this.waveform === "fold") corrected = (corrected + WVCO_FOLD_PEDESTAL) * WVCO_FOLD_GAIN;
    else if (this.waveform === "sawTri") corrected = 0.5 + corrected / 2;
    this.correctedShape = corrected;

    if (this.waveform === "sawTri") {
      const k = 0.5 + vc10Clamp(baseGain * envMult, 0.01, 0.99) / 2;
      this.aLeft = 1 / k;
      this.aRight = 1 / (k - 1);
      this.bRight = -this.aRight;
    }
  }

  /** Command. `WVCODsp::stepOversampled` — one oversampled tick's waveform. */
  shape(phase) {
    if (this.waveform === "fold") {
      return audioMathFold(simdSinTwoPi(phase * 2 * Math.PI) * this.correctedShape);
    }
    if (this.waveform === "sawTri") {
      return phase < this.correctedShape ? phase * this.aLeft : this.aRight * phase + this.bRight;
    }
    return simdSinTwoPi(phase * 2 * Math.PI);
  }

  /** Command. `WVCO::step` + `WVCODsp::step`. One sample of `main`, in volts. */
  sample(knobs, signals, wired, frame) {
    this.adsr.step(signals.gate > WVCO_GATE_THRESHOLD_VOLTS, this.sampleTime);

    let feedbackAmount = this.baseFeedback;
    if (this.adsrToFeedback) feedbackAmount *= this.adsr.get();
    if (wired.feedback) {
      feedbackAmount = vc10Clamp(feedbackAmount * signals.feedback * WVCO_CV_TO_UNITY, 0, 1);
    }
    let outputLevel = this.baseOutputLevel;
    if (this.adsrToLevel) outputLevel *= this.adsr.get();

    let fmInput = 0;
    let syncValue = 0;
    if (wired.sync || wired.linear_fm) {
      let scaling = this.baseFmDepth;
      if (this.adsrToFm) scaling *= this.adsr.get();
      if (wired.linear_fm_depth) {
        scaling = vc10Clamp(scaling * signals.linear_fm_depth * WVCO_CV_TO_UNITY, 0, 1);
      }
      fmInput = signals.linear_fm * scaling;
      syncValue = signals.sync;
    }

    // `WVCODsp::doSync` — the crossing is located to SUB-SAMPLE resolution and
    // turned into an index into the oversample loop, which is why sync here does
    // not add the staircase a per-sample reset would.
    let syncIndex = -1;
    if (wired.sync) {
      const shifted = syncValue - WVCO_SYNC_THRESHOLD_VOLTS;
      if (shifted > 0 && this.lastSyncValue <= 0) {
        const delta = shifted - this.lastSyncValue;
        syncIndex = Math.trunc((1 - shifted / delta) * WVCO_OVERSAMPLE);
      }
      this.lastSyncValue = shifted;
    }

    const phaseMod = feedbackAmount * this.lastOutput + fmInput;
    for (let i = 0; i < WVCO_OVERSAMPLE; i++) {
      this.phaseAcc = wrapPhase01(this.phaseAcc + this.normalizedFreq);
      if (syncIndex === 0) this.phaseAcc = 0;
      this.buffer[i] = this.shape(wrapPhase01(this.phaseAcc + phaseMod));
      syncIndex -= 1;
    }
    const finalSample = this.decimator.process(this.buffer) + this.waveformOffset;
    this.lastOutput = finalSample;
    frame[0] = finalSample * outputLevel;
  }
}

/** `doSync`'s `syncValue -= float_4(0.01f)` — the crossing is detected 10 mV
 *  above zero so a signal resting exactly at 0 V cannot chatter. */
const WVCO_SYNC_THRESHOLD_VOLTS = 0.01;

// ═══════════════════════════════════════════════════════════════════════════
// 6. FILT — squinkylabs' Moog-ish ladder, fifteen types. TIER: SOURCE.
// ═══════════════════════════════════════════════════════════════════════════

/** `LadderFilter<T>::oversampleRate`. */
const FILT_OVERSAMPLE = 4;

/** `LadderFilter<T>::Types`, in enum order, with the mixer taps each selects
 *  (`setType`) and whether it bypasses the first pole. THE ORDER IS THE WIRE
 *  FORMAT: their TYPE_PARAM is an index cast straight to the enum. */
export const FILT_TYPES = Object.freeze([
  "lp4", "lp3", "lp2", "lp1", "bp2", "hp2lp1", "hp3lp1", "bp4",
  "lpNotch", "ap3lp1", "hp3", "hp2", "hp1", "notch", "phaser",
]);

/** Their `getTypeNames()`, in the same order — the panel words, for the spec. */
export const FILT_TYPE_LABELS = Object.freeze([
  "4P LP", "3P LP", "2P LP", "1P LP", "2P BP", "2HP+1LP", "3HP+1LP", "4P BP",
  "LP+Notch", "3AP+1LP", "3P HP", "2P HP", "1P HP", "Notch", "Phaser",
]);

/** `setType`'s tap vectors, stage 0 first. The 0.68, 1.36, 2.05, 2.73 and 4.12
 *  are theirs and are what make a ladder's four lowpass taps sum to a highpass. */
const FILT_TAPS = Object.freeze({
  lp4: [0, 0, 0, 1],
  lp3: [0, 0, 1, 0],
  lp2: [0, 1, 0, 0],
  lp1: [1, 0, 0, 0],
  bp2: [0.68 * 2, -0.68 * 2, 0, 0],
  hp2lp1: [0.68 * 2, -1.36 * 2, 0.68 * 2, 0],
  hp3lp1: [0.68 * 4, -2.05 * 4, 2.05 * 4, -0.68 * 4],
  bp4: [0, -0.68 * 4, 1.36 * 4, -0.68 * 4],
  lpNotch: [0.68, -1.36, 1.36, 0],
  ap3lp1: [0.68, -2.05, 4.12, -2.73],
  hp3: [1, -3, 3, -1],
  hp2: [1, -2, 1, 0],
  hp1: [1, -1, 0, 0],
  notch: [1, -2, 2, 0],
  phaser: [1, -3, 6, -4],
});

/** The five types that open the first pole right up instead of using it. */
const FILT_BYPASS_FIRST = Object.freeze(new Set(["hp3", "hp2", "hp1", "notch", "phaser"]));

/** `LadderFilter<T>::Voicing`, in enum order; the labels are `getVoicingNames`. */
export const FILT_VOICINGS = Object.freeze(["transistor", "asymClip", "fold", "asymFold", "clean"]);
export const FILT_VOICING_LABELS = Object.freeze(["Transistor", "Asym Clip", "Fold", "Asym Fold", "Clean"]);

/** `updateFilter`'s bypass pole: the first stage is parked at 0.9 of Nyquist. */
const FILT_BYPASS_NORM_FC = 0.9;

/** `PROC_PREAMBLE`'s input clamp and `PROC_END`'s output clamp, in their own
 *  internal units (the ±5 V scaling happens in `getOutput`). */
const FILT_INPUT_CLAMP = 3;
const FILT_OUTPUT_CLAMP = 1.7;

/** `getOutput`: the ladder works at ±1 internally and leaves at Rack level. */
const FILT_OUTPUT_VOLTS = 5;

/** `LadderFilterBank::stepn`'s resonance shaping — 0…2 is linear to 2.8, then
 *  the top half is compressed into 2.8…4 so self-oscillation is reachable but
 *  not the whole top of the knob. */
const FILT_Q_MIDDLE = 2.8;

/** …and its drive law: `0.15 + 4·audioTaper(x)`. */
const FILT_DRIVE_FLOOR = 0.15;
const FILT_DRIVE_SPAN = 4;

/** `stepn`'s frequency law: `exp2(cv1 + cv2 + 6) · 10` hertz, read from
 *  `ObjectCache::getExp2()` whose domain is log2(4)…log2(40000). */
const FILT_FC_OFFSET_VOLTS = 6;
const FILT_FC_SCALE_HZ = 10;
const FILT_EXP2_X_MIN = Math.log2(4);
const FILT_EXP2_X_MAX = Math.log2(40000);

/** `stepn`'s normalized-cutoff clamp. */
const FILT_NORM_FC_MIN = 0.0000001;
const FILT_NORM_FC_MAX = 0.48;

/** `EdgeTables`'s resolution — twenty bins over 0…1, and the resolution is the
 *  SOUND here, not a speed device (D7): the function it tabulates has a STEP at
 *  edge = 0.5 and the table smears it across one bin. */
const FILT_EDGE_TABLE_BINS = 20;

/** `makeTrapFilter_Lookup` (`TrapezoidalLowpass.h:52`) — normalized frequency to
 *  the one-pole's `g2`, as fourteen measured points. */
const filtG2Lookup = nonUniformTable([
  [0.309937, 0.6], [0.202148, 0.428571], [0.112793, 0.272727], [0.058472, 0.157895],
  [0.029602, 0.085714], [0.014893, 0.044776], [0.007446, 0.022901], [0.003723, 0.011583],
  [0.001892, 0.005825], [0.000977, 0.002921], [0.000488, 0.001463], [0.000244, 0.000732],
  [0.000122, 0.000366], [0.000061, 0.000183],
]);

/** `LadderFilter<T>::initQLookup` — the maximum stable feedback at each
 *  normalized cutoff, "derived by CalQ with desiredGain = 5, tolerance 1 dB".
 *  This is why the resonance knob does not blow the filter up when you sweep. */
const filtMaxFeedback = nonUniformTable([
  [0.001134, 3.53125], [0.003933, 3.625], [0.006732, 3.625], [0.01233, 3.625],
  [0.023526, 3.625], [0.045918, 3.625], [0.090703, 3.25], [0.092971, 3.25],
  [0.295918, 2.6875], [0.498866, 2.390137],
]);

/** `ObjectCache::getTanh5` — 256 bins over ±5. Evaluated (D7): `Math.tanh` is
 *  the same curve without the table's own interpolation error. */
const filtTanh = (x) => Math.tanh(x);

/**
 * Pure function. `EdgeTables`'s tabulated function, before tabulation: the edge
 * knob picks a per-stage gain ratio, and the FLOOR of that ratio steps at 0.5 —
 * lower for the 4-pole lowpass than for every other type.
 *
 * @param {boolean} is4PLP
 * @param {number} rawEdge - 0…1
 * @param {number} stage - 0…3
 * @returns {number} that stage's gain
 *
 * @example Math.abs(filtEdgeGain(true, 0, 0) - filtEdgeGain(true, 0, 3)) > 0 // true
 * @example filtEdgeGain(true, 0, 0) > filtEdgeGain(true, 0, 3) // true
 */
export function filtEdgeGain(is4PLP, rawEdge, stage) {
  const k = rawEdge > 0.5 ? (is4PLP ? 0.2 : 0.5) : (is4PLP ? 0.6 : 0.8);
  return distributeEvenly(4, k + (rawEdge * (1 - k)) / 0.5)[stage];
}

/** The eight `EdgeTables` (4-pole-lowpass × four stages, other × four stages),
 *  built once at module load exactly as their constructor does. */
const FILT_EDGE_TABLES = Object.freeze([false, true].map((is4PLP) => (
  Object.freeze([0, 1, 2, 3].map((stage) => (
    uniformTable((edge) => filtEdgeGain(is4PLP, edge, stage), FILT_EDGE_TABLE_BINS, 0, 1)
  )))
)));

/**
 * ONE ladder — `LadderFilter<T>`. Filt holds two of these (left and right), and
 * every knob is pushed into both.
 *
 * ── DERIVATION RECORD (TIER: SOURCE) ────────────────────────────────────────
 * squinkylabs/SquinkyVCV-main @ 8b0411e2d1b5a11ffa11280cca00253813212dc7
 *   dsp/filters/LadderFilter.h  `run`, the `PROC_PREAMBLE`/`BODY`/`PROC_END`
 *                               macro-built voicings, `setType`, `setEdge`,
 *                               `updateSlope`, `updateFeedback`,
 *                               `processFeedback`, `initQLookup`, `EdgeTables`
 *   dsp/filters/TrapezoidalLowpass.h  the one-pole and `makeTrapFilter_Lookup`
 *   dsp/utils/IIRUpsampler.h, IIRDecimator.h  the 4× oversampling pair
 *
 * ── THE RECURRENCE, IN FLOAT (one oversampled tick) ─────────────────────────
 *     t  = clamp(x − F·s₃, ±3)
 *     for stage k = 0…3:   t = shape_k(t · g_k);  t = pole_k(t, G_k);  s_k = t
 *     y  = clamp(Σ s_k · tap_k, ±1.7)
 * where F is the feedback after `processFeedback` shapes it:
 *     u = F/4;   F' = u(2 − u) · maxFeedback(fcNorm)
 * `shape_k` is the voicing (tanh, one-sided clip, fold …), `g_k` is the EDGE
 * gain and `G_k` the per-stage pole gain, which the capacitor SPREAD pulls
 * apart geometrically about their product of 1.
 *
 * ── DEVIATIONS ──────────────────────────────────────────────────────────────
 * D0, D3, D4 (÷4), D6, D7 (the EDGE tables ARE ported; tanh and exp2 are not),
 * D8.
 * D-QCOMP — `disableQComp()` exists only for their calibration harness and is
 *     not exposed.
 * D-ASYM — `AsymWaveShaper` is `#include`d and its `TRIODE*` macros are all
 *     commented out; no shipped voicing calls it, so it is not ported.
 * D-LEDS — the four slope LEDs and the level meter are panel, not sound.
 *
 * Command (mutates four poles, four stage memories and both resamplers).
 */
export class LadderFilter {
  constructor() {
    this.poles = [new TrapezoidalLowpass(), new TrapezoidalLowpass(), new TrapezoidalLowpass(), new TrapezoidalLowpass()];
    this.stageOutputs = new Float64Array(4);
    this.stageG = new Float64Array(4).fill(0.001);
    this.stageGain = new Float64Array(4).fill(1);
    this.stageFreqOffsets = new Float64Array(4).fill(1);
    this.taps = Float64Array.from(FILT_TAPS.lp4);
    this.type = "lp4";
    this.voicing = "transistor";
    this.bypassFirstStage = false;
    this.g = 0.001;
    this.lastNormalizedFc = 0.0001;
    this.requestedFeedback = 0;
    this.adjustedFeedback = 0;
    this.gain = 0.3;
    this.bassMakeupGain = 1;
    this.finalVolume = 1;
    this.slope = 3;
    this.mixedOutput = 0;
    this.up = new IIRUpsampler(FILT_OVERSAMPLE);
    this.down = new IIRDecimator(FILT_OVERSAMPLE);
    this.buffer = new Float64Array(FILT_OVERSAMPLE);
    this.rawEdge = 0;
    this.updateStageGains();
  }

  /** Command. `setType` — taps, bypass, then every derived quantity. */
  setType(type) {
    this.type = type;
    this.bypassFirstStage = FILT_BYPASS_FIRST.has(type);
    this.taps.set(FILT_TAPS[type]);
    this.updateFilter();
    this.updateSlope();
    this.updateStageGains();
  }

  /** Command. `getGfromNormFreq` — note the ÷4: the pole runs at the
   *  OVERSAMPLED rate, so its normalized frequency is a quarter of the host's. */
  gFromNormFreq(nf) {
    return filtG2Lookup(nf / FILT_OVERSAMPLE);
  }

  /** Command. `setNormalizedFc`. */
  setNormalizedFc(nf) {
    this.lastNormalizedFc = nf;
    this.g = this.gFromNormFreq(nf);
    this.updateFilter();
    this.updateFeedback();
  }

  /** Command. `updateFilter` — spread the four poles and honour the bypass. */
  updateFilter() {
    for (let i = 0; i < 4; i++) this.stageG[i] = this.g * this.stageFreqOffsets[i];
    if (this.bypassFirstStage) this.stageG[0] = this.gFromNormFreq(FILT_BYPASS_NORM_FC);
  }

  /** Command. `setFreqSpread` — the "capacitor" control. Halved first, so the
   *  knob's top is a 1.5× ratio between neighbouring poles, not 2×. */
  setFreqSpread(s) {
    this.stageFreqOffsets.set(distributeEvenly(4, s * 0.5 + 1));
    this.updateFilter();
  }

  /** Command. `updateSlope` — a CONTINUOUS crossfade between the four lowpass
   *  taps, and only in 4-pole lowpass mode; every other type ignores it. */
  updateSlope() {
    if (this.type !== "lp4") return;
    const iSlope = Math.floor(this.slope);
    for (let i = 0; i < 4; i++) {
      if (i === iSlope) {
        this.taps[i] = (i + 1) - this.slope;
        if (i < 3) this.taps[i + 1] = this.slope - i;
      } else if (i !== iSlope + 1) {
        this.taps[i] = 0;
      }
    }
  }

  /** Command. `setSlope`, clamped to their 0…3. */
  setSlope(slope) {
    this.slope = vc10Clamp(slope, 0, 3);
    this.updateSlope();
  }

  /** Command. `setEdge` + `updateStageGains`. */
  setEdge(edge) {
    this.rawEdge = edge;
    this.updateStageGains();
  }

  /** Command. `updateStageGains` — the edge tables, chosen by type. */
  updateStageGains() {
    const tables = FILT_EDGE_TABLES[this.type === "lp4" ? 1 : 0];
    for (let i = 0; i < 4; i++) this.stageGain[i] = tables[i](this.rawEdge);
  }

  /** Command. `setFeedback` + `updateFeedback` + `processFeedback`. */
  setFeedback(f) {
    this.requestedFeedback = f;
    this.updateFeedback();
  }

  /** Command. `processFeedback` — a smooshed parabola against the measured
   *  stability ceiling, which is what keeps a resonance sweep from exploding. */
  updateFeedback() {
    const u = this.requestedFeedback * 0.25;
    this.adjustedFeedback = u * (2 - u) * filtMaxFeedback(this.lastNormalizedFc);
  }

  /** Command. `setVolume` — `4·vol²`. */
  setVolume(vol) {
    this.finalVolume = 4 * vol * vol;
  }

  /** Command. One stage's nonlinearity — the `BODY(...)` macro's four slots,
   *  per voicing. Their `TANH()` is `2·tanh(0.5·t)`, which is a tanh with the
   *  knee pushed out so the ladder's own gain staging lands in its linear part. */
  shape(stage, t) {
    switch (this.voicing) {
      case "transistor":
        return 2 * filtTanh(0.5 * t);
      case "asymClip":
        return stage % 2 === 0 ? Math.min(t, 1) : Math.max(t, -1);
      case "fold":
        return stage === 0 ? audioMathFold(t * 0.5) : audioMathFold(t);
      case "asymFold":
        return stage % 2 === 0
          ? (t > 0 ? audioMathFold(t) : t)
          : (t < 0 ? audioMathFold(t) : t);
      default:
        return t;
    }
  }

  /** Command. `LadderFilter<T>::run` — up-sample, four ticks, down-sample. */
  run(input) {
    this.up.process(this.buffer, input * this.gain);
    for (let i = 0; i < FILT_OVERSAMPLE; i++) {
      let temp = vc10Clamp(this.buffer[i] - this.adjustedFeedback * this.stageOutputs[3], -FILT_INPUT_CLAMP, FILT_INPUT_CLAMP);
      for (let stage = 0; stage < 4; stage++) {
        temp = this.shape(stage, temp * this.stageGain[stage]);
        temp = this.poles[stage].run(temp, this.stageG[stage]);
        this.stageOutputs[stage] = temp;
      }
      let mixed = 0;
      for (let stage = 0; stage < 4; stage++) mixed += this.stageOutputs[stage] * this.taps[stage];
      this.buffer[i] = vc10Clamp(mixed, -FILT_OUTPUT_CLAMP, FILT_OUTPUT_CLAMP);
    }
    this.mixedOutput = this.down.process(this.buffer) * this.finalVolume;
  }

  /** Query. `getOutput` — ±1 internal to Rack volts, with the bass makeup. */
  getOutput() {
    return this.mixedOutput * FILT_OUTPUT_VOLTS * this.bassMakeupGain;
  }
}

/**
 * FILT — the ladder above, twice (stereo), with `LadderFilterBank::stepn`'s
 * knob laws and `Filt::setupProcessingVars`'s routing.
 *
 * ── DERIVATION RECORD (TIER: SOURCE) ────────────────────────────────────────
 * squinkylabs/SquinkyVCV-main @ 8b0411e2d1b5a11ffa11280cca00253813212dc7
 *   composites/Filt.h              `Filt<TBase>::stepn`, `::step`,
 *                                  `::setupProcessingVars`
 *   composites/LadderFilterBank.h  `stepn` (every knob law), `step` (routing)
 *   dsp/filters/LadderFilter.h     see `LadderFilter` above
 *
 * ── THE KNOB LAWS, IN FLOAT ─────────────────────────────────────────────────
 *     fc   = 10 · 2^clamp(scale(cv1, fcKnob, trim1) + scale(cv2, 0, trim2) + 6)
 *     res  = scale(qCV, qKnob, qTrim) → 0…4, kinked at 2 through 2.8
 *     bass = 1 + bassMakeup · res
 *     gain = 0.15 + 4 · audioTaper(scale(driveCV, driveKnob, driveTrim))
 *     edge = scale(edgeCV, edgeKnob, edgeTrim) → 0…1
 *     slope= scale(slopeCV, slopeKnob, slopeTrim) → 0…3
 *
 * ── DEVIATIONS ──────────────────────────────────────────────────────────────
 * All of `LadderFilter`'s, plus:
 * D9 — their mode decoder reads BOTH input and OUTPUT connectedness. A worklet
 *     sees only inputs, so the mode is decided from L/R INPUTS alone and both
 *     outputs are always driven: stereo when both inputs are wired, otherwise
 *     the one live filter is copied to both. The only case this changes is
 *     "stereo inputs, one output patched", which their code would run in mono.
 * D-POLYMODE — `setPoly(true)` is a context-menu mode that changes the routing
 *     table. Our wire is mono (D8), so the non-poly path is the only one ported.
 */
export class FiltKernel {
  /** @param {number} sampleRate */
  constructor(sampleRate) {
    this.sampleTime = 1 / sampleRate;
    this.left = new LadderFilter();
    this.right = new LadderFilter();
    this.type = "lp4";
    this.voicing = "transistor";
  }

  /** Command. TYPE_PARAM, pushed into both ladders. */
  setType(value) {
    this.type = vc10Option("FiltKernel", "type", value, FILT_TYPES);
    this.left.setType(this.type);
    this.right.setType(this.type);
  }

  /** Command. VOICING_PARAM. */
  setVoicing(value) {
    this.voicing = vc10Option("FiltKernel", "voicing", value, FILT_VOICINGS);
    this.left.voicing = this.voicing;
    this.right.voicing = this.voicing;
  }

  /** Command. `LadderFilterBank::stepn` — every 4 samples (D4). */
  control(knobs, signals) {
    const freqCV = linearScaler(signals.cv1, knobs.fc, knobs.fc1Trim, -5, 5)
      + linearScaler(signals.cv2, 0, knobs.fc2Trim, -5, 5)
      + FILT_FC_OFFSET_VOLTS;
    const fc = FILT_FC_SCALE_HZ * Math.pow(2, vc10Clamp(freqCV, FILT_EXP2_X_MIN, FILT_EXP2_X_MAX));
    const normFc = vc10Clamp(fc * this.sampleTime, FILT_NORM_FC_MIN, FILT_NORM_FC_MAX);

    let res = linearScaler(signals.q_cv, knobs.q, knobs.qTrim, 0, 4);
    res = res < 2 ? (res * FILT_Q_MIDDLE) / 2 : 0.5 * (res - 2) * (4 - FILT_Q_MIDDLE) + FILT_Q_MIDDLE;
    const makeupGain = 1 + knobs.bassMakeup * res;

    const gain = FILT_DRIVE_FLOOR
      + FILT_DRIVE_SPAN * audioTaper(linearScaler(signals.drive_cv, knobs.drive, knobs.driveTrim, 0, 1));
    const edge = linearScaler(signals.edge_cv, knobs.edge, knobs.edgeTrim, 0, 1);
    const slope = linearScaler(signals.slope_cv, knobs.slope, knobs.slopeTrim, 0, 3);

    for (const filter of [this.left, this.right]) {
      filter.setVolume(knobs.masterVolume);
      filter.setNormalizedFc(normFc);
      filter.setFeedback(res);
      filter.bassMakeupGain = makeupGain;
      filter.gain = gain;
      filter.setEdge(edge);
      filter.setSlope(slope);
      filter.setFreqSpread(knobs.spread);
    }
  }

  /** Command. `Filt::step` — one sample; frame is [left, right] in volts. */
  sample(knobs, signals, wired, frame) {
    if (wired.l_audio && wired.r_audio) {
      this.left.run(signals.l_audio);
      this.right.run(signals.r_audio);
      frame[0] = this.left.getOutput();
      frame[1] = this.right.getOutput();
      return;
    }
    // D9: with one input live, one ladder runs and both outputs carry it.
    this.left.run(wired.r_audio ? signals.r_audio : signals.l_audio);
    const mono = this.left.getOutput();
    frame[0] = mono;
    frame[1] = mono;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 7. THE SHARED VULT DSP BLOCKS
//
// ── WHAT IS AND IS NOT A PORT HERE, SAID ONCE ──────────────────────────────
// The Vult Rack modules are CLOSED SOURCE. Their author (Leonardo Laguna Ruiz /
// modlfo) publishes the DSP building blocks they are built from, in the Vult
// language, at github.com/vult-dsp/vult @ cc56038e06ae4745b17bcd7e611e7b21d87ea51c,
// and each module's own manual (github.com/modlfo/VultModules, gh-pages branch @
// 99629d35103eaba67acf35f1b906c4b5bcfb22ff) names the topology it uses.
//
// So everything in THIS section is a real transcription of the author's own
// published code, function by function. Everything in the seven kernels that
// follow is an ASSEMBLY of those blocks guided by the manual, and every knob law
// in them is a MODEL. Each kernel says which of its parts is which. Do not read
// a Vult kernel as a transcription; read this section as one.
// ═══════════════════════════════════════════════════════════════════════════

/** `examples/util/util.vult`: `cvToPitch(cv) = cv·120 + 24`. */
const VULT_CV_TO_PITCH_SCALE = 120;

/** Their frequency law's exponent, `ln(2)/12` to sixteen digits — so their
 *  `8.1758·exp(0.0577623·pitch)` IS `8.1758·2^(pitch/12)`, and writing it as a
 *  power of two rather than as their `exp` is exact, not an approximation. */
const VULT_PITCH_EXP = 0.057762265046662105;

/**
 * Pure function. `Util.cvToPitch` — Vult's own CV convention, where a whole
 * 0…1 CV spans ten octaves. A Rack V/oct arrives as `volts/10`.
 *
 * @param {number} cv - Vult CV, 0…1 for the usable range
 * @returns {number} MIDI note number
 *
 * @example vultCvToPitch(0) // 24
 * @example vultCvToPitch(0.5) // 84
 */
export function vultCvToPitch(cv) {
  return cv * VULT_CV_TO_PITCH_SCALE + VULT_ZERO_VOLT_MIDI;
}

/**
 * Pure function. `Util.cvTokHz`'s inner law, in hertz rather than kilohertz:
 * `8.175798915643707 · exp(0.057762265046662105 · pitch)`.
 *
 * @param {number} pitch - MIDI note number
 * @returns {number} hertz
 *
 * @example Math.abs(vultPitchToHz(69) - 440) < 1e-9 // true
 * @example Math.abs(vultPitchToHz(24) - 32.7031956) < 1e-6 // true
 */
export function vultPitchToHz(pitch) {
  return VULT_MIDI_ROOT_HZ * Math.exp(VULT_PITCH_EXP * pitch);
}

/**
 * Pure function. `Util.cubic_clipper` — the soft clipper every Vult filter puts
 * in its feedback path. Flat outside ±2/3, cubic inside, C1 at the join.
 *
 * @param {number} x
 * @returns {number} in [-2/3, 2/3]
 *
 * @example vultCubicClipper(1) // 0.6666666666666666
 * @example vultCubicClipper(-1) // -0.6666666666666666
 * @example vultCubicClipper(0) // 0
 * @example Math.abs(vultCubicClipper(0.5) - (0.5 - 0.125 / 3)) < 1e-15 // true
 */
export function vultCubicClipper(x) {
  const limit = 2 / 3;
  if (x <= -limit) return -limit;
  if (x >= limit) return limit;
  return x - (x * x * x) / 3;
}

/** `effects/saturate_soft.vult`'s scale — "tanh saturation with limits around
 *  −16 to 16", which in Rack's volts is well past the ±10 V a cable carries. */
const VULT_SATURATE_SCALE = 16;

/**
 * Pure function. `Saturate_soft.process` — `16·tanh(x/16)`. Their version reads
 * a 241-point table over ±24; this evaluates it (D7), which removes about 1e-4
 * of interpolation error and adds none.
 *
 * @param {number} x - volts
 * @returns {number} volts, asymptotically ±16
 *
 * @example vultSaturateSoft(0) // 0
 * @example Math.abs(vultSaturateSoft(16) - 16 * Math.tanh(1)) < 1e-12 // true
 */
export function vultSaturateSoft(x) {
  return VULT_SATURATE_SCALE * Math.tanh(x / VULT_SATURATE_SCALE);
}

/**
 * Pure function. `Fold.do` (`examples/effects/fold.vult`) — the author's own
 * wavefolder: scale by `8·level + 1`, then reflect the fractional part.
 *
 * @param {number} signal - normalized, ±1
 * @param {number} level - 0…1
 * @returns {number} in [-1, 1]
 *
 * @example vultFold(0.1, 0) // 0.1
 * @example Math.abs(vultFold(-0.1, 0) + 0.1) < 1e-15 // true
 * @example Math.abs(vultFold(0.5, 1)) <= 1 // true
 */
export function vultFold(signal, level) {
  const sign = signal > 0 ? 1 : -1;
  const amp = Math.abs(signal) * (8 * level + 1);
  const base = Math.floor(amp);
  const delta = amp - base;
  return sign * (Math.trunc(base) % 2 !== 0 ? 1 - delta : delta);
}

/**
 * Pure function. `Util.dcblock` — a one-pole DC blocker at their own 0.995.
 * Stateful in the original (`mem x1, y1`); here the state is the caller's, so
 * the arithmetic itself stays pure and testable.
 *
 * @param {number} x0 - this sample
 * @param {number} x1 - the previous input
 * @param {number} y1 - the previous output
 * @returns {number}
 *
 * @example vultDcBlock(1, 0, 0) // 1
 * @example vultDcBlock(0, 1, 1) // -0.005000000000000004
 */
export function vultDcBlock(x0, x1, y1) {
  return x0 - x1 + y1 * 0.995;
}

/**
 * Pure function. Vult's `@[table(size = N, min, max)]` annotation, which is part
 * of the LANGUAGE and not an optimisation the porter may skip (D7): the compiler
 * emits an N-point table and the DSP around it is tuned against that resolution.
 *
 * @param {function(number): number} fn
 * @param {number} size - POINTS, so the table has size − 1 intervals
 * @param {number} min
 * @param {number} max
 * @returns {function(number): number}
 *
 * @example vultTable((x) => x * x, 3, 0, 1)(0.5) // 0.25
 * @example vultTable((x) => x * x, 3, 0, 1)(0.25) // 0.125
 */
export function vultTable(fn, size, min, max) {
  return uniformTable(fn, size - 1, min, max);
}

/**
 * `filters/svf.vult`'s `process`, ported function for function — the zero-delay
 * state-variable filter every Vult multimode filter is built on.
 *
 *     g       = tan(π·f/fs)                         [`calc_g`, a 128-point table]
 *     R       = 1/(2(q + ε))
 *     invDen  = 1/(1 + 2Rg + g²)
 *     high    = (x − (2R + g)·z1 − z2) · invDen
 *     band    = g·high + z1
 *     low     = g·band + z2
 *     z1      = g·high + band
 *     z2      = g·band + low
 *
 * Their `process` also adds 0.5 to `q` before use and passes the output through
 * `Saturate_soft`; both are the CALLER's business here, because the modules that
 * use this core saturate in different places.
 *
 * Command (mutates z1/z2).
 */
export class VultSvf {
  /** @param {number} sampleRate */
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    this.z1 = 0;
    this.z2 = 0;
    this.g = 0;
    this.r = 1;
    this.invDen = 1;
    this.setCutoffHz(1000);
    this.setQ(0.5);
  }

  /** Command. `calc_g`'s result: `wa·T/2` reduces exactly to `tan(π·f/fs)`.
   *  Clamped just under a quarter of the sample rate, where `tan` blows up. */
  setCutoffHz(hz) {
    const nyquistGuard = 0.49;
    this.g = Math.tan(Math.PI * vc10Clamp(hz / this.sampleRate, 1e-7, nyquistGuard * 0.5));
    this.updateDenominator();
  }

  /** Command. `R = 1/(2(q + eps))`, with their own `q = q + 0.5` NOT applied —
   *  see the class docblock. */
  setQ(q) {
    this.r = 1 / (2 * (q + Number.EPSILON));
    this.updateDenominator();
  }

  /** Command. The shared denominator, cached exactly as their `Util.change`
   *  guard does. */
  updateDenominator() {
    this.invDen = 1 / (1 + 2 * this.r * this.g + this.g * this.g);
  }

  /**
   * Command. One sample. Returns the four nodes; `notch = low + high`.
   *
   * `stateShape` is the caller's nonlinearity on the two INTEGRATOR STATES —
   * `Unstabile`'s "circuit bent" character is exactly this argument being
   * `vultCubicClipper` where `Stabile`'s is the identity.
   *
   * ── IT SHAPES THE STATES, NOT THE FEEDBACK READ, AND THAT WAS MEASURED ─────
   * The obvious place to put a nonlinearity is on the `z1` the resonance term
   * reads. That DIVERGES: `invDen` is the closed-form solution of the loop
   * assuming the `2R·z1` term is linear, so clipping z1 on the way in removes
   * the damping the solution counted on while leaving `z2` free to integrate.
   * Measured on the first run of this kernel: 2.6e7 volts in 0.1 s. Shaping the
   * stored states instead BOUNDS both integrators, which is what a real
   * circuit's rails do, and is stable at every resonance the knob reaches.
   */
  run(x, stateShape) {
    const high = (x - (2 * this.r + this.g) * this.z1 - this.z2) * this.invDen;
    const band = this.g * high + this.z1;
    const low = this.g * band + this.z2;
    const z1 = this.g * high + band;
    const z2 = this.g * band + low;
    this.z1 = stateShape ? stateShape(z1) : z1;
    this.z2 = stateShape ? stateShape(z2) : z2;
    return { low, high, band, notch: low + high };
  }
}

/** `filters/ladder.vult`'s `process_heun`: four `heun` calls per sample. */
const VULT_LADDER_OVERSAMPLE = 4;

/** `tune`'s clip: the cutoff is limited to 20 kHz before it becomes `fh`. */
const VULT_LADDER_MAX_HZ = 20000;

/**
 * `filters/ladder.vult` — the author's own DIODE LADDER, with the HEUN
 * (predictor–corrector) integrator `process` selects. Ported function for
 * function; only the hard-coded 44.1 kHz becomes the host's rate.
 *
 *     fh   = 2π·f / (4·fs)                                       [`tune`]
 *     w0   = clip(in − 4·res·p3);  w1 = clip(p0);  …             [predictor]
 *     dpt0 = (w0 − w1)·fh;  pt_i = p_i + dpt_i
 *     dp_i = the same differences taken at pt                    [corrector]
 *     p_i ← p_i + (dp_i + dpt_i)/2
 *
 * where `clip` is `Util.cubic_clipper`. Heun is why this filter stays stable at
 * resonances a plain Euler ladder screams at, and their own `euler` variant is
 * present in the source but not selected by `process`.
 *
 * Command (mutates the four poles).
 */
export class VultDiodeLadder {
  /** @param {number} sampleRate */
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    this.p = new Float64Array(4);
    this.fh = 0;
    this.setCutoffHz(1000);
  }

  /** Command. `tune(cut)`, generalised off their hard-coded 44.1 kHz. */
  setCutoffHz(hz) {
    const f = vc10Clamp(hz, 0, VULT_LADDER_MAX_HZ);
    this.fh = (2 * Math.PI * f) / (VULT_LADDER_OVERSAMPLE * this.sampleRate);
  }

  /** Command. ONE `heun` step. `res` is their 0…1 resonance. */
  heun(input, res) {
    const p = this.p;
    const wt0 = vultCubicClipper(input - 4 * res * p[3]);
    const wt1 = vultCubicClipper(p[0]);
    const wt3 = vultCubicClipper(p[1]);
    const wt5 = vultCubicClipper(p[2]);
    const wt7 = vultCubicClipper(p[3]);
    const dpt0 = (wt0 - wt1) * this.fh;
    const dpt1 = (wt1 - wt3) * this.fh;
    const dpt2 = (wt3 - wt5) * this.fh;
    const dpt3 = (wt5 - wt7) * this.fh;

    const pt0 = p[0] + dpt0;
    const pt1 = p[1] + dpt1;
    const pt2 = p[2] + dpt2;
    const pt3 = p[3] + dpt3;

    const w0 = vultCubicClipper(input - 4 * res * pt3);
    const w1 = vultCubicClipper(pt0);
    const w3 = vultCubicClipper(pt1);
    const w5 = vultCubicClipper(pt2);
    const w7 = vultCubicClipper(pt3);
    const dp0 = (w0 - w1) * this.fh;
    const dp1 = (w1 - w3) * this.fh;
    const dp2 = (w3 - w5) * this.fh;
    const dp3 = (w5 - w7) * this.fh;

    p[0] += (dp0 + dpt0) / 2;
    p[1] += (dp1 + dpt1) / 2;
    p[2] += (dp2 + dpt2) / 2;
    p[3] += (dp3 + dpt3) / 2;
  }

  /** Command. `process_heun` — four steps, then the four poles ARE the four
   *  slopes: p0 is 6 dB/oct, p1 is 12, p2 is 18, p3 is 24. */
  process(input, res) {
    for (let i = 0; i < VULT_LADDER_OVERSAMPLE; i++) this.heun(input, res);
    return this.p;
  }
}

/**
 * Pure function. The PolyBLEP step correction — one sample of the residual
 * between a bandlimited step and a naive one, for a discontinuity `t` into the
 * cycle with increment `dt`.
 *
 * ── THIS IS NOT VULT'S ──────────────────────────────────────────────────────
 * Vult's own antialiased oscillators (`examples/osc/saw_eptr.vult`,
 * `minblep.vult`, `blit.vult`) use EPTR and minBLEP. Bleak's and Vessek's
 * manuals say "zero aliasing" and "virtual analog" without naming which, and the
 * modules are closed. PolyBLEP is the same class of correction — a polynomial
 * approximation to the same residual — and is named here rather than passed off
 * as theirs. Deviation D-BLEP, and it is the largest single divergence in the
 * Vult oscillators: the aliasing floor differs, not the pitch or the shape.
 *
 * @param {number} t - phase, 0…1
 * @param {number} dt - phase increment per sample
 * @returns {number} the correction to ADD to a naive step
 *
 * @example polyBlep(0.5, 0.01) // 0
 * @example polyBlep(0, 0.01) // -1
 * @example Math.abs(polyBlep(0.999, 0.01)) > 0 // true
 */
export function polyBlep(t, dt) {
  if (t < dt) {
    const x = t / dt;
    return x + x - x * x - 1;
  }
  if (t > 1 - dt) {
    const x = (t - 1) / dt;
    return x * x + x + x + 1;
  }
  return 0;
}

/**
 * The oscillator core Bleak and Vessek's two voices share: one phase
 * accumulator producing a PolyBLEP saw, a PolyBLEP pulse and a variable-slope
 * triangle, crossfaded by one `wave` control.
 *
 * ── TIER: BEHAVIOUR ASSEMBLY over a non-Vult antialiaser ────────────────────
 * The morph order is the manuals' own — Bleak: "Saw: full left, Pulse: center,
 * Triangle: full right" — and so is PW's meaning per shape ("in the case of saw
 * and triangle an equivalent effect of the wave is provided"; Vessek: "in the
 * case of the Saw it produces a double Saw sound", "in the case of the triangle
 * changes the asymmetry of the wave"). Everything else is a model.
 *
 * Command (mutates the phase).
 */
export class VultVaOscillator {
  /** @param {number} sampleRate */
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    this.phase = 0;
    this.increment = 0;
  }

  /** Command. Set the running frequency in hertz. */
  setFrequencyHz(hz) {
    this.increment = vc10Clamp(hz / this.sampleRate, 0, 0.45);
  }

  /** Command. Restart the cycle — Vessek's Sync at full depth. */
  reset() {
    this.phase = 0;
  }

  /**
   * Command. One sample, normalized to ±1.
   *
   * @param {number} pw - 0…1 pulse width; 0.5 is symmetric
   * @param {number} wave - 0 saw, 0.5 pulse, 1 triangle
   */
  step(pw, wave) {
    this.phase = wrapPhase01(this.phase + this.increment);
    const dt = this.increment;
    const t = this.phase;
    const width = vc10Clamp(pw, 0.02, 0.98);

    // SAW, with the manual's "double saw" at PW ≠ 0.5: two ramps a fraction of a
    // cycle apart, which is what makes a single oscillator sound like two.
    //
    // THE OFFSET IS `pw − 0.5`, NOT `pw`, AND THAT WAS MEASURED. All three of
    // this core's shapes must be NEUTRAL at the centre of the PW knob — a square
    // pulse, a symmetric triangle, and a PLAIN saw — because one knob serves all
    // three and 0.5 is where the panel parks it. Offsetting by `pw` instead puts
    // the two ramps exactly antiphase at the default, which CANCELS THE
    // FUNDAMENTAL: measured at −39.6 dB with the alias floor above it, i.e. an
    // octave-up saw with no bass. `pw − 0.5` makes the second copy vanish at the
    // centre and open out to half a cycle at either extreme, which is the
    // manual's "more fat" without a hole where the note should be.
    const ramp = (p) => 2 * p - 1 - polyBlep(p, dt);
    const doubleOffset = width - 0.5;
    const saw = doubleOffset === 0
      ? ramp(t)
      : 0.5 * (ramp(t) + ramp(wrapPhase01(t + doubleOffset)));

    // PULSE: a naive square with a BLEP at each of its two edges.
    const pulse = (t < width ? 1 : -1) + polyBlep(t, dt) - polyBlep(wrapPhase01(t - width), dt);

    // TRIANGLE: rises across [0, pw), falls across [pw, 1). PW is the asymmetry,
    // so at the extremes it degenerates towards a ramp — which is the point.
    const triangle = t < width
      ? (2 * t) / width - 1
      : 1 - (2 * (t - width)) / (1 - width);

    return wave < 0.5
      ? saw + (pulse - saw) * (wave * 2)
      : pulse + (triangle - pulse) * ((wave - 0.5) * 2);
  }
}

/**
 * Pure function. Vult's own CV knob position to hertz — the composition of
 * `Util.cvToPitch` and their frequency law, which is how EVERY Vult cutoff and
 * pitch knob reads. Exported because the demo patches store Rack's raw 0…1 knob
 * positions and this is the function that turns one into the hertz our specs
 * carry.
 *
 * @param {number} cv - a Vult 0…1 knob position
 * @returns {number} hertz
 *
 * @example Math.abs(vultCvToHz(0) - 32.7031956) < 1e-6 // true
 * @example Math.abs(vultCvToHz(0.1) - 65.4063913) < 1e-6 // true
 * // The third example is Unstabile's harvested cutoff position. It shipped here
 * // as `2415`, which was ESTIMATED by hand and is 4 Hz wrong; the exact value is
 * // the one above, computed from the same law the other two examples check.
 * @example Math.abs(vultCvToHz(0.6209) - 2419.2761042067687) < 1e-9 // true
 */
export function vultCvToHz(cv) {
  return vultPitchToHz(vultCvToPitch(cv));
}

/** The hertz span a Vult 0…1 control covers — the range every cutoff and pitch
 *  knob in this block declares, so a spec's bounds are the module's bounds. */
export const VULT_CV_MIN_HZ = vultCvToHz(0);
export const VULT_CV_MAX_HZ = VULT_LADDER_MAX_HZ;

/**
 * Pure function. The hertz a Vult filter runs at, given a hertz knob, a
 * SEMITONE CV inlet and that inlet's attenuverter. R7-UNITS clause 3: the inlet
 * is 1 V/oct, so it composes in the PITCH domain and not the hertz one.
 *
 * @param {number} knobHz
 * @param {number} semitones - the CV inlet
 * @param {number} atten - the panel attenuverter, −1…1
 * @returns {number} hertz
 *
 * @example vultCutoffHz(1000, 0, 1) // 1000
 * @example Math.abs(vultCutoffHz(1000, 12, 1) - 2000) < 1e-9 // true
 * @example Math.abs(vultCutoffHz(1000, 12, 0.5) - 1000 * Math.pow(2, 0.5)) < 1e-9 // true
 */
export function vultCutoffHz(knobHz, semitones, atten) {
  return knobHz * Math.pow(2, (semitones * atten) / SEMITONES_PER_OCTAVE);
}

/** `svf.vult`'s `process` opens with `q = q + 0.5`, so its floor is 0.5. */
const VULT_MIN_Q = 0.5;

/**
 * The Q the resonance knob reaches at the top. `svf.vult`'s own example passes
 * a 0…1 `q`, which tops out at 1.5, and every Vult filter manual describes a
 * knob that goes much further than that.
 *
 * ── D-NOSELFOSC: THESE TWO FILTERS DO NOT SELF-OSCILLATE, AND THEIRS DO ─────
 * Measured, not assumed. Tangents' and Unstabile's manuals both say "after some
 * point the filter will start self-oscillating and can be used as a sound
 * generator". `VultSvf` is a ZERO-DELAY-FEEDBACK structure and is
 * unconditionally stable for any R > 0 — no Q makes its loop gain exceed one —
 * so it RINGS, hard and for a long time, but it never sustains. Driven at the
 * top of the knob with a 10 mV excitation it settles to 0.18 V and decays.
 * Raising Q further does not change that; it is structural.
 *
 * Reaching real self-oscillation needs either a negative-R term or a second
 * feedback path around the core, and inventing one would be inventing the
 * module's whole resonance character rather than modelling it. So: 30 is where
 * the ring is longest before the state clipper takes over, the knob is
 * exponential so its bottom is still gentle, and the shortfall is written here
 * and in both specs' `help` rather than papered over.
 */
const VULT_MAX_Q = 30;

/**
 * Pure function. A Vult 0…1 resonance knob to the SVF's `q`, exponentially, so
 * the bottom of the knob is a gentle lift and the top self-oscillates.
 *
 * @param {number} resonance - 0…1
 * @returns {number} the `q` `VultSvf.setQ` wants
 *
 * @example vultResonanceQ(0) // 0.5
 * @example vultResonanceQ(1) // 30
 * @example Math.abs(vultResonanceQ(0.5) - Math.sqrt(0.5 * 30)) < 1e-12 // true
 */
export function vultResonanceQ(resonance) {
  return VULT_MIN_Q * Math.pow(VULT_MAX_Q / VULT_MIN_Q, vc10Clamp(resonance, 0, 1));
}

// ═══════════════════════════════════════════════════════════════════════════
// 8. TANGENTS — Vult's Steiner-Parker. TIER: DSP-SOURCE + BEHAVIOUR ASSEMBLY.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * TANGENTS — three inputs into one filter core, one mixed output.
 *
 * ── DERIVATION RECORD ───────────────────────────────────────────────────────
 * CORE (transcribed): vult-dsp/vult @ cc56038, `examples/filters/svf.vult`
 *   `process` and `calc_g`, plus `examples/effects/saturate_soft.vult` and
 *   `Util.cubic_clipper` from `examples/util/util.vult`. See `VultSvf`.
 * ASSEMBLY (behaviour-derived): modlfo/VultModules @ 99629d3, `tangents/index.html`
 *   — "a filter based on the Steiner-Parker structure … this module leaves
 *   exposed three inputs (LP, BP and HP). This makes possible to connect three
 *   sources and affecting the frequency content for each input differently…
 *   Output: this will output the three input signals mixed together."
 *
 * ── WHY THREE CORES AND NOT ONE ─────────────────────────────────────────────
 * A hardware Steiner-Parker IS one core with three injection points, and which
 * response you hear depends on which jack you drive. One digital SVF cannot
 * produce three different responses of three different inputs at once, so this
 * runs THREE cores on shared coefficients and sums their respective nodes. With
 * one input patched — which is how the demo patches use it — the two are
 * identical. With three, the real module's inputs interact through the shared
 * resonance path and these do not. Deviation D-SP3, and it is the honest
 * boundary of this port.
 *
 * ── THE MODEL ───────────────────────────────────────────────────────────────
 *     drive·in → core_k → node_k          k ∈ {low, band, high}
 *     out       = saturate_soft(Σ node_k)
 * Resonance is the manual's own control and reaches self-oscillation, which the
 * cubic clipper in the feedback path is what bounds.
 *
 * ── DEVIATIONS ──────────────────────────────────────────────────────────────
 * D0, D1 (Vult origin C1), D3, D6, D8, D-SP3.
 * D-MODEL — the paid version's YU / MS / XX models are three different
 *   simulations; only the free module is ported and no model switch exists.
 */
export class TangentsKernel {
  /** @param {number} sampleRate */
  constructor(sampleRate) {
    this.lp = new VultSvf(sampleRate);
    this.bp = new VultSvf(sampleRate);
    this.hp = new VultSvf(sampleRate);
    this.drive = 1;
  }

  /** Command. Runs every sample in their code, so `controlDivisor` is 1 and the
   *  `Util.change` guard is what keeps it cheap; here the recompute is cheap
   *  enough to be unconditional. */
  control(knobs, signals) {
    const hz = vultCutoffHz(knobs.cutoff, signals.cutoff, knobs.cutoffAtten);
    // `svf.vult`'s `process` adds 0.5 to q before use; see `vultResonanceQ`
    // for why the top of the knob goes further than their example's does.
    const q = vultResonanceQ(knobs.resonance);
    for (const core of [this.lp, this.bp, this.hp]) {
      core.setCutoffHz(hz);
      core.setQ(q);
    }
    this.drive = 1 + knobs.drive * TANGENTS_MAX_DRIVE;
  }

  /** Command. One sample; frame is [out] in volts. The cores run in ±1 — the
   *  domain `cubic_clipper` and every Vult example are written for — so the
   *  Rack ±5 V scaling happens at this boundary and nowhere inside. */
  sample(knobs, signals, wired, frame) {
    const gain = this.drive / RACK_VOLTS_PER_UNIT;
    const low = this.lp.run(signals.lp_in * gain, vultCubicClipper).low;
    const band = this.bp.run(signals.bp_in * gain, vultCubicClipper).band;
    const high = this.hp.run(signals.hp_in * gain, vultCubicClipper).high;
    frame[0] = vultSaturateSoft((low + band + high) * RACK_VOLTS_PER_UNIT);
  }
}

/** How much gain the Drive knob's top adds before the filter — chosen so the
 *  cubic clipper is reached by a nominal ±5 V signal at about three quarters
 *  of the knob, which is where the manual says the harmonics start. */
const TANGENTS_MAX_DRIVE = 9;

// ═══════════════════════════════════════════════════════════════════════════
// 9. UNSTABILE — Vult's circuit-bent SVF. TIER: DSP-SOURCE + BEHAVIOUR.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * UNSTABILE — LP, BP, HP and a SEM-style blend, with a deliberately nonlinear
 * resonance path.
 *
 * ── DERIVATION RECORD ───────────────────────────────────────────────────────
 * CORE (transcribed): `examples/filters/svf.vult` `process`, `calc_g`;
 *   `Util.cubic_clipper`; `Saturate_soft.process`. See `VultSvf`.
 * ASSEMBLY (behaviour-derived): `unstabile/index.html` — "'circuit bent' version
 *   of Stabile … I remade the model and introduced nonlinearities that can occur
 *   when the circuit is fed with low voltage … it can self-oscillate";
 *   "Semblance … affects only the output called SEM … blends the low pass and
 *   high pass outputs. In the center it produces a notch at the cutoff."
 *
 * ── THE MODEL ───────────────────────────────────────────────────────────────
 *     in'  = saturate_soft(in · (1 + drive·D))
 *     the SVF's resonance path runs through `cubic_clipper` — THAT is the
 *     "circuit bent" nonlinearity, and it is why this filter's self-oscillation
 *     has a shape instead of a divergence
 *     SEM  = 2·((1 − s)·low + s·high)
 * The factor of two is forced, not chosen: at s = 0.5 the expression is
 * `low + high`, which IS the notch response the manual promises, and without the
 * two it would be a notch 6 dB down from the LP and HP the same knob reaches.
 *
 * ── DEVIATIONS ──────────────────────────────────────────────────────────────
 * D0, D1, D3, D6, D8, D-DRIVE (the drive law's span is chosen, not measured).
 */
export class UnstabileKernel {
  /** @param {number} sampleRate */
  constructor(sampleRate) {
    this.svf = new VultSvf(sampleRate);
    this.drive = 1;
  }

  /** Command. Every sample in their code (`controlDivisor` 1). */
  control(knobs, signals) {
    this.svf.setCutoffHz(vultCutoffHz(knobs.cutoff, signals.cutoff, knobs.cutoffAtten));
    this.svf.setQ(vultResonanceQ(knobs.resonance));
    this.drive = 1 + knobs.drive * UNSTABILE_MAX_DRIVE;
  }

  /** Command. One sample; frame is [lp, bp, hp, sem] in volts. Like Tangents,
   *  the core runs in ±1 and the ±5 V scaling is only at this boundary. */
  sample(knobs, signals, wired, frame) {
    const driven = vultSaturateSoft(signals.in * this.drive) / RACK_VOLTS_PER_UNIT;
    const nodes = this.svf.run(driven, vultCubicClipper);
    frame[0] = nodes.low * RACK_VOLTS_PER_UNIT;
    frame[1] = nodes.band * RACK_VOLTS_PER_UNIT;
    frame[2] = nodes.high * RACK_VOLTS_PER_UNIT;
    frame[3] = 2 * ((1 - knobs.semblance) * frame[0] + knobs.semblance * frame[2]);
  }
}

/** Unstabile's drive span. Larger than Tangents' because the manual calls this
 *  one the distorted sibling ("makes everything sound big and distorted"). */
const UNSTABILE_MAX_DRIVE = 19;

// ═══════════════════════════════════════════════════════════════════════════
// 10. LATERALUS — Vult's diode ladder. TIER: DSP-SOURCE + BEHAVIOUR ASSEMBLY.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * LATERALUS — the author's own diode ladder with all four slopes on jacks.
 *
 * ── DERIVATION RECORD ───────────────────────────────────────────────────────
 * CORE (transcribed): `examples/filters/ladder.vult` `tune`, `heun`,
 *   `process_heun`, `process`; `Util.cubic_clipper`. See `VultDiodeLadder`.
 *   THE MANUAL NAMES THIS FILE: "Lateralus is a detailed simulation model based
 *   on my own diode ladder filter" (`lateralus/index.html`), and `ladder.vult`
 *   is titled "Diode ladder filter" by the same author. That is as close as a
 *   closed module gets to a published core.
 * ASSEMBLY (behaviour-derived): the same manual's output list — "24 dB: the
 *   classical sound … 18 dB: used by a famous acid box … 12 dB … 6 dB" — and its
 *   Cutoff / Resonance / Drive controls.
 *
 * ── THE MODEL ───────────────────────────────────────────────────────────────
 *     in'   = saturate_soft(in · (1 + drive·D))
 *     p0…p3 = heun ladder, four sub-steps per sample
 *     out_6db = p0,  out_12db = p1,  out_18db = p2,  out_24db = p3
 * The four poles ARE the four slopes — that is a property of a ladder, not an
 * approximation, and it is why this module can offer them at no extra cost.
 *
 * ── PORT NAMES CORRECTED ────────────────────────────────────────────────────
 * The stub carried `ports PROVISIONAL — indices from the cable list`, with
 * `fc_cv` in and `out1`/`out2` out. The manual gives the real ones: the CV inlet
 * is the Cutoff attenuverter's, so it is `cutoff` (matching Unstabile's, which
 * the harvest got right), and the outputs are FOUR slopes in the manual's own
 * order, so index 0 is `out_24db` and index 1 is `out_18db`.
 *
 * ── DEVIATIONS ──────────────────────────────────────────────────────────────
 * D0, D1, D3, D6, D8, D-DRIVE.
 * D-MODEL — the paid version's DF and TH models; only one is ported.
 */
export class LateralusKernel {
  /** @param {number} sampleRate */
  constructor(sampleRate) {
    this.ladder = new VultDiodeLadder(sampleRate);
    this.drive = 1;
  }

  /** Command. Every sample in their code (`controlDivisor` 1). */
  control(knobs, signals) {
    this.ladder.setCutoffHz(vultCutoffHz(knobs.cutoff, signals.cutoff, knobs.cutoffAtten));
    this.drive = 1 + knobs.drive * LATERALUS_MAX_DRIVE;
  }

  /** Command. One sample; frame is [24 dB, 18 dB, 12 dB, 6 dB] in volts. */
  sample(knobs, signals, wired, frame) {
    // The ladder works around ±1; Rack's ±5 V goes in scaled and comes back out.
    const input = vultSaturateSoft(signals.in * this.drive) / RACK_VOLTS_PER_UNIT;
    const p = this.ladder.process(input, knobs.resonance);
    frame[0] = p[3] * RACK_VOLTS_PER_UNIT;
    frame[1] = p[2] * RACK_VOLTS_PER_UNIT;
    frame[2] = p[1] * RACK_VOLTS_PER_UNIT;
    frame[3] = p[0] * RACK_VOLTS_PER_UNIT;
  }
}

/** Lateralus' drive span. */
const LATERALUS_MAX_DRIVE = 9;

// ═══════════════════════════════════════════════════════════════════════════
// 11. BLEAK — Vult's VA oscillator. TIER: DSP-SOURCE + BEHAVIOUR ASSEMBLY.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * BLEAK — one antialiased oscillator morphing saw → pulse → triangle, with PW.
 *
 * ── DERIVATION RECORD ───────────────────────────────────────────────────────
 * CORE (assembled, see `VultVaOscillator`): the morph order, the PW semantics
 *   and the tuning are the manual's; the ANTIALIASER is PolyBLEP and is NOT
 *   Vult's (D-BLEP).
 * BEHAVIOUR: `bleak/index.html` — "a virtual analog oscillator with zero
 *   aliassing … three waveforms that can be morphed and PW modulated";
 *   "Tune: offsets the V/OCT input one octave up or down"; "Oct: offsets the
 *   V/OCT input three octaves up and down"; "Wave: Saw full left, Pulse center,
 *   Triangle full right"; "Zero volts corresponds to a C3 note".
 *
 * ── THE TUNING IS MEASURED, NOT GUESSED ─────────────────────────────────────
 * `Util.cvToPitch` puts a Vult 0 V at MIDI 24 (C1) and Vessek's manual agrees;
 * Bleak's says C3 for the same DSP, so Bleak carries a +24 semitone panel
 * offset. That is modelled as exactly that — one constant, in one place — rather
 * than as a second tuning law, because a second law is a second thing to get
 * wrong. See D1.
 *
 * ── DEVIATIONS ──────────────────────────────────────────────────────────────
 * D0, D1, D3, D8, D-BLEP.
 * D-VULTMOD — the paid version's modulation-assignment section is not ported;
 *   in this block every modulatable control simply has its own inlet.
 */
export class BleakKernel {
  /** @param {number} sampleRate */
  constructor(sampleRate) {
    this.osc = new VultVaOscillator(sampleRate);
  }

  /** Command. Every sample (`controlDivisor` 1). */
  control(knobs, signals) {
    const semitones = signals.v_oct + VULT_C3_PANEL_OFFSET_SEMITONES
      + knobs.tune + knobs.oct * SEMITONES_PER_OCTAVE;
    this.osc.setFrequencyHz(vultSemitonesToHz(semitones));
  }

  /** Command. One sample; frame is [out] in volts. */
  sample(knobs, signals, wired, frame) {
    const pw = vc10Clamp(knobs.pw + signals.pw / RACK_VOLTS_PER_UNIT, 0, 1);
    const wave = vc10Clamp(knobs.wave + signals.wave / RACK_VOLTS_PER_UNIT, 0, 1);
    frame[0] = this.osc.step(pw, wave) * RACK_VOLTS_PER_UNIT;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 12. BASAL — Vult's phase-distortion oscillator. TIER: BEHAVIOUR ASSEMBLY.
// ═══════════════════════════════════════════════════════════════════════════

/** How many extra cycles Mod 2 can pack into one window at full travel. The
 *  manual says only "increases the number of harmonics"; seven is the count at
 *  which the resonant peak reaches the seventh harmonic, which is where a
 *  Casio-style phase-distortion oscillator's formant is usually parked. */
const BASAL_MAX_EXTRA_CYCLES = 7;

/** Mod 1's phase-distortion depth at full travel, in cycles. Half a cycle is
 *  the point at which the warped phase stops being monotonic, which is where
 *  the manual's "distorting the phase" stops being a timbre and starts being a
 *  second oscillator. */
const BASAL_MAX_PHASE_DISTORTION = 0.5;

/**
 * BASAL — "specifically designed for creating smooth sounds with low harmonic
 * content", with two modulation controls that add harmonics.
 *
 * ── DERIVATION RECORD (TIER: BEHAVIOUR ASSEMBLY) ────────────────────────────
 * modlfo/VultModules @ 99629d3, `basal/index.html`:
 *   "Basal features a self modulation technique that acts when the oscillator is
 *   moved"; "Mod 1: creates overtones by distorting the phase of the main
 *   oscillator (−10 V to +10 V). The CV input is attenuverted according to the
 *   smaller encoder and then added to Mod 1"; "Mod 2: increases the number of
 *   harmonics (−10 V to +10 V)"; "Zero volts corresponds to a C3 note".
 * The tuning is `Util.cvToPitch` with Bleak's +24 offset (D1). NOTHING ELSE
 * BELOW IS THE AUTHOR'S — the two modulation LAWS are a model that matches the
 * manual's description of what each knob does, and the spec's own `help` says so.
 *
 * ── THE MODEL ───────────────────────────────────────────────────────────────
 *     φ'   = frac(φ + m1·0.5·sin(2πφ))                [Mod 1: phase distortion]
 *     pure = sin(2πφ')
 *     res  = sin(2πφ'·(1 + 7·m2)) · (1 − φ')          [Mod 2: windowed resonance]
 *     out  = pure + (res − pure)·m2
 * so Mod 2 at zero is EXACTLY the pure (possibly phase-distorted) sine the
 * manual's "low harmonic content" promises, and the crossfade is what stops the
 * window from colouring the sound when the knob is down.
 *
 * ── DEVIATIONS ──────────────────────────────────────────────────────────────
 * D0, D1, D3, D8. The whole timbre is D-MODEL: behaviour-derived.
 */
export class BasalKernel {
  /** @param {number} sampleRate */
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    this.phase = 0;
    this.increment = 0;
  }

  /** Command. Every sample (`controlDivisor` 1). */
  control(knobs, signals) {
    const semitones = signals.v_oct + VULT_C3_PANEL_OFFSET_SEMITONES
      + knobs.tune + knobs.oct * SEMITONES_PER_OCTAVE;
    this.increment = vc10Clamp(vultSemitonesToHz(semitones) / this.sampleRate, 0, 0.45);
  }

  /** Command. One sample; frame is [out] in volts. */
  sample(knobs, signals, wired, frame) {
    // The manual's CV inlets are ±10 V for a full sweep of each knob.
    const m1 = vc10Clamp(knobs.mod1 + signals.mod1 / VC10_GATE_VOLTS, -1, 1);
    const m2 = vc10Clamp(knobs.mod2 + signals.mod2 / VC10_GATE_VOLTS, 0, 1);
    this.phase = wrapPhase01(this.phase + this.increment);
    const warped = wrapPhase01(this.phase + m1 * BASAL_MAX_PHASE_DISTORTION * Math.sin(2 * Math.PI * this.phase));
    const pure = Math.sin(2 * Math.PI * warped);
    const resonant = Math.sin(2 * Math.PI * warped * (1 + BASAL_MAX_EXTRA_CYCLES * m2)) * (1 - warped);
    frame[0] = (pure + (resonant - pure) * m2) * RACK_VOLTS_PER_UNIT;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 13. VESSEK — Vult's two-oscillator analogue voice. TIER: BEHAVIOUR ASSEMBLY.
// ═══════════════════════════════════════════════════════════════════════════

/** Vessek's Tune switch — "Fine: one semitone up and down; Coarse: one octave;
 *  Semi: one octave, quantized to every semitone". */
export const VESSEK_TUNE_MODES = Object.freeze(["fine", "coarse", "semi"]);

/** Its Glide switch — "Skip Gate: glide is not applied if V/OCT changes at the
 *  same time as a Gate signal; Always". */
export const VESSEK_GLIDE_MODES = Object.freeze(["skipGate", "always"]);

/** The longest glide the knob reaches, in seconds. The manual says only
 *  "controls the maximum rate of change of the V/OCT signal"; one second is the
 *  span at which a portamento is still musical at the top of the knob. */
const VESSEK_MAX_GLIDE_SECONDS = 1;

/** The longest Fade decay, in seconds — same reasoning: the manual gives a
 *  behaviour ("controls the decay time of an envelope triggered by the Gate")
 *  and no number, and four seconds covers a pad's tail. */
const VESSEK_MAX_FADE_SECONDS = 4;

/** Full FM depth, as a fraction of oscillator B's own frequency. */
const VESSEK_MAX_FM_DEPTH = 2;

/** How hard the Shaper drives before `saturate_soft`. */
const VESSEK_MAX_SHAPE_DRIVE = 15;

/** How many volts of DC the Offset control can add ahead of the Shaper. */
const VESSEK_MAX_OFFSET_VOLTS = 5;

/**
 * VESSEK — two analogue-modelled oscillators, cross-modulated, shaped, faded.
 *
 * ── DERIVATION RECORD (TIER: BEHAVIOUR ASSEMBLY) ────────────────────────────
 * modlfo/VultModules @ 99629d3, `vessek/index.html`, which is unusually detailed
 * and is the whole specification for the routing below:
 *   "Vessek consists of two oscillators (A and B) with similar parameters.
 *   Oscillator A can modulate oscillator B using FM and AM."
 *   "PW: sets the pulse width … in the case of the Saw it produces a double Saw
 *   sound which is more fat"; "Wave: selects the wave — Pulse / Saw / Triang".
 *   "Mix: controls the level of the two oscillators."
 *   "Sync: produces a gradual modulation of oscillator B based on the reset
 *   signal of A. In a low value, it interferes the phase of oscillator B. As the
 *   value goes up, oscillator B starts resetting at the same time as oscillator
 *   A. In the maximum setting we have a hard-sync sound."
 *   "Shaper: adds a final distortion to the mixed wave."
 *   "Offset: adds a offset voltage to the wave before going into the Shaper in
 *   order to produce an asymmetric distortion."
 *   "Fade: controls the decay time of an envelope triggered by the Gate input.
 *   If nothing is connected to the Ext input, the voltage of the envelope is
 *   output through the Out jack (in Fade section)."
 *   "Glide: controls the maximum rate of change of the V/OCT signal."
 *   "V/OCT … Zero volts corresponds to a C1 note."
 * The oscillator CORE is `VultVaOscillator` (see its own record); the SATURATOR
 * is the author's `Saturate_soft`. The routing, every depth law and every range
 * constant above are a MODEL of the sentences quoted here.
 *
 * ── THE MODEL ───────────────────────────────────────────────────────────────
 *     pitch  = glide(voct) + tune + 12·oct                    [C1 origin]
 *     A      = osc(pitchA, pwA, waveA)
 *     B      = osc(pitchB · 2^(fm·A·2/12·…), pwB, waveB), reset on A's wrap
 *              with probability-free CROSSFADE by `sync`
 *     B     *= 1 + am·(A − 1)/2                                [AM]
 *     mix    = (1 − m)·A + m·B
 *     out    = saturate_soft((mix + offset)·(1 + 15·shaper))
 *     fade   = one-pole decay from a Gate, × the Ext input when one is patched
 *
 * ── DEVIATIONS ──────────────────────────────────────────────────────────────
 * D0, D1 (C1), D2 (the gate inlet), D3, D8.
 * D-VULTMOD — the modulation-assignment matrix ("press one of the buttons and
 *   move the parameter you want to change") is a UI affordance for routing one
 *   internal source to any knob. Not ported; every control that the manual says
 *   is modulatable has its own inlet instead, which is this project's own way of
 *   saying the same thing.
 * D-MASTERTUNE — the non-randomisable Master Tune is a calibration control and
 *   folds into `tune`.
 * D-MODEL — the timbre. Everything above the core is behaviour-derived.
 */
export class VessekKernel {
  /** @param {number} sampleRate */
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    this.sampleTime = 1 / sampleRate;
    this.oscA = new VultVaOscillator(sampleRate);
    this.oscB = new VultVaOscillator(sampleRate);
    this.glided = 0;
    this.fadeEnv = 0;
    this.lastPhaseA = 0;
    this.lastGate = false;
    this.tuneMode = "coarse";
    this.glideMode = "skipGate";
  }

  /** Command. The Tune switch. */
  setTuneMode(value) {
    this.tuneMode = vc10Option("VessekKernel", "tuneMode", value, VESSEK_TUNE_MODES);
  }

  /** Command. The Glide switch. */
  setGlideMode(value) {
    this.glideMode = vc10Option("VessekKernel", "glideMode", value, VESSEK_GLIDE_MODES);
  }

  /** Query. The Tune knob in semitones, per the switch: fine is ±1 semitone,
   *  coarse ±12, semi ±12 quantized. */
  tuneSemitones(tune) {
    if (this.tuneMode === "fine") return tune;
    const octave = tune * SEMITONES_PER_OCTAVE;
    return this.tuneMode === "semi" ? Math.round(octave) : octave;
  }

  /** Command. Every sample (`controlDivisor` 1). */
  control(knobs, signals) {
    const gate = signals.gate > 0.5;
    // GLIDE: a one-pole toward the target pitch. "Skip Gate" jumps when the gate
    // edge and the pitch change coincide, which is what makes a legato line
    // glide and a re-triggered one not.
    const target = signals.v_oct;
    const skip = this.glideMode === "skipGate" && gate && !this.lastGate;
    if (skip || knobs.glide <= 0) {
      this.glided = target;
    } else {
      const tau = knobs.glide * VESSEK_MAX_GLIDE_SECONDS;
      this.glided += (target - this.glided) * Math.min(1, this.sampleTime / tau);
    }
    this.lastGate = gate;

    const base = this.glided + this.tuneSemitones(knobs.tune) + knobs.oct * SEMITONES_PER_OCTAVE;
    this.freqA = vultSemitonesToHz(base);
    this.freqB = vultSemitonesToHz(base + knobs.detuneB);
  }

  /** Command. One sample; frame is [out, fade] in volts.
   *
   *  D-VULTMOD in practice: the four CV inlets are the modulation-assignment
   *  matrix's four most-used destinations, each given its own jack. They ADD to
   *  their knob, in the knob's own 0…1 domain, which is why a ±5 V modulator is
   *  a full sweep. */
  sample(knobs, signals, wired, frame) {
    const pwCv = signals.pw_cv / RACK_VOLTS_PER_UNIT;
    const waveCv = signals.wave_cv / RACK_VOLTS_PER_UNIT;
    const pwA = vc10Clamp(knobs.pwA + pwCv, 0, 1);
    const pwB = vc10Clamp(knobs.pwB + pwCv, 0, 1);
    const waveA = vc10Clamp(knobs.waveA + waveCv, 0, 1);
    const waveB = vc10Clamp(knobs.waveB + waveCv, 0, 1);
    const mixAmount = vc10Clamp(knobs.mix + signals.mix_cv / RACK_VOLTS_PER_UNIT, 0, 1);

    this.oscA.setFrequencyHz(this.freqA);
    const a = this.oscA.step(pwA, waveA);

    // FM: oscillator A modulates B's frequency, exponentially, so a musical
    // interval of modulation is the same interval wherever B is parked.
    const fmDepth = vc10Clamp(knobs.fm + signals.fm_cv / RACK_VOLTS_PER_UNIT, 0, 1) * VESSEK_MAX_FM_DEPTH;
    this.oscB.setFrequencyHz(this.freqB * Math.pow(2, a * fmDepth));

    // SYNC: A's wrap resets B, crossfaded from "nudge the phase" to "hard reset"
    // exactly as the manual describes the knob's travel.
    const wrapped = this.oscA.phase < this.lastPhaseA;
    this.lastPhaseA = this.oscA.phase;
    if (wrapped && knobs.sync > 0) {
      this.oscB.phase = this.oscB.phase * (1 - knobs.sync);
    }
    let b = this.oscB.step(pwB, waveB);

    // AM: A rides B's amplitude; at full depth B is gated by A's positive half.
    b *= 1 + knobs.am * ((a - 1) / 2);

    const mix = (1 - mixAmount) * a + mixAmount * b;
    const shaped = vultSaturateSoft(
      (mix * RACK_VOLTS_PER_UNIT + knobs.offset * VESSEK_MAX_OFFSET_VOLTS)
      * (1 + knobs.shaper * VESSEK_MAX_SHAPE_DRIVE),
    );

    // FADE: a gate-triggered exponential decay, and a VCA on `ext` when patched.
    if (signals.gate > 0.5) {
      this.fadeEnv = 1;
    } else {
      const tau = Math.max(knobs.fade * VESSEK_MAX_FADE_SECONDS, this.sampleTime);
      this.fadeEnv *= Math.exp(-this.sampleTime / tau);
    }
    frame[0] = shaped;
    frame[1] = wired.ext ? signals.ext * this.fadeEnv : this.fadeEnv * RACK_VOLTS_PER_UNIT;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 14. CAUDAL — Vult's pendulum chaos source. TIER: BEHAVIOUR ASSEMBLY.
// ═══════════════════════════════════════════════════════════════════════════

/** "For every segment of the pendula there are the following 3 outputs" and the
 *  panel has four segments. */
const CAUDAL_SEGMENTS = 4;

/** The integration step at Speed = 0 and at Speed = 1, in radians of phase per
 *  second of host time. Chosen so the slow end drifts over tens of seconds (a
 *  modulation source) and the fast end is a few hertz (an audible flutter),
 *  which is the range the manual's video shows. */
const CAUDAL_MIN_RATE = 0.15;
const CAUDAL_MAX_RATE = 12;

/** Gravity at Energy = 0 and at Energy = 1. "Energy: changes some of the
 *  properties of the model, for example the gravity and mass." */
const CAUDAL_MIN_GRAVITY = 1;
const CAUDAL_MAX_GRAVITY = 9;

/** The coupling stiffness between neighbouring segments, and the damping that
 *  keeps the chain from accumulating energy forever. Damping is small enough
 *  that the system keeps moving for minutes after one Hit, which is what the
 *  manual means by "when triggered many times it can make the pendula rotate
 *  continuously". */
const CAUDAL_COUPLING = 6;
const CAUDAL_DAMPING = 0.02;

/** Outputs are "normalized from −5 V to 5 V". */
const CAUDAL_OUTPUT_VOLTS = 5;

/** Caudal's own seed, so a Hit is reproducible (D5, and the determinism law). */
const CAUDAL_DEFAULT_SEED = 1;

/**
 * CAUDAL — a chaotic modulation source shaped like a hanging chain.
 *
 * ── DERIVATION RECORD (TIER: BEHAVIOUR ASSEMBLY) ────────────────────────────
 * modlfo/VultModules @ 99629d3, `caudal/index.html`:
 *   "Caudal is a chaotic source that is based on the model of a multi segment
 *   pendulum. The core of Caudal is a detailed simulation of the pendulum system
 *   from which we can get measurements like the angular velocities and positions
 *   of the segments. … I made the original model using SystemModeler and later
 *   applied manual optimizations."
 *   "Speed: defines how fast the pendula swings."
 *   "Energy: changes some of the properties of the model, for example the
 *   gravity and mass."
 *   "Hit: When triggered, defines a new initial position of the pendula and new
 *   angular velocities." / "Rev: reverses the angular velocities."
 *   "Store: Saves the current state." / "Recall: Returns the pendula to the
 *   Stored state."
 *   "X: Horizontal position of the segment (normalized from −5 V to 5 V).
 *    Y: Vertical position … A: Angle of the segment …"
 *
 * ── WHAT THIS IS AND IS NOT ─────────────────────────────────────────────────
 * Their model came out of a SystemModeler multibody simulation and is not
 * published in any form. This is a COUPLED-PENDULUM CHAIN integrated by
 * semi-implicit Euler — the same FAMILY of system, so it is chaotic, its
 * segments are correlated, and its outputs have the wandering-but-related
 * character the module is used for. It is NOT their equations and will not
 * reproduce their trajectories. The spec's `help` says exactly that.
 *
 * ── THE MODEL ───────────────────────────────────────────────────────────────
 *     τ_i  = −g·sin(a_i) + k·(a_{i−1} − a_i) + k·(a_{i+1} − a_i) − c·ω_i
 *     ω_i ← ω_i + τ_i·dt      (semi-implicit: ω first, then a)
 *     a_i ← a_i + ω_i·dt
 *     x_i  = Σ_{j ≤ i} sin(a_j)/4,   y_i = −Σ_{j ≤ i} cos(a_j)/4
 * with a_0's left neighbour being the fixed pivot at 0. Semi-implicit Euler is
 * chosen over explicit because it conserves energy on a pendulum instead of
 * pumping it, which is what makes the chain hang rather than fly apart.
 *
 * ── DETERMINISM ─────────────────────────────────────────────────────────────
 * This carries state from sample to sample, which is legal for a DSP kernel and
 * not for a widget: it is a function of the audio stream and its own seed, never
 * of a frame clock. Same seed and same inputs, same trajectory, forever.
 *
 * ── DEVIATIONS ──────────────────────────────────────────────────────────────
 * D0, D2 (four trigger inlets), D3, D5, D8. The whole dynamics is D-MODEL.
 */
export class CaudalKernel {
  /** @param {number} sampleRate */
  constructor(sampleRate, options = {}) {
    this.sampleTime = 1 / sampleRate;
    this.rng = new Minstd0(options.seed === undefined ? CAUDAL_DEFAULT_SEED : options.seed);
    this.angle = new Float64Array(CAUDAL_SEGMENTS);
    this.velocity = new Float64Array(CAUDAL_SEGMENTS);
    this.storedAngle = new Float64Array(CAUDAL_SEGMENTS);
    this.storedVelocity = new Float64Array(CAUDAL_SEGMENTS);
    this.hit = new GateTrigger(true);
    this.rev = new GateTrigger(true);
    this.store = new GateTrigger(true);
    this.recall = new GateTrigger(true);
    this.rate = CAUDAL_MIN_RATE;
    this.gravity = CAUDAL_MIN_GRAVITY;
    this.kick();
  }

  /** Command. "Hit … defines a new initial position of the pendula and new
   *  angular velocities", from the seeded generator (D5). */
  kick() {
    for (let i = 0; i < CAUDAL_SEGMENTS; i++) {
      this.angle[i] = (this.rng.next01() - 0.5) * 2 * Math.PI;
      this.velocity[i] = (this.rng.next01() - 0.5) * 2 * this.rate;
    }
  }

  /** Command. Every sample (`controlDivisor` 1 — the manual's Speed CV is a
   *  modulation input and stepping it at a divided rate would stair-case it). */
  control(knobs, signals) {
    const speed = vc10Clamp(knobs.speed + signals.speed / RACK_VOLTS_PER_UNIT, 0, 1);
    const energy = vc10Clamp(knobs.energy + signals.energy / RACK_VOLTS_PER_UNIT, 0, 1);
    this.rate = CAUDAL_MIN_RATE * Math.pow(CAUDAL_MAX_RATE / CAUDAL_MIN_RATE, speed);
    this.gravity = CAUDAL_MIN_GRAVITY + (CAUDAL_MAX_GRAVITY - CAUDAL_MIN_GRAVITY) * energy;
  }

  /** Command. One sample; frame is [x1, y1, a1, … x4, y4, a4] in volts. */
  sample(knobs, signals, wired, frame) {
    this.hit.go(signals.hit);
    if (this.hit.triggered) this.kick();
    this.rev.go(signals.rev);
    if (this.rev.triggered) for (let i = 0; i < CAUDAL_SEGMENTS; i++) this.velocity[i] = -this.velocity[i];
    this.store.go(signals.store);
    if (this.store.triggered) {
      this.storedAngle.set(this.angle);
      this.storedVelocity.set(this.velocity);
    }
    this.recall.go(signals.recall);
    if (this.recall.triggered) {
      this.angle.set(this.storedAngle);
      this.velocity.set(this.storedVelocity);
    }

    const dt = this.rate * this.sampleTime;
    for (let i = 0; i < CAUDAL_SEGMENTS; i++) {
      const left = i === 0 ? 0 : this.angle[i - 1];
      const right = i === CAUDAL_SEGMENTS - 1 ? this.angle[i] : this.angle[i + 1];
      const torque = -this.gravity * Math.sin(this.angle[i])
        + CAUDAL_COUPLING * (left - this.angle[i])
        + CAUDAL_COUPLING * (right - this.angle[i])
        - CAUDAL_DAMPING * this.velocity[i];
      this.velocity[i] += torque * dt;
    }
    let x = 0;
    let y = 0;
    for (let i = 0; i < CAUDAL_SEGMENTS; i++) {
      this.angle[i] += this.velocity[i] * dt;
      x += Math.sin(this.angle[i]) / CAUDAL_SEGMENTS;
      y -= Math.cos(this.angle[i]) / CAUDAL_SEGMENTS;
      frame[i * 3] = x * CAUDAL_OUTPUT_VOLTS;
      frame[i * 3 + 1] = y * CAUDAL_OUTPUT_VOLTS;
      // The ANGLE output wraps rather than clipping, so a segment that goes over
      // the top keeps producing a usable modulation instead of pinning at 5 V.
      frame[i * 3 + 2] = (wrapPhase01(this.angle[i] / (2 * Math.PI) + 0.5) - 0.5) * 2 * CAUDAL_OUTPUT_VOLTS;
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 15. THE THREE INSTRUŌ NODES — TIER: BEHAVIOUR ONLY
//
// Instruō's VCV modules are CLOSED SOURCE and no DSP of theirs is published in
// any form ("free as in beer", not open source). Everything below is derived
// from the vendor's own user manuals, cited per node with the URL and the date
// they were read. THESE THREE WILL NOT SOUND IDENTICAL TO THE ORIGINALS, each
// node's own spec `help` says so in its first sentences, and no line below may
// be read as a transcription of anything.
// ═══════════════════════════════════════════════════════════════════════════

/** øchd has eight LFO cores. */
const OCHD_LFO_COUNT = 8;

/**
 * The ratio between neighbouring øchd cores. THE MANUAL FORCES AN IRRATIONAL
 * ONE AND THEN FORCES ITS VALUE — this is a derivation, not a taste:
 *
 *   - "The eight outputs are not synced or phase-shifted from each other but
 *     rather musically tuned intervals derived by manually changing capacitors."
 *     An integer or simple-rational family RE-LOCKS on a period; an irrational
 *     one never does, which is the behaviour the sentence describes. φ is the
 *     irrational that is hardest to approximate by a rational, so it is the
 *     family's natural choice.
 *   - The manual then pins BOTH ends: LFO 1 "can reach 160 Hz" at the top of the
 *     knob, and the range runs "down to a 25-minute cycle time" on LFO 8 at the
 *     bottom. With φ fixed, those two numbers FIX the knob's span:
 *         160 / φ⁷ / 2^span = 1/1500  ⟹  span ≈ 13 octaves
 *     and 13 is what `OCHD_RATE_SPAN_OCTAVES` is. Nothing here was chosen to
 *     taste except φ itself.
 */
const OCHD_RATIO = (1 + Math.sqrt(5)) / 2;

/** The fastest core's rate at the top of the knob, in hertz (the manual). */
const OCHD_MAX_HZ = 160;

/** How many octaves the Rate knob travels; see `OCHD_RATIO` for the derivation. */
const OCHD_RATE_SPAN_OCTAVES = 13;

/** "Analogue Modulation Source": the outputs are ±5 V triangles. */
const OCHD_OUTPUT_VOLTS = 5;

/**
 * Pure function. The hertz core `index` runs at for a given knob position.
 *
 * @param {number} index - 0…7, 0 being the fastest
 * @param {number} knob - 0…1
 * @returns {number} hertz
 *
 * @example ochdRateHz(0, 1) // 160
 * @example Math.abs(ochdRateHz(1, 1) - 160 / ((1 + Math.sqrt(5)) / 2)) < 1e-12 // true
 * @example Math.abs(1 / ochdRateHz(7, 0) - 1487) < 5 // true
 */
export function ochdRateHz(index, knob) {
  const fastest = OCHD_MAX_HZ * Math.pow(2, -OCHD_RATE_SPAN_OCTAVES * (1 - vc10Clamp(knob, 0, 1)));
  return fastest / Math.pow(OCHD_RATIO, index);
}

/**
 * ØCHD — eight free-running analogue triangle LFOs from one Rate knob.
 *
 * ── DERIVATION RECORD (TIER: BEHAVIOUR ONLY) ────────────────────────────────
 * instruomodular.com/wp-content/uploads/2020/05/Ochd-Manual-A5.pdf and
 * instruomodular.com/product/ochd/, read 2026-08-06:
 *   "8 all analogue LFOs in a convenient 4HP package."
 *   "The Rate knob is a global parameter that sets the frequency of all eight
 *   LFOs. When fully clockwise, each individual LFO is at the top of its range —
 *   LFO 1, the fastest, can reach 160 Hz without external control voltage."
 *   "Each independent core is free running with rates configured from fastest to
 *   slowest arranged top to bottom … not synced or phase-shifted from each other
 *   but rather musically tuned intervals."
 *   "Range: 160 Hz down to a 25-minute cycle time, going much lower with CV."
 *   "The Rate CV Input is a bipolar control voltage input … summed with the knob
 *   position and scaled/inverted by the Rate Attenuverter, and applying positive
 *   CV can force each LFO's frequency to exceed the range accessible by the knob."
 *
 * ── THE MODEL ───────────────────────────────────────────────────────────────
 *     k       = knob + attenuverter·cv/5                  [CV may exceed the knob]
 *     f_i     = 160·2^(−13(1 − k)) / φ^i
 *     φ_i    ← frac(φ_i + f_i/fs)
 *     out_i   = triangle(φ_i) · 5 V
 * The eight phases start SPREAD rather than aligned, because eight analogue
 * cores that powered up together would still be at eight arbitrary points and a
 * module whose outputs all cross zero at t = 0 is the one thing the manual says
 * øchd is not. The spread is the golden-ratio sequence, seeded and reproducible.
 *
 * ── DEVIATIONS ──────────────────────────────────────────────────────────────
 * D0, D3, D8. The waveform, the ratio family and the knob law are all D-MODEL.
 * D-EXPANDER — the [ø]4^2 expander is a separate module and is not ported.
 * D-STALL — the manual's track-and-hold trick (invert a gate into the Rate CV so
 *   every core stalls) works here for free: at k ≤ 0 the increments go to
 *   essentially zero and the outputs hold. Not special-cased, and it should not
 *   be — it falls out of the rate law, which is why the trick works on hardware.
 */
export class OchdKernel {
  /** @param {number} sampleRate */
  constructor(sampleRate) {
    this.sampleTime = 1 / sampleRate;
    this.phase = new Float64Array(OCHD_LFO_COUNT);
    this.increment = new Float64Array(OCHD_LFO_COUNT);
    for (let i = 0; i < OCHD_LFO_COUNT; i++) this.phase[i] = wrapPhase01(i / OCHD_RATIO);
  }

  /** Command. Every sample (`controlDivisor` 1). */
  control(knobs, signals) {
    const k = knobs.rate + knobs.rateAtten * (signals.rate_cv / RACK_VOLTS_PER_UNIT);
    for (let i = 0; i < OCHD_LFO_COUNT; i++) {
      this.increment[i] = vc10Clamp(ochdRateHz(i, k) * this.sampleTime, 0, 0.45);
    }
  }

  /** Command. One sample; frame is the eight outputs in volts. */
  sample(knobs, signals, wired, frame) {
    for (let i = 0; i < OCHD_LFO_COUNT; i++) {
      this.phase[i] = wrapPhase01(this.phase[i] + this.increment[i]);
      const t = this.phase[i];
      frame[i] = (t < 0.5 ? 4 * t - 1 : 3 - 4 * t) * OCHD_OUTPUT_VOLTS;
    }
  }
}

// ── ATHRÚ ───────────────────────────────────────────────────────────────────

/** The Symmetry Bias switch's two positions, from the manual's own words: in
 *  "summing" mode the jack is an external SIGNAL input summed ahead of the fold;
 *  in "bias" mode the attenuverter is a DC offset. */
export const ATHRU_SYMMETRY_MODES = Object.freeze(["sum", "bias"]);

/** The Wavefold fader's exponential VCA — "moving the fader fully downwards
 *  reduces the Input signal's amplitude, resulting in near-silence", so the
 *  bottom is a real attenuator and not a unity floor. */
const ATHRU_MIN_FOLD_GAIN = 0.02;
const ATHRU_MAX_FOLD_GAIN = 12;

/** How many volts of DC the Symmetry Bias attenuverter adds in `bias` mode.
 *  "The center position is calibrated to 0 V." */
const ATHRU_MAX_BIAS_VOLTS = 5;

/** The Drive toggle's overdrive gain, normalised so unity input stays unity. */
const ATHRU_DRIVE_GAIN = 4;

/** The Strike Decay knob's span in seconds; the manual gives a behaviour and a
 *  "50% default position" and no number. */
const ATHRU_MAX_STRIKE_SECONDS = 2;

/**
 * ATHRÚ — Instruō's analogue wavefolder.
 *
 * ── DERIVATION RECORD (TIER: BEHAVIOUR ONLY) ────────────────────────────────
 * instruomodular.com/wp-content/uploads/2020/05/Athru-Manual-A5.pdf, read
 * 2026-08-06:
 *   "wavefolding inverts signal amplitude when it passes an amplitude threshold,
 *   and this folding can occur multiple times."
 *   "It began as a derivative of the West Coast timbre circuit … with depth
 *   control via an exponential VCA and summing with a scalable symmetry bias."
 *   "The Wavefold fader controls the amount of wavefolding … fully downwards
 *   reduces the Input signal's amplitude, resulting in near-silence."
 *   "There is a dedicated Wavefold CV Input with an attenuverter … Depth CV runs
 *   through an exponential response VCA."
 *   "The Symmetry Bias Switch changes the behavior of the Symmetry Bias
 *   Attenuverter … in the summing mode, external signals are summed together
 *   before reaching the wavefolding stage … the center position is calibrated
 *   to 0 V."
 *   "A gate or trigger signal at the Strike Input momentarily activates the
 *   wavefolder. Its decay is adjusted via the Strike Decay knob."
 *   "Analog overdrive can be applied to the signal; toggle up enables overdrive."
 *
 * ── THE MODEL ───────────────────────────────────────────────────────────────
 *     bias   = symmetry mode == sum ? symCV·atten : atten·5 V
 *     summed = in + bias
 *     depth  = 0.02·(600)^(fold + foldCV·atten + strike)      [exponential VCA]
 *     folded = triangleFold(summed/5 · depth)
 *     out    = (drive ? tanh(4·folded)/tanh(4) : folded) · 5 V
 * The fold itself is `AudioMath::fold` — a triangle reflection about ±1, which
 * is what a diode ladder folder approximates and what every West-Coast folder in
 * this repo already uses.
 *
 * ── THE SECOND OUTPUT IS A GUESS AND IS LABELLED ONE ────────────────────────
 * The stub carried `ports PROVISIONAL` with two outputs, `out` and `thru`, taken
 * from a patch's cable indices. **The hardware manual documents exactly ONE
 * output.** Rather than delete a port the demo patch wires, `thru` is defined as
 * the SUMMED, PRE-FOLD signal — the one signal the module demonstrably has that
 * a second jack could carry, and the one the manual's "Summed Wavefolder" patch
 * would want. Reported to the lead as UNVERIFIED; if the VCV module's second
 * output is something else, this is where to change it.
 *
 * ── DEVIATIONS ──────────────────────────────────────────────────────────────
 * D0, D2 (the strike inlet), D3, D6, D8. Everything else is D-MODEL, and
 * D-THRU is the unverified port above.
 */
export class AthruKernel {
  /** @param {number} sampleRate */
  constructor(sampleRate) {
    this.sampleTime = 1 / sampleRate;
    this.strikeEnv = 0;
    this.gate = new GateTrigger(true);
    this.symmetryMode = "sum";
    this.drive = false;
  }

  /** Command. The Symmetry Bias switch. */
  setSymmetryMode(value) {
    this.symmetryMode = vc10Option("AthruKernel", "symmetryMode", value, ATHRU_SYMMETRY_MODES);
  }

  /** Command. The Drive toggle. */
  setDrive(value) {
    this.drive = vc10Option("AthruKernel", "drive", value, ["off", "on"]) === "on";
  }

  /** Command. Every sample (`controlDivisor` 1). */
  control() {}

  /** Command. One sample; frame is [out, thru] in volts. */
  sample(knobs, signals, wired, frame) {
    this.gate.go(signals.strike);
    if (this.gate.triggered) this.strikeEnv = 1;
    const tau = Math.max(knobs.strikeDecay * ATHRU_MAX_STRIKE_SECONDS, this.sampleTime);
    this.strikeEnv *= Math.exp(-this.sampleTime / tau);

    const bias = this.symmetryMode === "sum"
      ? signals.symmetry_cv * knobs.symmetryAtten
      : knobs.symmetryAtten * ATHRU_MAX_BIAS_VOLTS;
    const summed = signals.in + bias;

    const amount = vc10Clamp(
      knobs.fold + knobs.foldAtten * (signals.fold_cv / RACK_VOLTS_PER_UNIT) + this.strikeEnv, 0, 1,
    );
    const depth = ATHRU_MIN_FOLD_GAIN * Math.pow(ATHRU_MAX_FOLD_GAIN / ATHRU_MIN_FOLD_GAIN, amount);

    let folded = audioMathFold((summed / RACK_VOLTS_PER_UNIT) * depth);
    if (this.drive) folded = Math.tanh(ATHRU_DRIVE_GAIN * folded) / Math.tanh(ATHRU_DRIVE_GAIN);
    frame[0] = folded * RACK_VOLTS_PER_UNIT;
    frame[1] = summed;
  }
}

// ── SAÏCH ───────────────────────────────────────────────────────────────────

/** saïch has four analogue cores. */
const SAICH_VOICES = 4;

/** "each detune knob has a range of about ±1 semitone" (Instruō, via the forum
 *  reply the manual research turned up). */
const SAICH_DETUNE_SEMITONES = 1;

/** "Voice 1 can be set to ramp, sawtooth, or pulse waveforms, while voices 2
 *  through 4 only generate ramp waveforms." A ramp and a sawtooth differ only in
 *  sign, which is exactly why both are offered. */
export const SAICH_WAVES = Object.freeze(["ramp", "saw", "pulse"]);

/** "The Sub Button cycles through four waveform/sub options for oscillator 1 —
 *  Sub Mode 1 is the fundamental sawtooth, Sub Mode 2 an inverted sawtooth
 *  dropped one octave, etc." The third and fourth are not documented; two more
 *  octaves down is the obvious continuation and is labelled a guess. */
export const SAICH_SUB_MODES = Object.freeze(["fundamental", "sub1", "sub2", "subMix"]);

/** "seven mix profiles determining how voices combine at the Output. Profiles
 *  include Voice Arpeggiator, Voice Subtraction, Odds to Evens, Smart Pairs, and
 *  Constant Root, plus Cascade Crossfade and Basic VCA." */
export const SAICH_MIX_PROFILES = Object.freeze([
  "basicVca", "cascadeCrossfade", "oddsToEvens", "smartPairs",
  "constantRoot", "voiceSubtraction", "voiceArpeggiator",
]);

/**
 * Pure function. One voice's gain under one mix profile at one Scan position.
 * THE PROFILES ARE NAMED BY THE MANUAL AND DEFINED HERE — their curves are not
 * published, so each is the simplest function that matches its own NAME and
 * leaves the Scan fader monotone and continuous.
 *
 * @param {string} profile - one of SAICH_MIX_PROFILES
 * @param {number} voice - 0…3
 * @param {number} scan - 0…1
 * @returns {number} 0…1 gain
 *
 * @example saichVoiceGain("basicVca", 0, 0.5) // 0.5
 * @example saichVoiceGain("constantRoot", 0, 0) // 1
 * @example saichVoiceGain("voiceSubtraction", 3, 1) // 0
 */
export function saichVoiceGain(profile, voice, scan) {
  const s = vc10Clamp(scan, 0, 1);
  switch (profile) {
    case "basicVca":
      return s;
    case "cascadeCrossfade": {
      // The scan walks a triangular window along the four voices.
      const centre = s * (SAICH_VOICES - 1);
      return Math.max(0, 1 - Math.abs(voice - centre));
    }
    case "oddsToEvens":
      return voice % 2 === 0 ? 1 - s : s;
    case "smartPairs":
      return voice < 2 ? 1 - s : s;
    case "constantRoot":
      return voice === 0 ? 1 : s;
    case "voiceSubtraction":
      // Voices leave one at a time as the fader rises, highest voice first.
      return vc10Clamp((SAICH_VOICES - voice) - s * SAICH_VOICES, 0, 1);
    case "voiceArpeggiator": {
      // A hard selector rather than a crossfade — one voice at a time.
      const selected = Math.min(SAICH_VOICES - 1, Math.floor(s * SAICH_VOICES));
      return voice === selected ? 1 : 0;
    }
    default:
      throw new Error(`saichVoiceGain: unknown profile ${JSON.stringify(profile)}`);
  }
}

/** Their own output level, so four ramps at once still land inside Rack's ±10 V. */
const SAICH_OUTPUT_VOLTS = 5;

/**
 * SAÏCH — a quad analogue oscillator with a "smart" VCA mixer and one output.
 *
 * ── DERIVATION RECORD (TIER: BEHAVIOUR ONLY) ────────────────────────────────
 * instruomodular.com/wp-content/uploads/2020/10/saïch-Manual.pdf and
 * library.vcvrack.com/Instruo/saich, read 2026-08-06:
 *   panel: "Output, Voice Amplitude Indicators, Global Coarse Frequency, Detune
 *   Controls, 1V/Oct Inputs, Global Fine Frequency, PWM CV Input, CV Input &
 *   Attenuverter, CTRL Button, Sub Button, Mix Profile Button, and the Fader."
 *   "The 1V/Oct inputs are bipolar CV inputs calibrated to 1 volt per octave,
 *   with an independent 1V/Oct input per voice. Voice 1's input normals to the
 *   other inputs in parallel."
 *   "Voices 2, 3, and 4 have dedicated Detune controls."
 *   "Voice 1 can be set to ramp, sawtooth, or pulse; voices 2 through 4 only
 *   generate ramp waveforms."
 *   "Mix Profile Scan is a macro control … digitally controlled analogue VCAs to
 *   mix amplitudes between the four voices, with seven mix profiles."
 *   "The saïch has a single mixed Out rather than per-voice outputs."
 *
 * ── WHAT IS INFERRED, SAID PLAINLY ──────────────────────────────────────────
 * The manual gives no tuning ORIGIN, so `squinkySemitonesToHz`'s C4 is used and
 * the spec says so. The seven mix-profile CURVES are not published; see
 * `saichVoiceGain`. The demo patch's port indices 0 and 6 are read as voice 1's
 * V/oct and the Scan CV, which is an INFERENCE from the panel order the manual
 * lists — reported to the lead as such.
 *
 * ── DEVIATIONS ──────────────────────────────────────────────────────────────
 * D0, D1 (origin assumed), D3 (voice 2…4's V/oct NORMALLING is a real
 * `isConnected` branch and is ported), D6, D8, D-BLEP. Everything else is
 * D-MODEL.
 */
export class SaichKernel {
  /** @param {number} sampleRate */
  constructor(sampleRate) {
    this.voices = [];
    for (let i = 0; i < SAICH_VOICES; i++) this.voices.push(new VultVaOscillator(sampleRate));
    this.wave = "ramp";
    this.sub = "fundamental";
    this.mixProfile = "basicVca";
  }

  /** Command. Voice 1's waveform. */
  setWave(value) {
    this.wave = vc10Option("SaichKernel", "wave", value, SAICH_WAVES);
  }

  /** Command. The Sub button. */
  setSub(value) {
    this.sub = vc10Option("SaichKernel", "sub", value, SAICH_SUB_MODES);
  }

  /** Command. The Mix Profile button. */
  setMixProfile(value) {
    this.mixProfile = vc10Option("SaichKernel", "mixProfile", value, SAICH_MIX_PROFILES);
  }

  /** Command. Every sample (`controlDivisor` 1). */
  control(knobs, signals, wired) {
    const detune = [0, knobs.detune2, knobs.detune3, knobs.detune4];
    for (let i = 0; i < SAICH_VOICES; i++) {
      // D3: voice 1's inlet NORMALS to the others; a cable in any of them breaks
      // that normal, which is exactly an `isConnected` branch.
      const own = signals[`voct${i + 1}`];
      const voct = i === 0 || wired[`voct${i + 1}`] ? own : signals.voct1;
      const semitones = voct + knobs.coarse + knobs.fine
        + detune[i] * SAICH_DETUNE_SEMITONES
        + (i === 0 ? SAICH_SUB_OCTAVES[this.sub] * SEMITONES_PER_OCTAVE : 0);
      this.voices[i].setFrequencyHz(squinkySemitonesToHz(semitones));
    }
  }

  /** Command. One sample; frame is [out] in volts. */
  sample(knobs, signals, wired, frame) {
    const scan = vc10Clamp(knobs.scan + knobs.cvAtten * (signals.scan / RACK_VOLTS_PER_UNIT), 0, 1);
    const pw = vc10Clamp(knobs.pw + signals.pwm / RACK_VOLTS_PER_UNIT, 0, 1);
    let mix = 0;
    for (let i = 0; i < SAICH_VOICES; i++) {
      // Voices 2…4 are ramps only; only voice 1 sees the wave and sub controls.
      const wave = i === 0 && this.wave === "pulse" ? SAICH_PULSE_MORPH : SAICH_RAMP_MORPH;
      let value = this.voices[i].step(i === 0 ? pw : 0.5, wave);
      if (i === 0) {
        if (this.wave === "saw") value = -value;
        if (this.sub === "sub1") value = -value;
      }
      mix += value * saichVoiceGain(this.mixProfile, i, scan);
    }
    frame[0] = (mix / SAICH_VOICES) * SAICH_OUTPUT_VOLTS;
  }
}

/** `VultVaOscillator`'s morph positions for the two shapes saïch offers. */
const SAICH_RAMP_MORPH = 0;
const SAICH_PULSE_MORPH = 0.5;

/** How far below the fundamental each Sub mode parks voice 1. Mode 2 is the
 *  manual's own "inverted sawtooth dropped one octave"; modes 3 and 4 continue
 *  the pattern and are a documented guess (`SAICH_SUB_MODES`). */
const SAICH_SUB_OCTAVES = Object.freeze({ fundamental: 0, sub1: -1, sub2: -2, subMix: -1 });

