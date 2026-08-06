/**
 * AX-2 — THE AXOLOTI OSCILLATOR / LFO / NOISE KERNELS, PORTED TO FLOAT.
 *
 * ── WHAT THIS FILE IS ───────────────────────────────────────────────────────
 * Ten Axoloti nodes' DSP, and nothing else. No AudioNodes, no AudioWorklet, no
 * DOM: plain ES module, so `tests/port_ax2_test.js` can run every recurrence in
 * BARE NODE and compare it against an integer model of the C original. That
 * separation is the whole point — the arithmetic is the deliverable, so the
 * arithmetic must be reachable by a test that needs no browser.
 *
 * `worklets/processors_ax2.js` imports this and wraps each kernel in an
 * AudioWorkletProcessor; `modules_ax2.js` wires those into engine modules.
 *
 * ── THE DERIVATION RECORD ───────────────────────────────────────────────────
 * Sources, both cloned READ-ONLY and read at the commits below on 2026-08-06:
 *
 *   factory   axoloti/axoloti-factory @ 78cb74bd0b118f6b951ccd6b92a62b1bae0ff1aa
 *   firmware  axoloti/axoloti         @ 46f6e4b383ce182da9dcca25b9d4b544fe20f990
 *
 * `axoloti-contrib @ 1.0.12 (798166f)` was cloned but NO AX-2 row needs it: every
 * object in this block is factory. Each kernel's own docblock names its object
 * file, WHICH CODE BLOCK the recurrence came from (`code.krate` / `code.srate` /
 * a firmware function), the float recurrence, and every deliberate deviation.
 *
 * ── THE FIXED-POINT LAWS THIS FILE IMPLEMENTS (manifest § R7-11) ────────────
 *
 *   XML dial (−64…64) ──×2^21──▶ raw int32 ──pfunction──▶ param_X ──/2^27──▶ float
 *
 * 1. `frac32` is signed Q27: real = i / 2^27, full scale ±1.0, ±16.0 of headroom.
 *    A dial reading 64 IS 1.0.
 * 2. `frac32.s.map.pitch` and `frac32.s.map.lfopitch` both resolve to
 *    `parameter_function::pf_signed_clamp` = `__SSAT(v, 28)`
 *    (firmware `api/parameter_functions.h:27`, selected by
 *    `ParameterFrac32SMap.getPFunction()`). So the pitch pfunction is a CLAMP and
 *    nothing else: the dial's semitone number reaches the code unchanged.
 * 3. PITCH: 1 semitone = `1<<21`, pitch 0 = MIDI 64 = E4 = 329.6276 Hz, so
 *    `hz = 440·2^((p−5)/12)`. Their `pitcht` is built exactly that way
 *    (firmware `axoloti_math.c` `axoloti_math_init`).
 * 4. "FREQUENCY" IN OBJECT CODE IS A 32-BIT PHASE INCREMENT (`2^32·f/fs`), which
 *    is why every oscillator is `Phase += freq` with uint32 wraparound AS the
 *    modulo. Here the phase is a float in [0,1) and the increment is cycles per
 *    sample; `raw = φ·2^32` recovers theirs.
 * 5. CONTROL RATE IS EXACTLY sampleRate/BUFSIZE with BUFSIZE = 16
 *    (`api/axoloti.h:8`) — 3000 Hz on their hardware. `KRATE_BUFSIZE` below is
 *    that 16, and every kernel exposes `control()` (once per 16 samples) and
 *    `sample()` (per sample). Hoisting `control()` to once per 128-frame quantum
 *    would run every LFO 8× slow; the processor drives the split, not the kernel.
 * 6. `___SMMUL(a,b) << s` is `a·b / 2^(32−s)`, TRUNCATING. Where a truncation is
 *    load-bearing (a table index, an LFSR) it is reproduced with `| 0` / `>>>`;
 *    where it is a rounding-error-sized detail it is dropped and MEASURED
 *    (`tests/port_ax2_test.js` reports the max absolute error of every one).
 *
 * ── DELIBERATE DEVIATIONS, ALL OF THEM, NAMED ───────────────────────────────
 *
 * D1. SAMPLE RATE. Their tables are baked at 48000. Ours are built from the
 *     RUNNING `sampleRate`, so `buildIncrementTable(48000)` is bit-comparable to
 *     theirs and 44100 still plays in tune. Their hard clamp `phi > 2^31 →
 *     0x7FFFFFFF` is at 24 kHz = THEIR Nyquist, so it ports as `MAX_INCREMENT`
 *     (0.5 cycles/sample) and stays Nyquist at any rate.
 * D2. THE PITCH TABLE'S ERROR IS REPRODUCED, NOT REMOVED. `mtof48k_q31`
 *     interpolates `pitcht` LINEARLY between whole semitones, which reads sharp
 *     by up to 0.72 cents mid-semitone (exact at every integer semitone). Kept,
 *     because detuned unisons and `osc/supersaw` beat at rates set by the
 *     DIFFERENCE between two such increments — smoothing it would change the
 *     one thing a supersaw is for. `tests/port_ax2_test.js` measures the cent
 *     error against exact `2^(p/12)` so the cost is on the record.
 * D3. THE SINE TABLE IS NOT SHIPPED. `SINE2TINTERP` reads a 4096-entry q31 table
 *     with linear interpolation; that interpolation's own worst-case deviation
 *     from an ideal sine is (2π/4096)²/8 ≈ 2.9e-7 (−130 dBFS), which is far below
 *     the ±2^-27 (−162 dBFS) quantisation everything else here already discards
 *     and 40 dB below a 16-bit noise floor. We call `Math.sin`. The test MEASURES
 *     the table's deviation rather than asserting it, so the justification is a
 *     number and not an opinion.
 * D4. NOISE IS SEEDED AND REPRODUCIBLE. `rand_s32` (firmware `axoloti_math.h`)
 *     folds the STM32 hardware RNG into its state, so THEIR noise is not
 *     reproducible at all. `noise/pink` and `noise/gaussian` already carry a pure
 *     LCG (`seed*196314165 + 907633515`) and reach the hardware only to SEED it,
 *     so the minimal faithful substitution is: keep that exact LCG, and replace
 *     `GenerateRandomNumber()` in each object's `code.init` with the node's
 *     `seed` knob. Seed 0 reproduces their initialiser constants exactly.
 *     `noise/uniform` and `rand/uniform*` read `rand_s32` per sample; they get
 *     the same LCG. Determinism is non-negotiable (manifest, "the three kinds of
 *     state") and this is an improvement, not a deviation to apologise for.
 * D5. `rand/pink oct`'s WHITE TERM. Their octave buffers are always `seed>>7`
 *     but the added white term is `seed>>attr_octaves`; at octaves = 3 that is
 *     ±2.0, eight times full scale, contradicting the object's own
 *     "Range -64..64". We scale EVERY term by `1/(octaves+1)`, which is
 *     bit-identical at octaves = 7 (their default, and the only setting where
 *     their code is self-consistent) and in range everywhere else.
 * D6. THE POLYNOMIAL IS A NUMBER, NOT A 160-ENTRY DROPDOWN. `seq/lfsrseq`'s
 *     `<combo>` lists 160 taps and `pulse/lfsrburst 8`'s lists 16. Both are
 *     exposed as an integer knob (so an equation can drive them, which their
 *     dropdown cannot); the maximal-length values are named in the spec `help`.
 * D7. A `freq` (FM) INPUT ON EVERY OSCILLATOR WAVEFORM. `osc/sine` and
 *     `osc/phasor compl` have one; `osc/saw`, `osc/square`, `osc/pwm` do not.
 *     Adding it is a strict generalisation with no artefact: the BLEP dispatch
 *     already divides by the INSTANTANEOUS increment, so a modulated increment
 *     lands its correction in the right sub-sample slot.
 * D9. INLETS CARRY THE KNOB'S OWN UNITS, NOT frac32. On hardware every wire is
 *     a frac32, so a `pitch` inlet of 1.0 means 64 semitones, a `freq` inlet of
 *     1.0 means sampleRate/32 hertz and a `phase` inlet of 1.0 means half a
 *     cycle — all of them artefacts of having ONE wire type, not of musical
 *     intent. Our wires carry floats and our engine's convention (OSCILLATOR_SPEC:
 *     knob `frequency` in Hz AND input `frequency` in Hz, summing on one
 *     AudioParam) is same-units. So: `pitch` in SEMITONES, `freq` in HERTZ,
 *     `phase` in CYCLES, `pw` unchanged in [−1,1]. TO TRANSCRIBE AN AXOLOTI
 *     PATCH: multiply a frac32 pitch wire by SEMITONES_PER_FRAC32 (64), a freq
 *     wire by sampleRate·FM_CYCLES_PER_FRAC32, a phase wire by
 *     CYCLES_PER_FRAC32_PHASE (0.5). Those three constants are exported for
 *     exactly that, and are what the fixed-point law reduces to.
 * D10. THE BLEP DISPATCH INDEX CAN LAND ONE TABLE ENTRY OUT. Their sub-sample
 *     position is `osc_p / (freq>>6)`, an integer division by a FLOORED divisor;
 *     ours is `64·φ/inc` in float. The floor makes their quotient a shade larger,
 *     so the two occasionally pick adjacent `blept` entries — 1/64 of a sample of
 *     jitter on where one correction starts. MEASURED (tests/port_ax2_test.js):
 *     bit-identical at 55/110/220/440/3000 Hz, and 1.24e-2 worst-case on ONE
 *     sample per cycle at 1000 and 7000 Hz. Reproducing the floor exactly would
 *     mean carrying a 2^32 integer grid through a float port, which is the thing
 *     this port exists not to do, and the SPECTRAL cost is nil: the alias floor
 *     is −80.7 dB either way.
 * D11. THEIR `f0i` OVERFLOWS AT THE NYQUIST CLAMP, AND WE DO NOT COPY IT.
 *     `osc/saw medium` and `osc/supersaw` compute the slope of their one-sample
 *     correction as `0x7fffffff / ((1 + (int)freq) >> 11)`. When `freq` saturates
 *     at `0x7FFFFFFF`, `1 + freq` overflows int32 to −2^31, the shift keeps the
 *     sign, and `f0i` becomes −2047 — a SIGN INVERSION, not a saturation, which
 *     is the same failure AX-1 measured in `math/*`. MEASURED here on the integer
 *     model: the waveform stops being bipolar and runs 0.125…0.375, three times
 *     its own full scale with a DC offset. Reachable from the pitch knob above
 *     about +74 semitones. Our float has no `f0i` at all — the correction is
 *     `⅛·(1 − 2u)` directly — so it stays in range, and this is one of the two
 *     places we deliberately sound BETTER than the source.
 * D8. `lfo/sine lin` IS NOT PORTED. It differs from `lfo/sine` by reading the
 *     1024-entry NON-interpolated `sinet` table, and `sinet` is built from CMSIS
 *     `arm_sin_q31` — itself a 512-entry interpolated table that is in neither
 *     pinned repository. Approximating it with `Math.sin` would silently claim a
 *     fidelity we cannot measure, so the variant is omitted and said out loud
 *     rather than faked.
 *
 * Every kernel here is a class with `control(c)` and `sample(c, out)`; both are
 * COMMANDS (they advance the kernel's own state) and neither allocates, because
 * they run on the audio thread. The pure helpers above them are labelled
 * individually.
 */

// ── THE PLATFORM CONSTANTS ──────────────────────────────────────────────────

/** Axoloti's `BUFSIZE` (`api/axoloti.h:8`): samples per control tick. THE
 *  number that makes the control rate 3000 Hz at 48 kHz. */
export const KRATE_BUFSIZE = 16;

/** frac32 full scale: `real = raw / 2^27`. */
const FRAC32_ONE = 2 ** 27;

/** One semitone in raw parameter units (`ConvertIntToFrac`, `i<<21`). */
const SEMITONE_RAW = 2 ** 21;

/** The raw grid `__SSAT` saturates on, in semitones — the positive clamp is
 *  `2^N − 1`, one raw step below the round number. */
const SEMITONE_STEP = 1 / SEMITONE_RAW;

/** A frac32 signal of 1.0 arriving on a PITCH inlet is 64 semitones, because a
 *  pitch is raw semitones × 2^21 and frac32 1.0 is 2^27. */
export const SEMITONES_PER_FRAC32 = FRAC32_ONE / SEMITONE_RAW;

/** A frac32 signal of 1.0 arriving on a `freq` (FM) inlet is 2^27 of a 2^32
 *  phase, i.e. 1/32 cycle per sample = sampleRate/32 Hz. */
export const FM_CYCLES_PER_FRAC32 = FRAC32_ONE / 2 ** 32;

/** A frac32 signal of 1.0 arriving on a PHASE inlet is `<<4` = 2^31 of a 2^32
 *  phase, i.e. half a cycle. (`osc/sine`'s `inlet_phase<<4`.) */
export const CYCLES_PER_FRAC32_PHASE = 0.5;

/** `MTOF` clamps its pitch with `__SSAT(p,28)` = ±2^27 raw = ±64 semitones. */
export const MTOF_CLAMP_SEMITONES = 64;

/** `MTOFEXTENDED` clamps with `__SSAT(p,29)` = ±2^28 raw = ±128 semitones. */
export const MTOF_EXT_CLAMP_SEMITONES = 128;

/** int32 → frac32 is `<<21`, so an integer i arrives as `i/64` of full scale —
 *  the cross-type coercion `rand/uniform i`'s output goes through. */
export const INT_TO_FRAC32 = SEMITONE_RAW / FRAC32_ONE;

/** `pulse/d`'s per-sample loss is `val·param_d/2^33`; with the dial normalised
 *  to 0…1 (their 0…64) that is `val·decay/64`. */
const PULSE_DECAY_DIVISOR = 64;

/** `pitcht` has 257 entries, one per semitone from MIDI −64 to MIDI 192. */
const PITCH_TABLE_SIZE = 257;

/** Index of pitch 0 in `pitcht`: their lookup is `pitcht[128 + (p>>21)]`. */
const PITCH_TABLE_ZERO = 128;

/** Axoloti pitch 0 is MIDI 64 (E4, 329.6276 Hz) — not A440, not C. */
const AXOLOTI_PITCH_ZERO_MIDI = 64;

const A4_HZ = 440;
const A4_MIDI = 69;
const SEMITONES_PER_OCTAVE = 12;

/** Their `if (phi > 1<<31) phi = 0x7FFFFFFF` — a phase increment of half a cycle
 *  per sample IS Nyquist, so this clamp is Nyquist at any sample rate. */
export const MAX_INCREMENT = 0x7fffffff / 2 ** 32;

/** `lfo/*` runs `Phase += freq>>2` once per CONTROL tick, so an LFO's rate is
 *  `f/64` — the quarter here and the 16 of KRATE_BUFSIZE are the whole factor. */
const LFO_INCREMENT_DIVISOR = 4;

/** The LCG `noise/pink` and `noise/gaussian` already use, verbatim. */
const LCG_MULTIPLIER = 196314165;
const LCG_INCREMENT = 907633515;

/** int32 → real for an LCG draw: `(int32)seed >> 4` is q27, so `real =
 *  (int32)seed / 2^31`. */
const INT32_SCALE = 2 ** 31;

/** `blept` (firmware `axoloti_oscs.c:23`) rises to this and is clamped there;
 *  dividing by it turns the table into a unit step, so a settled voice
 *  contributes exactly zero correction. */
const BLEP_UNITY = 16384;

/** Sub-sample resolution of `blept`: a voice's pointer advances by 64 entries
 *  per sample (`t += 64`), so 2048 entries are 32 samples of impulse response. */
const BLEP_SUBSAMPLES = 64;

/** `osc/saw` declares `blepvoices = 4`; `osc/square` and `osc/pwm` declare 8.
 *  Both are round-robin, so a 5th (resp. 9th) overlapping transition STEALS the
 *  oldest and clicks — a faithful artefact at extreme frequencies. */
const SAW_BLEP_VOICES = 4;
const PULSE_BLEP_VOICES = 8;

/** `noise/pink`'s dyadic (Voss-McCartney) update tree: entry `i` names which
 *  octave buffer is redrawn on tick `i`. Verbatim from `noise/pink.axo`
 *  `code.declaration`, with their `-1` terminator replaced by the octave index
 *  that `rand/pink oct` uses (7) so ONE table serves both objects. */
const PINK_DYADIC_TREE = Int8Array.from([
  0, 1, 0, 2, 0, 1, 0, 3, 0, 1, 0, 2, 0, 1, 0, 4, 0, 1, 0, 2, 0, 1, 0, 3, 0, 1, 0, 2, 0, 1, 0, 5,
  0, 1, 0, 2, 0, 1, 0, 3, 0, 1, 0, 2, 0, 1, 0, 4, 0, 1, 0, 2, 0, 1, 0, 3, 0, 1, 0, 2, 0, 1, 0, 6,
  0, 1, 0, 2, 0, 1, 0, 3, 0, 1, 0, 2, 0, 1, 0, 4, 0, 1, 0, 2, 0, 1, 0, 3, 0, 1, 0, 2, 0, 1, 0, 5,
  0, 1, 0, 2, 0, 1, 0, 3, 0, 1, 0, 2, 0, 1, 0, 4, 0, 1, 0, 2, 0, 1, 0, 3, 0, 1, 0, 2, 0, 1, 0, 7,
]);

/** `noise/pink`'s octave count, and the most `rand/pink oct` offers. */
export const PINK_MAX_OCTAVES = 7;

/** `noise/gaussian` sums 8 independent LCG streams (Irwin–Hall n = 8), which is
 *  what makes it approximately Gaussian and exactly ±1.0 at the extremes. */
const GAUSSIAN_STREAMS = 8;

/** `noise/gaussian`'s eight `code.init` seed constants, verbatim. Deviation D4
 *  replaces each `+ GenerateRandomNumber()` with `+ seed`. */
const GAUSSIAN_SEEDS = Uint32Array.from([
  0x21c32332, 0xfbc57f7a, 0x7dd1ef4a, 0xe4ec34ad, 0x72007b2f, 0x3d1e9783, 0xa4a8f892, 0xc82c5e28,
]);

/** `noise/pink`'s single `code.init` seed constant, verbatim (deviation D4). */
const PINK_SEED = 0x830af41e;

/** `osc/supersaw`'s six detune coefficients, verbatim from its `code.krate`
 *  `___SMMLA(f0d, C, f0)` calls. Applied as `f_k = f0·(1 + d²·C/2^34)` — see
 *  SupersawKernel for the derivation of that exponent. */
const SUPERSAW_DETUNE_COEFFS = Int32Array.from([
  -0x54321230, -0x31111110, -0x10203040, 0x10304500, 0x32121210, 0x55422110,
]);

/** The divisor that turns a raw `___SMMLA` coefficient into a frequency ratio:
 *  `det = SMMUL(det1,det1)` is `d²·2^22`, `det<<8` is `d²·2^30`, and
 *  `f0d = SMMUL(det<<8, f0)` is `d²·f0/4`, so `f0d·C/2^32 = f0·d²·C/2^34`. */
const SUPERSAW_COEFF_SCALE = 2 ** 34;

/** `osc/supersaw` runs seven saws; voice 6 is undetuned and `code.init` spreads
 *  the start phases at `i<<28`, i.e. i/16 of a cycle. */
const SUPERSAW_VOICES = 7;
const SUPERSAW_PHASE_SPREAD = 1 / 16;

/** `osc/saw medium` (and therefore every supersaw voice) emits `p2>>7` of a full
 *  int32 phase, which is ±2^24 in q27 = ±1/8 of full scale. NOT a bug and NOT
 *  rescaled: it is 12 dB below `osc/saw` on purpose, so that seven of them sum
 *  to ±0.875 in `osc/supersaw`. */
const NAIVE_SAW_AMPLITUDE = 0.125;

/** `pulse/lfsrburst 8` is an 8-bit register, so a burst is `2^8 − 1` samples. */
const LFSR_BURST_LENGTH = 255;

/** `osc/saw`'s and `osc/square`'s output swing: their steady state is ±2^26 in
 *  q27, i.e. half full scale. */
const BLEP_OSC_AMPLITUDE = 0.5;

// ── PURE HELPERS ────────────────────────────────────────────────────────────

/**
 * Pure function. Axoloti pitch (semitones, 0 = MIDI 64 = E4) to hertz.
 *
 * This IS `axoloti_math_init`'s table generator, `440·2^((i − 69 − 64)/12)`,
 * with `i` re-expressed as a pitch rather than a table index.
 *
 * @param {number} semitones - Axoloti pitch; 0 is E4
 * @returns {number} frequency in hertz
 *
 * @example Math.round(axoPitchToHz(0) * 1e4) / 1e4 // 329.6276
 * @example Math.round(axoPitchToHz(5)) // 440
 * @example Math.round(axoPitchToHz(12) * 1e4) / 1e4 // 659.2551
 */
export function axoPitchToHz(semitones) {
  return A4_HZ * 2 ** ((semitones + AXOLOTI_PITCH_ZERO_MIDI - A4_MIDI) / SEMITONES_PER_OCTAVE);
}

/**
 * Pure function. Their `pitcht`, in cycles per sample instead of 2^32 units.
 *
 * `axoloti_math_init` stores `phi = 2^32·f/SAMPLERATE`, clamped to `0x7FFFFFFF`.
 * Dividing that by 2^32 gives cycles per sample, which is what a float phase
 * accumulator in [0,1) wants — and makes the clamp read as what it is, Nyquist.
 *
 * @param {number} sampleRate - the running sample rate (deviation D1)
 * @returns {Float64Array} 257 increments, index 128 being pitch 0
 *
 * @example buildIncrementTable(48000).length // 257
 * @example // pitch 0 is 329.6276 Hz, so 329.6276/48000 cycles per sample
 * @example Math.round(buildIncrementTable(48000)[128] * 1e8) / 1e8 // 0.00686724
 * @example // and everything at or above Nyquist saturates at the same value
 * @example buildIncrementTable(48000)[256] === MAX_INCREMENT // true
 */
export function buildIncrementTable(sampleRate) {
  const table = new Float64Array(PITCH_TABLE_SIZE);
  for (let i = 0; i < PITCH_TABLE_SIZE; i++) {
    const hz = axoPitchToHz(i - PITCH_TABLE_ZERO);
    table[i] = Math.min(hz / sampleRate, MAX_INCREMENT);
  }
  return table;
}

/**
 * Pure function. `MTOF` / `MTOFEXTENDED`: pitch to phase increment, through the
 * PIECEWISE-LINEAR table (deviation D2 — the ≤0.72 cent error is kept).
 *
 * @param {number} semitones - pitch, already summed from param + inlet
 * @param {Float64Array} table - from buildIncrementTable
 * @param {number} clampSemitones - MTOF_CLAMP_SEMITONES or MTOF_EXT_CLAMP_SEMITONES
 * @returns {number} cycles per sample
 *
 * @example const t = buildIncrementTable(48000);
 * @example // whole semitones hit table entries exactly, so no interpolation error
 * @example mtofIncrement(0, t, 128) === t[128] // true
 * @example // and the clamp is theirs: __SSAT saturates one raw step below +64
 * @example mtofIncrement(999, t, 64) === mtofIncrement(64 - 1 / 2 ** 21, t, 64) // true
 */
export function mtofIncrement(semitones, table, clampSemitones) {
  const p = Math.min(clampSemitones - SEMITONE_STEP, Math.max(-clampSemitones, semitones));
  const whole = Math.floor(p);
  const frac = p - whole;
  const lo = table[whole + PITCH_TABLE_ZERO];
  const hi = table[whole + PITCH_TABLE_ZERO + 1];
  return lo + (hi - lo) * frac;
}

/**
 * Pure function. One step of the LCG `noise/pink` and `noise/gaussian` use.
 *
 * `Math.imul` is not an optimisation here, it is the SEMANTICS: the C is a
 * 32-bit unsigned multiply that wraps, and a plain `*` in JS would go through
 * a double and lose the low bits that are the whole output.
 *
 * @param {number} state - uint32
 * @returns {number} the next state, uint32
 *
 * @example lcgNext(0) // 907633515
 * @example lcgNext(1) >>> 0 // 1103947680
 * @example // it really is 32-bit-wrapping, so it never leaves uint32
 * @example lcgNext(0xffffffff) < 2 ** 32 // true
 */
export function lcgNext(state) {
  return (Math.imul(state, LCG_MULTIPLIER) + LCG_INCREMENT) >>> 0;
}

/**
 * Pure function. An LCG state as the bipolar real their `(int32_t)seed >> 4`
 * denotes: q27, so `real = (int32)state / 2^31`, in [−1, 1).
 *
 * @param {number} state - uint32
 * @returns {number} in [−1, 1)
 *
 * @example lcgReal(0) // 0
 * @example lcgReal(2 ** 31) // -1
 * @example Math.abs(lcgReal(0x40000000) - 0.5) < 1e-12 // true
 */
export function lcgReal(state) {
  return (state | 0) / INT32_SCALE;
}

/**
 * Pure function. A uint32 phase read as their `int32_t` — the sign convention
 * `osc/saw medium`, `osc/supersaw` and `lfo/square` all branch on.
 *
 * @param {number} phase - normalised phase in [0, 1)
 * @returns {number} in [−0.5, 0.5)
 *
 * @example signedPhase(0.25) // 0.25
 * @example signedPhase(0.75) // -0.25
 * @example signedPhase(0) // 0
 */
export function signedPhase(phase) {
  return phase < 0.5 ? phase : phase - 1;
}

/**
 * Pure function. `x mod 1` into [0, 1) — the float spelling of uint32 wraparound.
 *
 * @param {number} x - any finite number
 * @returns {number} in [0, 1)
 *
 * @example wrap1(1.25) // 0.25
 * @example wrap1(-0.25) // 0.75
 * @example wrap1(0.5) // 0.5
 */
export function wrap1(x) {
  const r = x % 1;
  return r < 0 ? r + 1 : r;
}

// ── THE minBLEP TABLE ───────────────────────────────────────────────────────

/**
 * `blept`, verbatim from firmware `axoloti_oscs.c:23` — 2048 int16 samples of a
 * minimum-phase band-limited STEP, credited there to Eli Brandt's hardsync work
 * (`http://www.cs.cmu.edu/~eli/tmp/hardsync/hardsync.zip`).
 *
 * READ IT AS A UNIT STEP: it starts at ~0, overshoots to 19889 and settles at
 * BLEP_UNITY (16384), so `1 − blept[t]/16384` is a correction that starts at 1,
 * rings, and reaches exactly 0 — which is why a settled voice costs nothing.
 *
 * ⚠ THIS IS NOT `blt`. `objects/osc/bltable.h` holds a DIFFERENT table (a
 * band-limited TRIANGLE, `cumsum(minblep−1)`) used only by `osc/tri`, which is
 * not an AX-2 row. Two tables, two mechanisms, same folder; assuming the symbol
 * is shared is how a port ends up integrating a step twice.
 */
const BLEP_TABLE = Int16Array.from([
  -1, -1, -1, -1, -1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 2, 2, 2, 3, 3, 4,
  4, 5, 5, 6, 7, 8, 8, 9, 11, 12, 13, 14, 16, 18, 19, 21,
  23, 26, 28, 31, 34, 37, 40, 43, 47, 51, 56, 60, 65, 71, 76, 82,
  89, 96, 103, 111, 119, 128, 137, 147, 157, 168, 180, 192, 205, 219, 233, 248,
  264, 281, 299, 317, 337, 357, 378, 401, 425, 449, 475, 502, 530, 560, 590, 623,
  656, 691, 727, 765, 805, 846, 888, 932, 978, 1026, 1075, 1127, 1180, 1235, 1292, 1351,
  1412, 1475, 1540, 1607, 1677, 1749, 1823, 1899, 1977, 2058, 2141, 2227, 2315, 2406, 2499, 2594,
  2692, 2793, 2896, 3002, 3111, 3222, 3336, 3452, 3571, 3693, 3817, 3944, 4074, 4207, 4342, 4480,
  4620, 4763, 4909, 5057, 5208, 5362, 5518, 5676, 5838, 6001, 6167, 6335, 6506, 6679, 6854, 7031,
  7211, 7392, 7576, 7762, 7949, 8138, 8329, 8522, 8716, 8911, 9108, 9307, 9506, 9707, 9909, 10112,
  10315, 10520, 10725, 10930, 11136, 11342, 11549, 11755, 11962, 12168, 12374, 12580, 12785, 12990, 13194, 13397,
  13598, 13799, 13999, 14197, 14393, 14588, 14781, 14973, 15162, 15349, 15533, 15716, 15896, 16073, 16247, 16419,
  16587, 16752, 16914, 17073, 17228, 17380, 17528, 17672, 17812, 17949, 18081, 18209, 18333, 18452, 18567, 18678,
  18784, 18886, 18982, 19075, 19162, 19244, 19322, 19395, 19463, 19525, 19583, 19636, 19684, 19727, 19764, 19797,
  19825, 19848, 19866, 19878, 19886, 19889, 19888, 19881, 19870, 19854, 19833, 19808, 19778, 19744, 19706, 19664,
  19617, 19566, 19512, 19453, 19391, 19325, 19256, 19184, 19108, 19029, 18948, 18863, 18776, 18686, 18594, 18500,
  18403, 18305, 18205, 18103, 18000, 17896, 17790, 17684, 17577, 17469, 17360, 17252, 17143, 17034, 16926, 16818,
  16710, 16603, 16497, 16391, 16287, 16184, 16083, 15983, 15885, 15789, 15694, 15602, 15512, 15425, 15340, 15257,
  15177, 15100, 15026, 14955, 14887, 14823, 14761, 14703, 14648, 14597, 14549, 14505, 14464, 14428, 14394, 14365,
  14339, 14317, 14299, 14284, 14274, 14267, 14263, 14264, 14268, 14276, 14287, 14302, 14321, 14343, 14368, 14396,
  14428, 14463, 14501, 14543, 14586, 14633, 14683, 14735, 14789, 14846, 14906, 14967, 15030, 15095, 15162, 15231,
  15301, 15372, 15445, 15519, 15594, 15669, 15745, 15822, 15899, 15976, 16053, 16131, 16208, 16285, 16361, 16437,
  16512, 16586, 16659, 16731, 16802, 16871, 16939, 17005, 17070, 17132, 17193, 17252, 17309, 17363, 17415, 17465,
  17513, 17557, 17600, 17639, 17676, 17710, 17741, 17770, 17795, 17818, 17837, 17854, 17868, 17879, 17887, 17891,
  17893, 17892, 17888, 17881, 17872, 17859, 17844, 17826, 17805, 17781, 17755, 17727, 17696, 17663, 17627, 17590,
  17550, 17508, 17465, 17419, 17372, 17323, 17273, 17221, 17168, 17114, 17059, 17003, 16946, 16888, 16830, 16772,
  16713, 16653, 16594, 16535, 16475, 16416, 16358, 16300, 16242, 16185, 16129, 16074, 16020, 15967, 15915, 15865,
  15816, 15769, 15723, 15678, 15636, 15595, 15557, 15520, 15485, 15452, 15422, 15393, 15367, 15343, 15322, 15303,
  15286, 15271, 15259, 15250, 15242, 15237, 15235, 15235, 15237, 15242, 15249, 15258, 15270, 15283, 15299, 15317,
  15338, 15360, 15384, 15410, 15438, 15468, 15499, 15533, 15567, 15603, 15641, 15680, 15720, 15761, 15803, 15846,
  15890, 15935, 15980, 16026, 16072, 16119, 16166, 16213, 16260, 16307, 16353, 16400, 16446, 16492, 16537, 16582,
  16626, 16669, 16711, 16752, 16792, 16832, 16869, 16906, 16941, 16975, 17007, 17038, 17067, 17094, 17120, 17144,
  17166, 17186, 17205, 17221, 17236, 17249, 17260, 17269, 17275, 17280, 17283, 17284, 17284, 17281, 17276, 17269,
  17261, 17250, 17238, 17224, 17209, 17191, 17172, 17152, 17130, 17106, 17081, 17055, 17027, 16998, 16968, 16937,
  16905, 16872, 16838, 16804, 16769, 16733, 16696, 16660, 16622, 16585, 16547, 16509, 16472, 16434, 16396, 16359,
  16322, 16285, 16249, 16213, 16178, 16144, 16110, 16077, 16045, 16014, 15984, 15955, 15927, 15901, 15876, 15852,
  15829, 15807, 15787, 15769, 15752, 15736, 15722, 15710, 15699, 15690, 15682, 15676, 15672, 15669, 15668, 15668,
  15670, 15673, 15678, 15685, 15693, 15703, 15714, 15726, 15740, 15755, 15771, 15789, 15808, 15828, 15849, 15871,
  15895, 15919, 15944, 15970, 15996, 16023, 16051, 16080, 16109, 16138, 16168, 16198, 16228, 16258, 16289, 16319,
  16350, 16380, 16410, 16440, 16469, 16498, 16527, 16555, 16583, 16609, 16636, 16661, 16686, 16710, 16733, 16755,
  16776, 16796, 16815, 16832, 16849, 16865, 16879, 16892, 16904, 16915, 16924, 16932, 16939, 16944, 16949, 16951,
  16953, 16953, 16952, 16950, 16946, 16942, 16935, 16928, 16920, 16910, 16899, 16888, 16875, 16861, 16846, 16830,
  16813, 16796, 16777, 16758, 16738, 16717, 16696, 16674, 16652, 16629, 16606, 16583, 16559, 16535, 16510, 16486,
  16462, 16437, 16413, 16389, 16365, 16341, 16317, 16294, 16271, 16248, 16226, 16205, 16184, 16163, 16143, 16124,
  16106, 16088, 16072, 16056, 16041, 16026, 16013, 16001, 15989, 15979, 15970, 15961, 15954, 15948, 15942, 15938,
  15935, 15933, 15932, 15932, 15933, 15935, 15938, 15942, 15947, 15953, 15960, 15968, 15977, 15987, 15997, 16009,
  16021, 16034, 16047, 16062, 16076, 16092, 16108, 16125, 16142, 16159, 16177, 16195, 16214, 16233, 16252, 16271,
  16290, 16310, 16329, 16348, 16368, 16387, 16406, 16425, 16444, 16462, 16480, 16498, 16515, 16532, 16548, 16564,
  16580, 16594, 16609, 16622, 16635, 16647, 16659, 16670, 16680, 16689, 16697, 16705, 16712, 16718, 16723, 16728,
  16731, 16734, 16736, 16737, 16737, 16737, 16736, 16733, 16730, 16727, 16722, 16717, 16711, 16704, 16696, 16688,
  16679, 16670, 16660, 16649, 16638, 16627, 16615, 16602, 16589, 16576, 16562, 16548, 16534, 16519, 16504, 16489,
  16474, 16459, 16444, 16429, 16414, 16398, 16383, 16368, 16354, 16339, 16324, 16310, 16296, 16283, 16270, 16257,
  16244, 16232, 16221, 16210, 16199, 16189, 16179, 16170, 16162, 16154, 16147, 16140, 16134, 16129, 16124, 16120,
  16117, 16114, 16112, 16110, 16110, 16109, 16110, 16111, 16113, 16115, 16118, 16122, 16126, 16131, 16136, 16142,
  16149, 16155, 16163, 16171, 16179, 16188, 16197, 16206, 16216, 16226, 16236, 16247, 16258, 16269, 16280, 16292,
  16303, 16315, 16327, 16338, 16350, 16362, 16374, 16385, 16397, 16408, 16419, 16430, 16441, 16452, 16462, 16472,
  16482, 16492, 16501, 16510, 16518, 16526, 16534, 16541, 16547, 16554, 16560, 16565, 16570, 16574, 16578, 16582,
  16585, 16587, 16589, 16590, 16591, 16592, 16591, 16591, 16590, 16588, 16586, 16584, 16581, 16577, 16573, 16569,
  16564, 16559, 16554, 16548, 16542, 16536, 16529, 16522, 16514, 16507, 16499, 16491, 16483, 16474, 16466, 16457,
  16449, 16440, 16431, 16422, 16413, 16404, 16395, 16387, 16378, 16369, 16361, 16352, 16344, 16336, 16328, 16320,
  16313, 16306, 16299, 16292, 16285, 16279, 16273, 16268, 16263, 16258, 16253, 16249, 16245, 16242, 16239, 16236,
  16234, 16232, 16231, 16229, 16229, 16228, 16228, 16229, 16229, 16230, 16232, 16234, 16236, 16238, 16241, 16244,
  16248, 16251, 16255, 16260, 16264, 16269, 16274, 16279, 16285, 16290, 16296, 16302, 16308, 16314, 16321, 16327,
  16333, 16340, 16347, 16353, 16360, 16366, 16373, 16379, 16386, 16392, 16399, 16405, 16411, 16417, 16423, 16429,
  16434, 16439, 16445, 16450, 16454, 16459, 16463, 16467, 16471, 16475, 16478, 16481, 16484, 16486, 16489, 16491,
  16492, 16494, 16495, 16496, 16496, 16496, 16496, 16496, 16496, 16495, 16494, 16492, 16491, 16489, 16487, 16484,
  16482, 16479, 16476, 16473, 16470, 16466, 16463, 16459, 16455, 16451, 16446, 16442, 16438, 16433, 16429, 16424,
  16419, 16415, 16410, 16405, 16400, 16395, 16391, 16386, 16381, 16377, 16372, 16368, 16363, 16359, 16355, 16351,
  16347, 16343, 16339, 16336, 16332, 16329, 16326, 16323, 16320, 16318, 16316, 16313, 16311, 16310, 16308, 16307,
  16306, 16305, 16304, 16304, 16303, 16303, 16303, 16303, 16304, 16305, 16305, 16306, 16308, 16309, 16311, 16312,
  16314, 16316, 16318, 16321, 16323, 16326, 16328, 16331, 16334, 16337, 16340, 16343, 16346, 16349, 16353, 16356,
  16359, 16363, 16366, 16369, 16373, 16376, 16379, 16383, 16386, 16389, 16392, 16396, 16399, 16402, 16404, 16407,
  16410, 16413, 16415, 16418, 16420, 16422, 16424, 16426, 16428, 16430, 16431, 16432, 16434, 16435, 16436, 16437,
  16437, 16438, 16438, 16439, 16439, 16439, 16439, 16438, 16438, 16437, 16437, 16436, 16435, 16434, 16433, 16431,
  16430, 16429, 16427, 16425, 16424, 16422, 16420, 16418, 16416, 16414, 16412, 16410, 16407, 16405, 16403, 16401,
  16398, 16396, 16394, 16391, 16389, 16387, 16384, 16382, 16380, 16378, 16376, 16374, 16372, 16370, 16368, 16366,
  16364, 16362, 16361, 16359, 16358, 16356, 16355, 16354, 16353, 16352, 16351, 16350, 16349, 16348, 16348, 16347,
  16347, 16347, 16347, 16346, 16347, 16347, 16347, 16347, 16348, 16348, 16349, 16349, 16350, 16351, 16352, 16353,
  16354, 16355, 16356, 16357, 16358, 16359, 16361, 16362, 16364, 16365, 16367, 16368, 16370, 16371, 16373, 16374,
  16376, 16377, 16379, 16380, 16382, 16383, 16385, 16386, 16388, 16389, 16391, 16392, 16393, 16394, 16396, 16397,
  16398, 16399, 16400, 16401, 16402, 16403, 16404, 16404, 16405, 16405, 16406, 16406, 16407, 16407, 16407, 16408,
  16408, 16408, 16408, 16408, 16408, 16407, 16407, 16407, 16407, 16406, 16406, 16405, 16405, 16404, 16403, 16403,
  16402, 16401, 16400, 16399, 16399, 16398, 16397, 16396, 16395, 16394, 16393, 16392, 16391, 16390, 16389, 16388,
  16387, 16386, 16385, 16384, 16383, 16382, 16381, 16380, 16379, 16378, 16377, 16376, 16376, 16375, 16374, 16373,
  16373, 16372, 16372, 16371, 16371, 16370, 16370, 16369, 16369, 16369, 16368, 16368, 16368, 16368, 16368, 16368,
  16368, 16368, 16368, 16368, 16368, 16368, 16369, 16369, 16369, 16370, 16370, 16370, 16371, 16371, 16372, 16372,
  16373, 16373, 16374, 16374, 16375, 16376, 16376, 16377, 16378, 16378, 16379, 16380, 16380, 16381, 16382, 16382,
  16383, 16383, 16384, 16385, 16385, 16386, 16386, 16387, 16388, 16388, 16389, 16389, 16390, 16390, 16390, 16391,
  16391, 16391, 16392, 16392, 16392, 16393, 16393, 16393, 16393, 16393, 16393, 16393, 16393, 16393, 16393, 16393,
  16393, 16393, 16393, 16393, 16393, 16393, 16392, 16392, 16392, 16392, 16391, 16391, 16391, 16390, 16390, 16390,
  16389, 16389, 16389, 16388, 16388, 16387, 16387, 16387, 16386, 16386, 16385, 16385, 16384, 16384, 16384, 16383,
  16383, 16382, 16382, 16382, 16381, 16381, 16381, 16380, 16380, 16380, 16380, 16379, 16379, 16379, 16379, 16378,
  16378, 16378, 16378, 16378, 16378, 16378, 16377, 16377, 16377, 16377, 16377, 16377, 16377, 16377, 16378, 16378,
  16378, 16378, 16378, 16378, 16378, 16378, 16379, 16379, 16379, 16379, 16379, 16379, 16380, 16380, 16380, 16380,
  16381, 16381, 16381, 16381, 16382, 16382, 16382, 16382, 16383, 16383, 16383, 16383, 16384, 16384, 16384, 16384,
  16385, 16385, 16385, 16385, 16385, 16386, 16386, 16386, 16386, 16386, 16386, 16387, 16387, 16387, 16387, 16387,
  16387, 16387, 16387, 16387, 16387, 16387, 16387, 16387, 16387, 16387, 16387, 16387, 16387, 16387, 16387, 16387,
  16387, 16387, 16387, 16386, 16386, 16386, 16386, 16386, 16386, 16386, 16386, 16385, 16385, 16385, 16385, 16385,
  16385, 16384, 16384, 16384, 16384, 16384, 16384, 16384, 16383, 16383, 16383, 16383, 16383, 16383, 16383, 16382,
  16382, 16382, 16382, 16382, 16382, 16382, 16382, 16382, 16382, 16382, 16382, 16381, 16381, 16381, 16381, 16381,
  16381, 16381, 16381, 16381, 16381, 16381, 16381, 16381, 16381, 16381, 16382, 16382, 16382, 16382, 16382, 16382,
  16382, 16382, 16382, 16382, 16382, 16382, 16382, 16382, 16383, 16383, 16383, 16383, 16383, 16383, 16383, 16383,
  16383, 16383, 16383, 16384, 16384, 16384, 16384, 16384, 16384, 16384, 16384, 16384, 16384, 16384, 16384, 16384,
  16384, 16384, 16385, 16385, 16385, 16385, 16385, 16385, 16385, 16385, 16385, 16385, 16385, 16385, 16385, 16385,
  16385, 16385, 16385, 16385, 16385, 16385, 16385, 16385, 16385, 16384, 16384, 16384, 16384, 16384, 16384, 16384,
  16384, 16384, 16384, 16384, 16384, 16384, 16384, 16384, 16384, 16384, 16384, 16384, 16384, 16383, 16383, 16383,
  16383, 16383, 16383, 16383, 16383, 16383, 16383, 16383, 16383, 16383, 16383, 16383, 16383, 16383, 16383, 16383,
  16383, 16383, 16383, 16383, 16383, 16383, 16383, 16383, 16383, 16383, 16383, 16383, 16383, 16383, 16383, 16383,
  16383, 16383, 16383, 16383, 16383, 16383, 16383, 16383, 16383, 16383, 16383, 16383, 16383, 16383, 16383, 16383,
  16383, 16383, 16383, 16383, 16383, 16383, 16384, 16384, 16384, 16384, 16384, 16384, 16384, 16384, 16384, 16384,
  16384, 16384, 16384, 16384, 16384, 16384, 16384, 16384, 16384, 16384, 16384, 16384, 16384, 16384, 16384, 16384,
  16384, 16384, 16384, 16384, 16384, 16384, 16384, 16384, 16384, 16384, 16384, 16384, 16384, 16384, 16384, 16384,
  16384, 16384, 16384, 16384, 16384, 16384, 16384, 16384, 16384, 16384, 16384, 16384, 16384, 16383, 16383, 16383,
  16383, 16383, 16383, 16383, 16383, 16383, 16383, 16383, 16383, 16383, 16383, 16383, 16383, 16383, 16383, 16383,
  16383, 16383, 16383, 16383, 16383, 16383, 16383, 16383, 16383, 16383, 16383, 16383, 16383, 16383, 16383, 16383,
  16383, 16383, 16383, 16383, 16383, 16383, 16383, 16383, 16383, 16383, 16383, 16383, 16383, 16383, 16383, 16383,
  16384, 16384, 16384, 16384, 16384, 16384, 16384, 16384, 16384, 16384, 16384, 16384, 16384, 16384, 16384, 16384,
  16384, 16384, 16384, 16384, 16384, 16384, 16384, 16384, 16384, 16384, 16384, 16384, 16384, 16384, 16384, 16384,
  16384, 16384, 16384, 16384, 16384, 16384, 16384, 16384, 16384, 16384, 16384, 16384, 16384, 16384, 16384, 16384,
  16383, 16383, 16383, 16383, 16383, 16383, 16383, 16383, 16383, 16383, 16383, 16383, 16383, 16383, 16383, 16383,
  16383, 16383, 16383, 16383, 16383, 16383, 16383, 16383, 16383, 16383, 16383, 16383, 16383, 16383, 16383, 16383,
  16383, 16383, 16383, 16383, 16383, 16383, 16383, 16383, 16383, 16383, 16383, 16384, 16384, 16384, 16384, 16384,
  16384, 16384, 16384, 16384, 16384, 16384, 16384, 16384, 16384, 16384, 16384, 16384, 16384, 16384, 16384, 16384,
  16384, 16384, 16384, 16384, 16384, 16384, 16384, 16384, 16384, 16384, 16384, 16384, 16384, 16384, 16383, 16383,
  16383, 16383, 16383, 16383, 16383, 16383, 16383, 16383, 16383, 16383, 16383, 16383, 16383, 16383, 16384, 16384,
  16384, 16384, 16384, 16384, 16384, 16384, 16384, 16384, 16384, 16384, 16384, 16384, 16384, 16384, 16384, 16384
]);

/** Last legal index, and where a settled voice's pointer is pinned. */
const BLEP_LAST = BLEP_TABLE.length - 1;

/**
 * Pure function. The band-limited step's residual at table index `t`: 1 at the
 * discontinuity, 0 once the step has settled.
 *
 * @param {number} t - table index, 0..2047
 * @returns {number} the correction to ADD to a naive waveform, in [−0.22, 1]
 *
 * @example blepResidual(2047) // 0
 * @example blepResidual(0) > 0.99 // true
 * @example // it overshoots, which is the ringing a band-limited step must have
 * @example blepResidual(500) < 0 // true
 */
export function blepResidual(t) {
  return 1 - BLEP_TABLE[t] / BLEP_UNITY;
}

// ── THE VOICE BANK EVERY BLEP OSCILLATOR SHARES ─────────────────────────────

/**
 * `osc/saw`, `osc/square` and `osc/pwm` all declare the same three lines of
 * state — `int16_t *oscp[blepvoices]; uint32_t nextvoice;` plus the sampling
 * loop — and differ only in how they SIGN the voices' contributions. That
 * common part is here once.
 *
 * A voice is a POINTER into `blept`. Dispatching a transition parks a pointer
 * `x = 64·u` entries in, where `u` is how far into the current sample the
 * discontinuity fell; every sample each pointer advances 64 entries (one
 * sample) and pins at the end, where its residual is exactly 0.
 *
 * Command (every method advances kernel state). Allocation-free after
 * construction.
 */
class BlepVoiceBank {
  /**
   * @param {number} voices - 4 (saw) or 8 (square, pwm); MUST be a power of two,
   *   because their round-robin is `(nextvoice+1) & (blepvoices-1)`
   */
  constructor(voices) {
    this.index = new Int32Array(voices).fill(BLEP_LAST);
    this.mask = voices - 1;
    this.next = 0;
    this.voices = voices;
  }

  /** Command. Park a fresh band-limited step, `u` of a sample into the past. */
  dispatch(u) {
    this.next = (this.next + 1) & this.mask;
    const at = (u * BLEP_SUBSAMPLES) | 0;
    this.index[this.next] = at < 0 ? 0 : (at > BLEP_LAST ? BLEP_LAST : at);
  }

  /** Query. Σ of every voice's step value, normalised so a settled voice is 1. */
  sum() {
    let total = 0;
    for (let i = 0; i < this.voices; i++) total += BLEP_TABLE[this.index[i]];
    return total / BLEP_UNITY;
  }

  /** Query. Σ with the voice-slot parity sign `if (i&1) sum+=*t; else sum-=*t;`,
   *  which is what makes consecutive dispatches alternate up-step and down-step. */
  alternatingSum() {
    let total = 0;
    for (let i = 0; i < this.voices; i++) {
      total += (i & 1) ? BLEP_TABLE[this.index[i]] : -BLEP_TABLE[this.index[i]];
    }
    return total / BLEP_UNITY;
  }

  /** Command. `t += 64; if (t>=lastblep) t=lastblep;` for every voice. */
  advance() {
    for (let i = 0; i < this.voices; i++) {
      const t = this.index[i] + BLEP_SUBSAMPLES;
      this.index[i] = t >= BLEP_LAST ? BLEP_LAST : t;
    }
  }
}

/**
 * Pure function. Their BLEP dispatch test `(osc_p > 0) && !(p > 0)`, transcribed
 * literally: a signed int32 phase that is positive NOW and was not before.
 *
 * ── WHY NOT JUST "THE PHASE WRAPPED" ────────────────────────────────────────
 * Two behaviours ride on the `> 0` being strict, and both were measured against
 * the integer model rather than reasoned about:
 *
 *   1. A register sitting at EXACTLY zero — where `code.init` leaves it —
 *      dispatches on its first sample, band-limiting the turn-on step. Without
 *      that, sample 0 differed from the C by 1.0 FULL SCALE: a click per note,
 *      and it raised the saw's measured alias floor from −81 dB to −58 dB.
 *   2. A phase that LANDS on exactly zero (any frequency dividing the sample
 *      rate — 3000 Hz at 48 kHz, say) does NOT dispatch on the landing sample;
 *      it dispatches on the next one. Treating the wrap itself as the event
 *      dispatched twice per cycle there, worth a full 1.0 of error.
 *
 * @param {number} previous - phase before the increment, in [0, 1)
 * @param {number} phase - phase after it, wrapped into [0, 1)
 * @returns {boolean} whether a band-limited step must be dispatched
 *
 * @example blepCrossedZero(0.98, 0.03) // true   — an ordinary wrap
 * @example blepCrossedZero(0, 0.0625) // true    — leaving the init value
 * @example blepCrossedZero(0.9375, 0) // false   — landing exactly on zero
 * @example blepCrossedZero(0.2, 0.3) // false    — mid-cycle
 */
export function blepCrossedZero(previous, phase) {
  return signedPhase(phase) > 0 && !(signedPhase(previous) > 0);
}

// ── THE SEEDED SOURCES (deviation D4) ───────────────────────────────────────

/**
 * `noise/uniform` (`code.srate`) and `rand/uniform f` (`code.krate`), both
 * `(int32_t)(GenerateRandomNumber())>>4`.
 *
 *     s_{n+1} = (196314165·s_n + 907633515) mod 2^32
 *     out_n   = int32(s_{n+1}) / 2^31            ∈ [−1, 1)
 *
 * Command (advances the LCG). D4: their `GenerateRandomNumber` reads the STM32
 * RNG; this is the pure LCG their own pink/gaussian objects use, seeded from the
 * node's `seed` knob.
 */
class UniformSource {
  constructor(seed) {
    this.state = seed >>> 0;
  }

  next() {
    this.state = lcgNext(this.state);
    return lcgReal(this.state);
  }
}

/**
 * `noise/pink` (`code.srate`) and `rand/pink` / `rand/pink oct` (`code.krate`) —
 * byte-identical `code.declaration` in all three, a Voss-McCartney dyadic tree.
 *
 *     o = tree[i]; i = (o == octaves) ? 0 : i+1
 *     if (o != octaves): sum += (draw() − buf[o])/(octaves+1); buf[o] = draw()/(octaves+1)
 *     out = sum + draw()/(octaves+1)
 *
 * The `1/(octaves+1)` is deviation D5: theirs is a fixed `>>7` on the octave
 * buffers and `>>attr_octaves` on the white term, which agree only at
 * octaves = 7 and overflow full scale below it.
 *
 * Command (advances the LCG and the tree cursor).
 */
class PinkSource {
  constructor(seed, octaves) {
    this.state = (PINK_SEED + seed) >>> 0;
    this.octaves = octaves;
    this.scale = 1 / (octaves + 1);
    this.buffers = new Float64Array(PINK_MAX_OCTAVES);
    this.sum = 0;
    this.cursor = 0;
  }

  next() {
    const octave = PINK_DYADIC_TREE[this.cursor];
    this.cursor++;
    if (octave >= this.octaves) {
      this.cursor = 0;
    } else {
      this.sum -= this.buffers[octave];
      this.state = lcgNext(this.state);
      this.buffers[octave] = lcgReal(this.state) * this.scale;
      this.sum += this.buffers[octave];
    }
    this.state = lcgNext(this.state);
    return this.sum + lcgReal(this.state) * this.scale;
  }
}

/**
 * `noise/gaussian` (`code.srate`): eight independent LCG streams summed, each
 * scaled by 1/8, so the sum is Irwin–Hall n = 8 over [−1, 1) — bell-shaped, and
 * exactly ±1.0 only when all eight agree.
 *
 *     out = Σ_{k=0..7} int32(s_k) / 2^34
 *
 * Command (advances eight LCGs).
 */
class GaussianSource {
  constructor(seed) {
    this.states = new Uint32Array(GAUSSIAN_STREAMS);
    for (let i = 0; i < GAUSSIAN_STREAMS; i++) this.states[i] = (GAUSSIAN_SEEDS[i] + seed) >>> 0;
  }

  next() {
    let total = 0;
    for (let i = 0; i < GAUSSIAN_STREAMS; i++) {
      this.states[i] = lcgNext(this.states[i]);
      total += lcgReal(this.states[i]);
    }
    return total / GAUSSIAN_STREAMS;
  }
}

/** The three `noise/*` colours, in the order their spec's `options` lists them.
 *  core/audio_specs_ax2.js RESTATES this list (core may not import synth/**) and
 *  tests/port_ax2_test.js pins the two against each other. */
export const NOISE_COLOURS = ["uniform", "pink", "gaussian"];

/**
 * Pure function. The seeded source one of NOISE_COLOURS names.
 *
 * @param {string} colour - one of NOISE_COLOURS
 * @param {number} seed - the node's seed knob; 0 reproduces their `code.init`
 * @param {number} octaves - pink only; PINK_MAX_OCTAVES for `noise/pink`
 * @returns {{next: function(): number}}
 *
 * @example noiseSource("uniform", 0).next() // 0.42266563326120377
 * @example Math.abs(noiseSource("gaussian", 0).next()) < 1 // true
 */
export function noiseSource(colour, seed, octaves) {
  if (colour === "uniform") return new UniformSource(seed);
  if (colour === "pink") return new PinkSource(seed, octaves);
  if (colour === "gaussian") return new GaussianSource(seed);
  throw new Error(`Unknown AX-2 noise colour ${JSON.stringify(colour)}; expected one of ${NOISE_COLOURS.join(", ")}`);
}

// ── THE KERNELS ─────────────────────────────────────────────────────────────

/** Radians per cycle — the one place `Math.sin` is fed a normalised phase. */
const TAU = Math.PI * 2;

/**
 * A rising-edge latch, `if (in>0 && !ntrig) {…; ntrig=1;} else if (!(in>0)) ntrig=0;`
 * — the idiom every triggered object in this block repeats verbatim.
 *
 * Command. Returns true on the tick the input first goes above zero.
 */
class RisingEdge {
  constructor() {
    this.armed = true;
  }

  fired(value) {
    if (value > 0) {
      if (!this.armed) return false;
      this.armed = false;
      return true;
    }
    this.armed = true;
    return false;
  }
}

/** `osc/basic`'s waveforms, in spec-`options` order. Their index IS the kernel's
 *  mode number, so the list and the switch cannot disagree. */
export const OSC_WAVEFORMS = ["sine", "saw", "sawMedium", "square", "pwm"];
const OSC_SINE = 0;
const OSC_SAW = 1;
const OSC_SAW_MEDIUM = 2;
const OSC_SQUARE = 3;
const OSC_PWM = 4;

/**
 * `osc/basic` — `objects/osc/{sine,saw,saw medium,square,pwm}.axo` (factory).
 *
 * ── WHICH CODE BLOCK ─────────────────────────────────────────────────────────
 *   sine        `code.krate` (MTOFEXTENDED) + `code.srate` (SINE2TINTERP)
 *   saw         `code.krate` ONLY — its BUFSIZE loop is inside the k-rate block
 *   saw medium  `code.krate` only, same shape
 *   square      `code.krate` only, same shape
 *   pwm         `code.krate` only, same shape
 * All five therefore mean the same thing: ONE `MTOFEXTENDED` per 16 samples.
 *
 * ── THE RECURRENCES, IN FLOAT ───────────────────────────────────────────────
 * With φ ∈ [0,1) the phase, `inc` the increment from `mtofIncrement`, and
 * `fm` the `freq` input in hertz:
 *
 *   every sample:  φ ← frac(φ + inc + fm/sampleRate)
 *
 *   sine        out = sin(2π·(φ + phase))
 *   saw         on a wrap, dispatch a step at u = φ/inc
 *               out = (φ − 0.5) + Σ_{i<4} (1 − blep_i)
 *   sawMedium   s = φ − [φ ≥ ½]        (their int32 reading of the register)
               ⚠ their `f0i` slope overflows at the Nyquist clamp — see D11
 *               on s crossing 0 downward, u = (s + ½)/inc and
 *                 out = ⅛·(1 − 2u)     (their one-sample ___SMMLS ramp)
 *               otherwise out = ¼·s     ⇒ ±⅛, i.e. 12 dB below `saw`, ON PURPOSE
 *   square      φ advances at 2·inc (their `freq<<1`); every wrap dispatches
 *               out = Σ_{i<8} sign(i)·blep_i ± ½, the sign set by slot parity
 *   pwm         as square but at inc, with TWO dispatch points per cycle: the
 *               wrap of φ (which also LATCHES w = (1 + pw)/2) and the wrap of
 *               φ − w. Their signed comparison picks which is tested first.
 *
 * ── DIVERGENCES ─────────────────────────────────────────────────────────────
 * D3 (sine is `Math.sin`, not their 4096-entry table), D7/D9 (`freq` is an FM
 * input in HERTZ on every waveform, where they offer it on `sine` alone),
 * D9 (`pitch` is in semitones, not frac32-where-1.0-is-64-semitones), and the
 * `phase` input applies to `sine` ONLY — a phase offset on a BLEP waveform would
 * displace the correction from the discontinuity it corrects, which is exactly
 * the aliasing the BLEP exists to remove.
 *
 * Command. `control` and `sample` both advance kernel state; neither allocates.
 */
export class OscKernel {
  constructor(sampleRate, options = {}) {
    this.sampleRate = sampleRate;
    this.table = buildIncrementTable(sampleRate);
    this.setWaveform(options.waveform ?? OSC_WAVEFORMS[0]);
    this.phase = 0;
    this.increment = 0;
    this.pulseWidth = 0.5;
    this.sawBank = new BlepVoiceBank(SAW_BLEP_VOICES);
    this.pulseBank = new BlepVoiceBank(PULSE_BLEP_VOICES);
    this.outputCount = 1;
  }

  /** Command. Select a waveform by NAME (the discrete knob's value). */
  setWaveform(name) {
    const mode = OSC_WAVEFORMS.indexOf(name);
    if (mode < 0) {
      throw new Error(`Unknown AX-2 oscillator waveform ${JSON.stringify(name)}; expected one of ${OSC_WAVEFORMS.join(", ")}`);
    }
    this.mode = mode;
  }

  control(c) {
    this.increment = mtofIncrement(c.pitch, this.table, MTOF_EXT_CLAMP_SEMITONES);
  }

  sample(c, out) {
    const inc = this.increment + c.freq / this.sampleRate;
    const previous = this.phase;
    const advanced = previous + (this.mode === OSC_SQUARE ? inc * 2 : inc);
    const phase = wrap1(advanced);
    this.phase = phase;

    switch (this.mode) {
      case OSC_SINE:
        out[0] = Math.sin(TAU * (phase + c.phase));
        return;

      case OSC_SAW: {
        if (blepCrossedZero(previous, phase) && inc > 0) this.sawBank.dispatch(phase / inc);
        out[0] = (phase - BLEP_OSC_AMPLITUDE) + (SAW_BLEP_VOICES - this.sawBank.sum());
        this.sawBank.advance();
        return;
      }

      case OSC_SAW_MEDIUM: {
        const signed = signedPhase(phase);
        const signedPrevious = signedPhase(previous);
        if (signed < 0 && signedPrevious > 0 && inc > 0) {
          out[0] = NAIVE_SAW_AMPLITUDE * (1 - 2 * ((signed + 0.5) / inc));
        } else {
          out[0] = NAIVE_SAW_AMPLITUDE * 2 * signed;
        }
        return;
      }

      case OSC_SQUARE: {
        if (blepCrossedZero(previous, phase) && inc > 0) this.pulseBank.dispatch(phase / (inc * 2));
        out[0] = this.pulseBank.alternatingSum()
          + ((this.pulseBank.next & 1) ? BLEP_OSC_AMPLITUDE : -BLEP_OSC_AMPLITUDE);
        this.pulseBank.advance();
        return;
      }

      case OSC_PWM: {
        // Their `if (osc_p >= osc_p - pwmp)` in SIGNED int32 — an ordering test
        // only (both branches run both dispatches), and it matters solely when
        // both edges land in one sample.
        const risingFirst = signedPhase(phase) >= signedPhase(wrap1(phase - this.pulseWidth));
        if (risingFirst) {
          this.pwmRising(c, previous, phase, inc);
          this.pwmFalling(previous, phase, inc);
        } else {
          this.pwmFalling(previous, phase, inc);
          this.pwmRising(c, previous, phase, inc);
        }
        out[0] = this.pulseBank.alternatingSum()
          + ((this.pulseBank.next & 1) ? BLEP_OSC_AMPLITUDE : -BLEP_OSC_AMPLITUDE);
        this.pulseBank.advance();
        return;
      }

      default:
        throw new Error(`AX-2 oscillator reached impossible mode ${this.mode}`);
    }
  }

  /** Command. The φ-wrap dispatch, which also LATCHES the pulse width — that
   *  latch is why a modulated `pw` steps once per cycle instead of smearing. */
  pwmRising(c, previous, phase, inc) {
    if (!blepCrossedZero(previous, phase) || inc <= 0) return;
    this.pulseBank.dispatch(phase / inc);
    this.pulseWidth = wrap1((1 + c.pw) / 2);
  }

  /** Command. The (φ − w) wrap dispatch, read with whatever width is latched now. */
  pwmFalling(previous, phase, inc) {
    if (inc <= 0) return;
    const offsetPhase = wrap1(phase - this.pulseWidth);
    if (!blepCrossedZero(wrap1(previous - this.pulseWidth), offsetPhase)) return;
    this.pulseBank.dispatch(offsetPhase / inc);
  }
}

/** `lfo/basic`'s waveforms, in spec-`options` order (D8: `sine lin` is absent). */
export const LFO_WAVEFORMS = ["sine", "saw", "square"];
const LFO_SINE = 0;
const LFO_SAW = 1;

/**
 * `lfo/basic` — `objects/lfo/{sine,sine r,saw,saw r,square}.axo` (factory).
 *
 * ── WHICH CODE BLOCK ─────────────────────────────────────────────────────────
 * `code.krate` in all five, and there is no `code.srate` anywhere: an LFO
 * produces ONE value per 16 samples and holds it. That stair-step at 3000 Hz is
 * part of the sound, so `sample()` here only reads what `control()` decided.
 *
 * ── THE RECURRENCE, IN FLOAT ────────────────────────────────────────────────
 *   inc = mtofIncrement(pitch) / 4          (their `Phase += freq>>2`)
 *   every CONTROL tick: φ ← frac(φ + inc)
 *
 * so the rate is `hz(pitch)/64` — the `/4` here and the 16 samples per tick are
 * the whole of that 64, and it is why `LFOPitchHz` in their Java editor divides
 * by 64 to label the dial.
 *
 *   sine    out = sin(2πφ)                bipolar ±1
 *   saw     out = φ                       UNIPOLAR 0…1 (their `frac32.positive`)
 *   square  out = signed(φ) > 0 ? 1 : 0   UNIPOLAR, high for the FIRST half
 *
 * The three ranges DIFFER and that is theirs, not an oversight: a patch that
 * sums an LFO into a pitch behaves differently per waveform on hardware too.
 *
 * ── THE RESET ASYMMETRY, WHICH IS REAL ──────────────────────────────────────
 * `saw r` and `square` put the phase increment inside the `else` of the reset
 * test, so the tick that resets does NOT advance. `sine r` keeps the increment
 * OUTSIDE, so it does. One control tick (333 µs) of difference, reproduced.
 *
 * ── DIVERGENCES ─────────────────────────────────────────────────────────────
 * D8 (`sine lin` omitted), D9 (`pitch` in semitones, `phase` in CYCLES rather
 * than their `inlet_phase<<4` half-cycle scaling), and `sync` — which only
 * `lfo/saw r` declares — is emitted for every waveform, since a phase wrap
 * exists in all three and an output that is inert in two of three modes would
 * be a port that lies.
 *
 * Command.
 */
export class LfoKernel {
  constructor(sampleRate, options = {}) {
    this.table = buildIncrementTable(sampleRate);
    this.setWaveform(options.waveform ?? LFO_WAVEFORMS[0]);
    this.phase = 0;
    this.previousPhase = 0;
    this.edge = new RisingEdge();
    this.wave = 0;
    this.sync = 0;
    this.outputCount = 2;
  }

  /** Command. Select a waveform by NAME (the discrete knob's value). */
  setWaveform(name) {
    const mode = LFO_WAVEFORMS.indexOf(name);
    if (mode < 0) {
      throw new Error(`Unknown AX-2 LFO waveform ${JSON.stringify(name)}; expected one of ${LFO_WAVEFORMS.join(", ")}`);
    }
    this.mode = mode;
  }

  control(c) {
    const previous = this.phase;
    const reset = this.edge.fired(c.reset);
    const increment = mtofIncrement(c.pitch, this.table, MTOF_EXT_CLAMP_SEMITONES) / LFO_INCREMENT_DIVISOR;
    if (reset) {
      this.phase = wrap1(c.phase);
      // `sine r` advances on the reset tick; `saw r` and `square` do not.
      if (this.mode === LFO_SINE) this.phase = wrap1(this.phase + increment);
    } else {
      this.phase = wrap1(previous + increment);
    }
    // `outlet_sync = (((int32_t)Phase)>=0)&&(pPhase<0)` — signed ≥ 0 from < 0 is
    // the UNSIGNED wrap, not the half-cycle mark. pPhase is stored every tick.
    this.sync = (signedPhase(this.phase) >= 0 && signedPhase(this.previousPhase) < 0) ? 1 : 0;
    this.previousPhase = this.phase;

    if (this.mode === LFO_SINE) this.wave = Math.sin(TAU * this.phase);
    else if (this.mode === LFO_SAW) this.wave = this.phase;
    else this.wave = signedPhase(this.phase) > 0 ? 1 : 0;
  }

  sample(c, out) {
    out[0] = this.wave;
    out[1] = this.sync;
  }
}

/**
 * `noise/gen` — `objects/noise/{uniform,pink,gaussian}.axo` (factory),
 * `code.srate` in all three. See UniformSource / PinkSource / GaussianSource for
 * each recurrence; this kernel is only the per-sample draw.
 *
 * `noise/pink` is fixed at 7 octaves (`static const int noct = 7`); the
 * configurable count belongs to `rand/pink oct` and lives on RandPinkKernel.
 *
 * Divergence: D4 (seeded).
 *
 * Command.
 */
export class NoiseKernel {
  constructor(sampleRate, options) {
    this.seed = options.seed;
    this.outputCount = 1;
    // Through the SETTER, not past it: one default, one code path, and a caller
    // who passes an option cannot have it silently ignored.
    this.setColour(options.colour ?? NOISE_COLOURS[0]);
  }

  /** Command. Rebuild the source — a colour change genuinely IS a new generator
   *  (the same reasoning `construct: true` records in core/audio_specs.js). */
  setColour(colour) {
    this.source = noiseSource(colour, this.seed, PINK_MAX_OCTAVES);
  }

  control(c) {}

  sample(c, out) {
    out[0] = this.source.next();
  }
}

/** `rand/uniform`'s two rates, in spec-`options` order. */
export const RAND_MODES = ["free", "trig"];

/**
 * `rand/uniform` — `objects/rand/{uniform f,uniform f trig,uniform i}.axo`
 * (factory), `code.krate` in all three.
 *
 *   free  every control tick:            out = draw()
 *   trig  on a rising `trig`:            out = draw(), else HOLD
 *
 * and `steps` selects between their two output TYPES:
 *
 *   steps = 0   `uniform f` / `uniform f trig`: frac32, out ∈ [−1, 1)
 *   steps ≥ 1   `uniform i`: `GenerateRandomNumber() % param_max`, an INTEGER
 *               0…steps−1, emitted through their int32→frac32 coercion (`<<21`,
 *               so `real = i/64`). steps ≤ 64 therefore stays inside ±1.
 *
 * Collapsing three objects into (rate × type) is not an invention: it is exactly
 * the three combinations they ship plus the fourth (free + integer) that falls
 * out for free, and it means no knob is inert in any mode.
 *
 * Divergences: D4 (seeded), D6 is not involved, D9 (`trig` is an ordinary
 * number input edge-detected exactly as their `bool32.rising` inlet is).
 *
 * Command.
 */
export class RandKernel {
  constructor(sampleRate, options) {
    this.source = new UniformSource(options.seed);
    this.edge = new RisingEdge();
    this.value = 0;
    this.outputCount = 1;
    this.setMode(options.mode ?? RAND_MODES[0]);
  }

  /** Command. Select free-running or triggered by NAME. */
  setMode(name) {
    if (!RAND_MODES.includes(name)) {
      throw new Error(`Unknown AX-2 random mode ${JSON.stringify(name)}; expected one of ${RAND_MODES.join(", ")}`);
    }
    this.free = name === "free";
  }

  control(c) {
    const fired = this.edge.fired(c.trig);
    if (!this.free && !fired) return;
    const steps = Math.floor(c.steps);
    if (steps < 1) {
      this.value = this.source.next();
      return;
    }
    this.source.next();
    this.value = (this.source.state % steps) * INT_TO_FRAC32;
  }

  sample(c, out) {
    out[0] = this.value;
  }
}

/**
 * `rand/pink` — `objects/rand/{pink,pink oct}.axo` (factory), `code.krate`.
 *
 * Byte-identical generator to `noise/pink` (see PinkSource) run once per control
 * tick instead of once per sample, so its spectrum is the same shape an octave
 * band lower. `octaves` is `pink oct`'s `attr_octaves`.
 *
 * Divergences: D4 (seeded), D5 (`1/(octaves+1)` in place of their mismatched
 * `>>7` / `>>attr_octaves` pair).
 *
 * Command.
 */
export class RandPinkKernel {
  constructor(sampleRate, options) {
    this.seed = options.seed;
    this.value = 0;
    this.outputCount = 1;
    this.setOctaves(options.octaves ?? PINK_MAX_OCTAVES);
  }

  /** Command. Rebuild at a new octave count — the buffers are sized by it. */
  setOctaves(octaves) {
    this.source = new PinkSource(this.seed, octaves);
  }

  control(c) {
    this.value = this.source.next();
  }

  sample(c, out) {
    out[0] = this.value;
  }
}

/**
 * `osc/phasor` — `objects/osc/phasor compl.axo` (factory), `code.krate`
 * (MTOFEXTENDED) + `code.srate` (the accumulator).
 *
 *   every sample:  φ ← frac(φ + inc + fm/sampleRate)
 *   phasor0   = φ            phasor180 = frac(φ + ½)
 *
 * Both UNIPOLAR 0…1 (`frac32buffer.positive`), which is what a phasor is for:
 * driving a table read, not being heard.
 *
 * ── A LABEL CORRECTED (R7-11's ruling) ──────────────────────────────────────
 * Their `pitch` inlet is described as "phase increment". The code passes it
 * through `MTOFEXTENDED`, so it is a PITCH in semitones; the description is
 * wrong and is not reproduced. The `freq` inlet's description IS right — it is
 * added to the increment directly — and D9 restates it in hertz.
 *
 * Command.
 */
export class PhasorKernel {
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    this.table = buildIncrementTable(sampleRate);
    this.phase = 0;
    this.increment = 0;
    this.outputCount = 2;
  }

  control(c) {
    this.increment = mtofIncrement(c.pitch, this.table, MTOF_EXT_CLAMP_SEMITONES);
  }

  sample(c, out) {
    this.phase = wrap1(this.phase + this.increment + c.freq / this.sampleRate);
    out[0] = this.phase;
    out[1] = wrap1(this.phase + 0.5);
  }
}

/**
 * `osc/supersaw` — `objects/osc/supersaw.axo` (factory), `code.krate` (the whole
 * object, BUFSIZE loop included).
 *
 * Seven `saw medium` voices. Their detune arithmetic, unwound:
 *
 *   det1 = clamp(detune, 0, 1)·2^27          `__USAT(param_detune + inlet, 27)`
 *   det  = det1²/2^32 = d²·2^22              `___SMMUL(det1, det1)`
 *   f0d  = (det<<8)·f0/2^32 = d²·f0/4        `___SMMUL(det<<8, f0)`
 *   f_k  = f0 + f0d·C_k/2^32 = f0·(1 + d²·C_k/2^34)
 *
 * so detune is SQUARE-LAW (half the dial is a quarter of the spread) and the six
 * coefficients span roughly ±8.3% — about ±1.4 semitones — at full detune. Voice
 * 6 is undetuned; `code.init` spreads the start phases at `i<<28` = i/16 cycle,
 * which is what stops all seven from cracking in unison at t = 0.
 *
 * ── THEIR BUG, KEPT, BECAUSE IT IS THE SOUND ────────────────────────────────
 * `f0i` — the slope used to place the one-sample correction — is computed from
 * `f0` and reused for ALL SEVEN voices, so a detuned voice's correction is off
 * by its own detune ratio (≤8%). Reproduced: it is a sub-sample error on one
 * sample per cycle per voice, and "correcting" it would change the character of
 * the very thing being ported.
 *
 * Output swings ±0.875 (seven voices × the ±⅛ of `saw medium`), which is why
 * `saw medium` is scaled the way it is.
 *
 * Divergences: D2 (their piecewise-linear pitch table is kept, and here it
 * MATTERS — the beat rates are differences of interpolated increments), D9.
 *
 * Command.
 */
export class SupersawKernel {
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    this.table = buildIncrementTable(sampleRate);
    this.phases = new Float64Array(SUPERSAW_VOICES);
    for (let i = 0; i < SUPERSAW_VOICES; i++) this.phases[i] = i * SUPERSAW_PHASE_SPREAD;
    this.increments = new Float64Array(SUPERSAW_VOICES);
    this.outputCount = 1;
  }

  control(c) {
    const base = mtofIncrement(c.pitch, this.table, MTOF_EXT_CLAMP_SEMITONES);
    const detune = Math.min(1, Math.max(0, c.detune));
    const squared = detune * detune;
    for (let k = 0; k < SUPERSAW_DETUNE_COEFFS.length; k++) {
      this.increments[k] = base * (1 + squared * (SUPERSAW_DETUNE_COEFFS[k] / SUPERSAW_COEFF_SCALE));
    }
    this.increments[SUPERSAW_VOICES - 1] = base;
  }

  sample(c, out) {
    // `f0i` is voice 6's slope and every voice borrows it — see the docblock.
    const base = this.increments[SUPERSAW_VOICES - 1];
    let total = 0;
    for (let k = 0; k < SUPERSAW_VOICES; k++) {
      const previous = this.phases[k];
      const phase = wrap1(previous + this.increments[k]);
      this.phases[k] = phase;
      const signed = signedPhase(phase);
      if (signed < 0 && signedPhase(previous) > 0 && base > 0) {
        total += NAIVE_SAW_AMPLITUDE * (1 - 2 * ((signed + 0.5) / base));
      } else {
        total += NAIVE_SAW_AMPLITUDE * 2 * signed;
      }
    }
    out[0] = total;
  }
}

/**
 * `pulse/d` — `objects/pulse/d.axo` (factory), `code.krate` (the trigger latch)
 * + `code.srate` (the decay).
 *
 *   on a rising `trig`:  v ← 1
 *   every sample:        out = v;  v ← v·(1 − decay/64)
 *
 * The `/64` is the whole pfunction chain: `param_d` is `frac32.u.map` =
 * `__USAT(v,27)`, so dial 64 is 2^27; `___SMMUL(val, param_d>>1)` is
 * `val·param_d/2^33` = `val·(dial/64)/64`. So at decay = 1 the envelope loses
 * 1/64 of itself per SAMPLE, and its time constant is
 * `−1/(sampleRate·ln(1 − decay/64))` seconds.
 *
 * OUTPUT BEFORE DECREMENT, so a trigger's first sample is exactly 1.0.
 *
 * ── ONE DIVERGENCE IN OUR FAVOUR, NAMED ─────────────────────────────────────
 * `___SMMUL` TRUNCATES, so on hardware the subtraction stalls once
 * `val·param_d/2^33 < 1` and the envelope sticks at up to 64/2^27 ≈ −126 dBFS
 * forever. In float it reaches zero. Inaudible either way, but it is a real
 * difference and this is where it is written down.
 *
 * Command.
 */
export class PulseDecayKernel {
  constructor() {
    this.edge = new RisingEdge();
    this.value = 0;
    this.coefficient = 0;
    this.outputCount = 1;
  }

  control(c) {
    if (this.edge.fired(c.trig)) this.value = 1;
    this.coefficient = Math.min(1, Math.max(0, c.decay)) / PULSE_DECAY_DIVISOR;
  }

  sample(c, out) {
    out[0] = this.value;
    this.value -= this.value * this.coefficient;
  }
}

/**
 * `pulse/lfsrburst` — `objects/pulse/lfsrburst 8.axo` (factory), `code.krate`
 * (the trigger latch) + `code.srate` (the shift).
 *
 *   on a rising `trig`:  state ← 1, count ← 255
 *   every sample:        if count > 0:
 *                          count−−
 *                          if state & 1: state ← (state >> 1) ^ poly; out = 1
 *                          else:         state ← (state >> 1);        out = 0
 *                        else out = 0
 *
 * A 255-sample (5.3 ms at 48 kHz) burst of a maximal-length 8-bit sequence — a
 * deterministic noise transient, which is what makes it a percussion exciter
 * rather than a noise source.
 *
 * Divergence: D6 (`polynomial` is an integer knob, not their 16-entry `<combo>`;
 * their menu is 0x8E…0xFA and the spec's help lists it).
 *
 * Command.
 */
export class LfsrBurstKernel {
  constructor() {
    this.edge = new RisingEdge();
    this.state = 0;
    this.count = 0;
    this.polynomial = 0;
    this.outputCount = 1;
  }

  control(c) {
    if (this.edge.fired(c.trig)) {
      this.state = 1;
      this.count = LFSR_BURST_LENGTH;
    }
    this.polynomial = Math.floor(c.polynomial) >>> 0;
  }

  sample(c, out) {
    if (this.count <= 0) {
      out[0] = 0;
      return;
    }
    this.count--;
    if (this.state & 1) {
      this.state = ((this.state >>> 1) ^ this.polynomial) >>> 0;
      out[0] = 1;
    } else {
      this.state = this.state >>> 1;
      out[0] = 0;
    }
  }
}

/**
 * `seq/lfsr` — `objects/seq/lfsrseq.axo` (factory), `code.krate` (all of it).
 *
 *   on a rising `trig`:  state ← (state & 1) ? (state >> 1) ^ poly : state >> 1
 *   on a rising `reset`: state ← 1
 *   on a rising `load`:  state ← lval
 *   always:              out = state & 1
 *
 * A pseudo-random but PERFECTLY REPEATING gate pattern — with a maximal-length
 * tap the period is `2^bits − 1` steps, which is why it makes a generative
 * sequence that never quite loops where you expect. The three edges are tested
 * in that order every tick, so a simultaneous trig+reset resets.
 *
 * A NON-maximal `polynomial` can walk the register to 0, where it sticks and the
 * output is silent forever. That is theirs; `reset` is the way out.
 *
 * Divergences: D6 (integer `polynomial` knob rather than their 160-entry
 * `<combo>`), D9 (`lval` is the integer itself, not a frac32 needing `>>21`).
 *
 * Command.
 */
export class LfsrSeqKernel {
  constructor() {
    this.trigEdge = new RisingEdge();
    this.resetEdge = new RisingEdge();
    this.loadEdge = new RisingEdge();
    this.state = 1;
    this.value = 1;
    this.outputCount = 1;
  }

  control(c) {
    const polynomial = Math.floor(c.polynomial) >>> 0;
    if (this.trigEdge.fired(c.trig)) {
      this.state = (this.state & 1) ? (((this.state >>> 1) ^ polynomial) >>> 0) : (this.state >>> 1);
    }
    if (this.resetEdge.fired(c.reset)) this.state = 1;
    if (this.loadEdge.fired(c.load)) this.state = Math.floor(c.lval) >>> 0;
    this.value = this.state & 1;
  }

  sample(c, out) {
    out[0] = this.value;
  }
}
