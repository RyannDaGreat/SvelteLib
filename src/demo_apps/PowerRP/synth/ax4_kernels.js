/**
 * AX-4 — THE AXOLOTI ENVELOPE / MIXER / VCA / CLIPPER KERNELS, PORTED TO FLOAT.
 *
 * ── WHAT THIS FILE IS ───────────────────────────────────────────────────────
 * Eleven Axoloti objects' DSP and nothing else. No AudioNodes, no AudioWorklet,
 * no DOM: a plain ES module, so `tests/port_ax4_test.js` can run every recurrence
 * in BARE NODE against a BigInt model of the original C. The arithmetic is the
 * deliverable, so the arithmetic must be reachable without a browser.
 *
 * `worklets/processors_ax4.js` wraps each kernel in an AudioWorkletProcessor;
 * `modules_ax4.js` derives its factories from that file's roster.
 *
 * ── THE DERIVATION RECORD ───────────────────────────────────────────────────
 * Sources, cloned READ-ONLY and read at these commits on 2026-08-06:
 *
 *   factory   axoloti/axoloti-factory @ 78cb74bd0b118f6b951ccd6b92a62b1bae0ff1aa
 *   contrib   axoloti/axoloti-contrib @ 798166f0ce29f4b6a39099b3bde6ef2e7755a7c4  (tag 1.0.12)
 *   firmware  axoloti/axoloti         @ 46f6e4b383ce182da9dcca25b9d4b544fe20f990
 *
 * The three commits AX-2 and AX-3 pinned are the three this block read; the
 * firmware clone was absent from `/tmp/r7_sources` and was re-cloned, landing on
 * the same 46f6e4b. Per-node records (object file, WHICH code block, the float
 * recurrence, the deviations) are in `core/audio_specs_ax4.js`'s `derivation`
 * fields — AX-1's and AX-3's machine-checked shape — and each kernel docblock
 * below names its object and code block again so the DSP reads on its own.
 *
 * ── THE FIXED-POINT LAWS THIS FILE IMPLEMENTS (manifest § R7-11) ────────────
 *
 *   XML dial (−64…64) ──×2^21──▶ raw int32 ──pfunction──▶ param_X ──/2^27──▶ float
 *
 * 1. `frac32` is signed Q27: real = i/2^27, full scale ±1.0, ±16.0 of headroom.
 * 2. `___SMMUL(a,b)` is the top 32 bits of a signed 64-bit product, TRUNCATING;
 *    `___SMMUL(a,b)<<s` is `a·b/2^(32−s)`, so two frac32 operands need `<<5`.
 *    `___SMMLA(a,b,c)` is `c + ___SMMUL(a,b)`.
 * 3. CONTROL RATE IS sampleRate/16 — 3000 Hz on their hardware, EIGHT ticks per
 *    128-frame quantum. Every kernel here exposes `control(c)` (once per
 *    AX_BUFSIZE samples) and `sample(c, ins, out)` (per sample). THIS BLOCK IS
 *    ALMOST ENTIRELY ENVELOPES: hoisting `control()` to once per quantum runs
 *    every one of them 8× slow, and it still sounds like music.
 * 4. `param_X` IS NOT THE DIAL. Every param passes a pfunction first
 *    (firmware `api/parameter_functions.h`), and this block uses four of them:
 *      pf_signed_clamp      `__SSAT(v,28)`                      — the raw dial
 *      pf_unsigned_clamp    `__USAT(v,27)`                      — 0…1 of dial 0…64
 *      pf_kexpltime         `MTOF(−v) >> 2`                     — a RISE step
 *      pf_kexpdtime         `0x7FFFFFFF − (MTOF(−v) >> 2)`      — a DECAY coefficient
 *    *That is why an Axoloti ADSR body contains no `exp()`.* Port the pfunction.
 * 5. PITCH: 1 semitone = `1<<21`, pitch 0 = MIDI 64 = E4 = 329.6276 Hz, so
 *    `hz = 440·2^((p−5)/12)`. `MTOF` clamps at `__SSAT(p,28)` = ±64 semitones and
 *    at Nyquist; `MTOFEXTENDED` clamps at `__SSAT(p,29)` = ±128 semitones.
 *
 * ── THE UNIT LAW, AND WHY IT IS SECONDS HERE (R7-UNITS clause 2) ────────────
 * "A `number` wire carries the REAL UNIT of its quantity — seconds for an
 * envelope time." This block is the one the clause was written for, and it is
 * NOT a re-derivation: Axoloti itself declares the real unit for every one of
 * these params through a `NativeToReal`, and this file inverts THAT function
 * rather than inventing one.
 *
 *   `LinearTimeExp`  (adsr a/d/r, env/d, env/d lin m, env/d m)
 *        t = 32 / (440·2^((−dial−5)/12))  = AX_TIME_PHASE_CYCLES / mtof(−dial)
 *   `DecayTime`      (env/ahd m a/d)
 *        t = ln2 · 4096/(64 − dial) · 16/48000
 *
 * Both are `axTimeDialToSeconds` / `axDecayDialToSeconds` below, exported so a
 * patch transcriber converts a harvested dial MECHANICALLY instead of guessing.
 * A `frac32.u.map` with NO conversion declared (adsr's `s`, the mixer's gains,
 * the DP clippers' gains) is normalised dial/64 → 0…1, which is AX-2's own
 * precedent for that parameter class (`pulse/d`'s decay: "their dial reads 0…64;
 * this reads 0…1 for the same span").
 *
 * ── ONE CROSS-BLOCK IMPORT, AND IT IS DELIBERATE ────────────────────────────
 * `dist/inf` reads the firmware's 2048-entry `blept` minBLEP table, which
 * `synth/ax2_kernels.js` already holds verbatim and exposes as `blepResidual`.
 * Copying 2048 firmware constants into a second file is the "hand-maintained
 * mirror of another module's shape" the brief names as this project's commonest
 * failure, at its most literal — so this file IMPORTS the one copy. Nothing else
 * crosses: the pitch law is three lines and is restated here, exactly as AX-3
 * restated it rather than reaching into AX-2.
 *
 * ── DELIBERATE DEVIATIONS, ALL OF THEM, NAMED ───────────────────────────────
 *
 * D1. SAMPLE RATE. Every time constant is computed from the RUNNING
 *     `sampleRate` through `axTickSeconds`, not from a hard-wired 16/48000, so a
 *     44.1 kHz context still runs an envelope at the length its knob says. At
 *     48 kHz the arithmetic is bit-comparable to theirs.
 * D2. TIMES ARE SECONDS, NOT DIALS. See the unit law above. TO TRANSCRIBE AN
 *     AXOLOTI PATCH: run its dial through `axTimeDialToSeconds` (a/d/r on the
 *     ADSR, `d` on both decays) or `axDecayDialToSeconds` (a/d on the AHD);
 *     divide a `frac32.u.map` dial by AX_DIAL_FULL for every gain and for
 *     sustain. Those two functions and that constant exist for exactly this.
 * D3. A TIME MODULATION INPUT SUMS IN SECONDS. On hardware `adsr m` sums
 *     `inlet_a` with `param_a` in the PITCH domain before `MTOF`, and `ahd m`
 *     sums `inlet_a>>1` into the coefficient — both MULTIPLY the time. Here the
 *     input and the knob share one AudioParam and ADD, which is this project's
 *     universal law for a same-named input ("AN INPUT AND A KNOB OF ONE NAME
 *     SHARE ONE AudioParam, WHICH ADDS") and is what R7-UNITS clause 2 forces
 *     once the knob is in seconds. AUDIBLE CONSEQUENCE: a modulation that swept
 *     an octave of decay time per unit on hardware sweeps a fixed number of
 *     seconds here. Sustain is NOT affected — `adsr m` sums `inlet_s` with
 *     `param_s` linearly and clamps, which is what we do.
 * D4. THE PITCH TABLE IS NOT REPRODUCED. `mtof48k_q31` interpolates a 257-entry
 *     table linearly and reads up to 0.72 cents sharp mid-semitone. We evaluate
 *     the exponential, so every envelope time is very slightly MORE accurate
 *     than the hardware's. (AX-3 made the same call for the same reason.)
 * D5. THE AHD's SECONDS ARE THEIR DISPLAY'S APPROXIMATION, NOT THE TRUE
 *     HALF-LIFE. `DecayTime` prints `ln2·dt/α` where the exact half-life of a
 *     one-pole with per-tick rate α is `ln2·dt/(−ln(1−α))`. We invert THEIR
 *     formula, because that is what makes a harvested dial reproduce its own
 *     sound exactly; the label is up to 0.78% long at the fastest setting
 *     (α = 1/64) and under 0.1% over most of the dial. Measured in the test.
 * D6. `tiar/dist/DPSoftClip`'s ANTIALIASING IS DEAD IN THE SOURCE AND WE
 *     REPRODUCE THAT. Its guard is written
 *         `if(inlet_in & 0xFFFFF000 != old_in & 0xFFFFF000)`
 *     and C binds `!=` tighter than `&`, so it parses as
 *         `(inlet_in & (0xFFFFF000 != old_in)) & 0xFFFFF000`
 *     = `(inlet_in & 0or1) & 0xFFFFF000`, and 0xFFFFF000's low bit is 0 — the
 *     expression is 0 for EVERY input, including the one value that makes the
 *     comparison false. So the object advertised in its own description as
 *     "SoftClip with Differentiated Polynomial Anti aliasing" has never once
 *     run its DP branch; it is a plain aliasing cubic soft clipper. Its sibling
 *     `DPHardClip` parenthesises correctly and DOES antialias. R7-11's rule is
 *     "reproduce source BUGS where they are audible and NAME them", and this
 *     one decides what the object sounds like, so: reproduced, named here, and
 *     stated in the spec `help` so the label does not lie.
 * D7. `DPHardClip` DIVIDES BY ZERO AT InGain = 0 AND WE DO NOT. With InGain 0
 *     every `x0` is 0, so a bucket change reaches `(I0−I1)/(x0−x1)` = 0/0 → NaN
 *     → `(int32_t)NaN` is undefined behaviour in C and would poison the graph
 *     here. The AA branch is therefore gated on `x0 !== x1` as well; that
 *     condition is unreachable for any nonzero InGain, because a bucket change
 *     implies a different `inlet_in`.
 * D8. `dist/inf`'s DISPATCH INDEX DOES NOT OVERFLOW HERE. Their
 *     `x = 64 − ((−i0<<6)/(i1−i0))` shifts an int32 left by 6, which overflows
 *     once `|i0| ≥ 2^25` — i.e. once the sample before a zero crossing is past
 *     full scale, reachable inside frac32's ±16 headroom. JavaScript numbers do
 *     not wrap there, so our index stays in its legal 0…64 and theirs can fly
 *     anywhere. Same class as AX-2's D11, same ruling: we sound better.
 * D9. GAINS ARE NORMALISED dial/64. `frac32.u.map` declares no real unit, so
 *     the mixer's six gains, the ADSR's sustain and both DP clippers' In/Out
 *     gains read 0…1 for their 0…64. `mix N g` differs from `mix N` ONLY in the
 *     editor's readout (`LinRatio(1.0)` prints `x` dial/64, which is the same
 *     number), so the ` g` variants need no second node.
 * D10. THE DP CLIPPERS DEFAULT TO UNITY, NOT TO SILENCE. Neither object
 *     declares a `<DefaultValue>`, so a freshly dropped one on hardware has
 *     InGain 0 and OutGain 0 and makes no sound at all. Ours default to
 *     InGain 0.25 (their dial 16, where `x0 = x` exactly) and OutGain 0.5
 *     (their dial 32, where the shaper's peak is exactly ±1) — the one pair
 *     that is not a choice, because together they are the identity drive and
 *     the identity peak. A pleasant consequence, pinned in the test:
 *     `audio_ax_dp_soft_clip` at its defaults is byte-identical to `dist/soft`.
 * D11. FOUR FAMILIES SHIP AS ONE NODE EACH. `env/adsr` + `env/adsr m`,
 *     `env/d` + `env/d m`, `mix/mix 1…6` + their ` g` variants, and (per the
 *     lead's ruling) the two spellings of the decay envelope. Every ` m`
 *     variant is its plain sibling with the pfunction inlined and a modulation
 *     inlet added, which is exactly the duplication R7-11 says our
 *     param/inlet duality exists to remove.
 * D12. THE OUTPUT SATURATION IS REAL AND IS PORTED. `mix N` ends in
 *     `__SSAT(…, 28)`, so a mixer's output is HARD-CLIPPED at ±1.0 — it is not
 *     one of the objects that uses frac32's ±16 headroom. `dist/soft` clamps
 *     its INPUT the same way.
 *
 * Every kernel is a class with `control(c)` and `sample(c, ins, out)`; both are
 * COMMANDS (they advance the kernel's own state) and neither allocates, because
 * they run on the audio thread. `c` is the control map (AudioParam values),
 * `ins` a Float64Array of this node's audio inputs at the current sample, `out`
 * a Float64Array of its outputs. The pure helpers above them are labelled
 * individually.
 */

import { blepResidual } from "./ax2_kernels.js";

// ── THE PLATFORM CONSTANTS ──────────────────────────────────────────────────

/** Axoloti's `BUFSIZE` (firmware `api/axoloti.h:8`): samples per control tick,
 *  and THE number that makes the control rate 3000 Hz at 48 kHz. */
export const AX_BUFSIZE = 16;

/** A signed dial's full-scale reading, and the divisor that turns any
 *  `frac32.u.map` dial into the 0…1 our wires carry (deviation D9). */
export const AX_DIAL_FULL = 64;

/** frac32 full scale: `real = raw / 2^27`. */
const FRAC32_ONE = 2 ** 27;

/** `__SSAT(v, 28)`'s positive limit in real units — one raw step below 1.0. */
const FRAC32_MAX = 1 - 1 / FRAC32_ONE;

/** frac32's headroom above full scale: an int32 holds ±16.0 on a 2^27 scale.
 *  It is the honest bound for an inlet with no pfunction behind it — `vcaST`'s
 *  `v` is one, so a wired gain may amplify by up to 16 exactly as theirs may. */
export const AX_FRAC32_HEADROOM = 2 ** 31 / FRAC32_ONE;

/** `MTOFEXTENDED`'s `__SSAT(p, 29)` — the ±128 semitones an object that runs its
 *  OWN mtof (`env/d m`) can reach, against the ±64 a pfunction's `MTOF` can. */
const AX_MTOF_EXTENDED_SEMITONES = 128;

/** A440, and where it sits on Axoloti's pitch scale (pitch 0 = MIDI 64 = E4). */
const A440_HZ = 440;
const A440_SEMITONES = 5;
const SEMITONES_PER_OCTAVE = 12;

/**
 * The `32` in `LinearTimeExp`, and it is TWO factors rather than a magic number.
 * An `MTOF` result is a 2^32 phase increment `2^32·f/fs`; the envelope objects
 * consume it as `>>2` (a rise step against a 2^31 accumulator) or `>>6` (a fall
 * step against a 2^27 one), and both work out to `f/(2·fs)` of full scale per
 * tick. A tick is `AX_BUFSIZE/fs` seconds, so the stage lasts `2·AX_BUFSIZE/f`
 * seconds — which is this constant over the frequency.
 */
const AX_TIME_PHASE_CYCLES = 2 * AX_BUFSIZE;

/**
 * `MTOF`'s Nyquist clamp expressed as a TIME. Their `mtof48k_q31` pins its
 * result at `0x7FFFFFFF`, i.e. half the sample rate, so no `LinearTimeExp`
 * stage can be shorter than `AX_TIME_PHASE_CYCLES/(fs/2)` = four control ticks.
 */
const AX_MIN_TIME_TICKS = 4;

/** `DecayTime`'s 4096: `ahd m`'s per-tick rate is `(64 − dial)/4096`, because
 *  `___SMMLA(…, 2^26 − dial·2^20, …)` divides by 2^32 and `2^26/2^32` is 1/64
 *  while `2^20/2^32` is 1/4096. */
const AX_DECAY_RATE_DIVISOR = 4096;

/** …so the fastest rate their dial can ask for is `64/4096`. */
const AX_DECAY_RATE_MAX = AX_DIAL_FULL / AX_DECAY_RATE_DIVISOR;

/** `__USAT(v, 27)` caps an unsigned dial one raw step below 64, which is why
 *  the AHD's slowest setting is a very long half-life rather than a freeze. */
const AX_DIAL_USAT_MAX = (FRAC32_ONE - 1) / 2 ** 21;

/** The Axoloti editor's own display rate for a `DecayTime`, hard-coded to the
 *  hardware's 48 kHz in `realunits/DecayTime.java`. The KERNEL uses the running
 *  rate (D1); this is only for converting a harvested dial to a knob value. */
const AX_HARDWARE_SAMPLE_RATE = 48000;

/** `blept` is 2048 entries (firmware `BLEPSIZE`) and a settled voice pins at the
 *  last one, where its residual is exactly 0. `blepResidual` owns the table; these
 *  two are its shape, restated because ax2_kernels does not export them, and
 *  PINNED against it by tests/port_ax4_test.js so a change there turns red here. */
const BLEP_LAST = 2047;

/** A voice's pointer advances 64 entries per sample (`t += 64`), which is also
 *  the sub-sample resolution of a dispatch. */
const BLEP_SUBSAMPLES = 64;

/** `dist/inf` declares `blepvoices = 8`, round-robin, so a 9th overlapping
 *  transition steals the oldest — a faithful artefact at extreme drive. */
const INF_BLEP_VOICES = 8;

/** Their `sum -= ((((nextvoice+1)&1)<<1)-1)<<13` against an `out = sum<<13`:
 *  8192/16384 of full scale, the square wave's own half-amplitude offset. */
const INF_PARITY_OFFSET = 0.5;

/** `dist/inf` reads `inlet_in[j]>>2` — only the SIGN and the RATIO matter, but
 *  the shift's truncation moves the interpolated crossing, so it is reproduced. */
const INF_INPUT_SHIFT = 2;

/** `DPSoftClip`/`DPHardClip`: `inGain = param_InGain/(2^25·2^27)` against a
 *  `frac32` input of `x·2^27` works out to `x·dial/16`, so a normalised gain of
 *  1.0 (their dial 64) drives the shaper at 4×. */
const AX_DP_DRIVE_PER_UNIT = AX_DIAL_FULL / 16;

/** `outGain = 2·param_OutGain` against a 2^27 output scale is `dial/32`, i.e.
 *  twice the normalised gain — and the shaper's own peak is 2, so a normalised
 *  OutGain of 0.5 puts the clip point at exactly ±1. */
const AX_DP_PEAK_PER_UNIT = 2;

/** Their bucket test masks off the low twelve bits of the raw int32 input. */
const AX_DP_BUCKET_MASK = 0xfffff000 | 0;

/** `DPHardClip`'s integral of the saturator: `x²/2` below unity, `|x| − 0.5`
 *  above it. (`DPSoftClip`'s own integral is transcribed in
 *  tests/port_ax4_test.js instead: deviation D6 makes it unreachable in the
 *  source, so shipping it here would be dead code in the audio path — the test
 *  is where the counterfactual belongs.) */
const DP_HARD_I_OFFSET = 0.5;

/** The cubic soft clipper `dist/soft` and `DPSoftClip` share: `1.5x − 0.5x³`,
 *  written `x·(3 − x²)` scaled by a half where the DP object writes it. */
const SOFT_CLIP_CUBIC = 3;
const SOFT_CLIP_HALF = 0.5;

// ── PURE HELPERS ────────────────────────────────────────────────────────────

/**
 * Pure function. Axoloti pitch (semitones, 0 = MIDI 64 = E4) to hertz.
 *
 * This IS `axoloti_math_init`'s table generator, `440·2^((i − 69 − 64)/12)`,
 * with `i` re-expressed as a pitch rather than a table index. Restated here
 * rather than imported: it is three lines, and AX-3 set the precedent that a
 * block owns its own pitch law so two blocks cannot be coupled by one.
 *
 * @param {number} semitones - Axoloti pitch; 0 is E4
 * @returns {number} frequency in hertz
 *
 * @example Math.round(axPitchToHz(0) * 1e4) / 1e4 // 329.6276
 * @example Math.round(axPitchToHz(5)) // 440
 * @example axPitchToHz(12) / axPitchToHz(0) // 2
 */
export function axPitchToHz(semitones) {
  return A440_HZ * Math.pow(2, (semitones - A440_SEMITONES) / SEMITONES_PER_OCTAVE);
}

/**
 * Pure function. One control tick, in seconds — `AX_BUFSIZE/sampleRate`, which
 * is 1/3000 s on their hardware (deviation D1).
 *
 * @param {number} sampleRate - the running context's rate
 * @returns {number} seconds per k-rate tick
 *
 * @example axTickSeconds(48000) * 3000 // 1
 * @example axTickSeconds(44100) // 0.00036281179138321996
 */
export function axTickSeconds(sampleRate) {
  return AX_BUFSIZE / sampleRate;
}

/**
 * Pure function. `realunits/LinearTimeExp.java` — the seconds an Axoloti dial
 * reads on every `klineartime`/`kdecaytime.exp` param in this block. THIS IS THE
 * CONVERTER A PATCH TRANSCRIPTION NEEDS (deviation D2): the harvested XML holds
 * the dial, our knob holds the seconds.
 *
 * @param {number} dial - the XML dial value, −64…64
 * @returns {number} seconds
 *
 * @example Math.round(axTimeDialToSeconds(0) * 1e6) / 1e6 // 0.097079
 * @example Math.round(axTimeDialToSeconds(-64) * 1e6) / 1e6 // 0.002408
 * @example Math.round(axTimeDialToSeconds(64) * 1e4) / 1e4 // 3.914
 * @example // a dial 12 higher is exactly twice as long
 * @example Math.round((axTimeDialToSeconds(12) / axTimeDialToSeconds(0)) * 1e12) / 1e12 // 2
 */
export function axTimeDialToSeconds(dial) {
  return AX_TIME_PHASE_CYCLES / axPitchToHz(-dial);
}

/**
 * Pure function. `axTimeDialToSeconds` inverted, for reading a knob back as the
 * dial an Axoloti patch would hold.
 *
 * @param {number} seconds - an envelope time
 * @returns {number} the dial that produces it
 *
 * @example Math.round(axTimeSecondsToDial(axTimeDialToSeconds(24)) * 1e9) / 1e9 // 24
 * @example Math.round(axTimeSecondsToDial(axTimeDialToSeconds(0)) * 1e9) / 1e9 // 0
 * @example Math.round(axTimeSecondsToDial(0.1) * 1e6) / 1e6 // 0.513179
 */
export function axTimeSecondsToDial(seconds) {
  const hz = AX_TIME_PHASE_CYCLES / seconds;
  return -(SEMITONES_PER_OCTAVE * Math.log2(hz / A440_HZ) + A440_SEMITONES);
}

/**
 * Pure function. `realunits/DecayTime.java` — the HALF-LIFE an Axoloti dial reads
 * on `env/ahd m`'s two `frac32.u.map.kdecaytime` params. Their formula, at their
 * hard-wired 48 kHz, so a harvested dial converts to a knob value exactly
 * (deviations D2 and D5).
 *
 * @param {number} dial - the XML dial value, 0…64
 * @returns {number} seconds
 *
 * @example Math.round(axDecayDialToSeconds(0) * 1e6) / 1e6 // 0.014787
 * @example Math.round(axDecayDialToSeconds(56) * 1e6) / 1e6 // 0.118297
 * @example // and it is a reciprocal in (64 − dial), not an exponential
 * @example Math.round((axDecayDialToSeconds(32) / axDecayDialToSeconds(0)) * 1e9) / 1e9 // 2
 */
export function axDecayDialToSeconds(dial) {
  const rate = (AX_DIAL_FULL - dial) / AX_DECAY_RATE_DIVISOR;
  return Math.LN2 * axTickSeconds(AX_HARDWARE_SAMPLE_RATE) / rate;
}

/**
 * Pure function. A `LinearTimeExp` stage's per-tick step, in units of full
 * scale. It is the tick period over the stage time, with their Nyquist floor
 * (`AX_MIN_TIME_TICKS`) applied — which is what stops a zero-second knob from
 * producing a step of infinity.
 *
 * This ONE function is the ADSR's attack increment, `env/d lin m`'s fall, and
 * (subtracted from one) every exponential coefficient in the block, because all
 * three consume the same `MTOF` result on scales that differ by exactly the
 * shifts that cancel.
 *
 * @param {number} seconds - the stage time
 * @param {number} tick - seconds per control tick
 * @returns {number} fraction of full scale per tick, in (0, 1/AX_MIN_TIME_TICKS]
 *
 * @example axTimeStep(0.097079081, 1 / 3000) // 0.003433626790650535
 * @example axTimeStep(1, 1 / 3000) * 3000 // 1
 * @example axTimeStep(0, 1 / 3000) // 0.25
 */
export function axTimeStep(seconds, tick) {
  const floor = AX_MIN_TIME_TICKS * tick;
  return tick / (seconds > floor ? seconds : floor);
}

/**
 * Pure function. A `DecayTime` stage's per-tick approach rate. Inverts THEIR
 * display formula rather than the exact half-life (deviation D5), so a dial
 * converted through `axDecayDialToSeconds` reproduces its own rate exactly.
 * Clamped to the rate their dial can actually ask for.
 *
 * @param {number} seconds - the half-life the knob reads
 * @param {number} tick - seconds per control tick
 * @returns {number} approach rate per tick, in [0, AX_DECAY_RATE_MAX]
 *
 * @example axDecayRate(0.0147871398519455, 1 / 3000) // 0.015625
 * @example Math.round(axDecayRate(0.118296, 1 / 3000) * 1e9) / 1e9 // 0.001953143
 * @example axDecayRate(0.0001, 1 / 3000) // 0.015625
 */
export function axDecayRate(seconds, tick) {
  const rate = Math.LN2 * tick / seconds;
  return rate > AX_DECAY_RATE_MAX ? AX_DECAY_RATE_MAX : (rate > 0 ? rate : 0);
}

// ── THE AudioParam BOUNDS, DERIVED RATHER THAN TYPED ────────────────────────
//
// `worklets/processors_ax4.js` needs a number for every parameterDescriptor and
// `core/audio_specs_ax4.js` needs one for every knob row. Those two ranges are
// NOT the same and both are load-bearing: the KNOB spans what the Axoloti dial
// spans, and the PARAM spans what the engine can actually distinguish, so a
// wired modulation reaches everything the hardware's own modulation inlet does
// (AX-3 set that split for its SVFs' ±128 semitones). Every bound below is
// COMPUTED from the laws above, because four hand-typed floats with fifteen
// digits each is exactly the mirror that drifts.

/** No `LinearTimeExp` stage can be shorter than `MTOF`'s Nyquist clamp — four
 *  control ticks. Below this the kernel's own floor makes every value identical. */
export const AX_TIME_PARAM_MIN = AX_MIN_TIME_TICKS * axTickSeconds(AX_HARDWARE_SAMPLE_RATE);

/** …and no longer than `MTOFEXTENDED`'s −128 semitones, which is what `env/d m`
 *  reaches by summing its inlet into the pitch domain. 157.8 s. */
export const AX_TIME_PARAM_MAX = axTimeDialToSeconds(AX_MTOF_EXTENDED_SEMITONES);

/** The AHD's rate saturates at `AX_DECAY_RATE_MAX`, so nothing below the dial-0
 *  half-life behaves any differently. */
export const AX_DECAY_PARAM_MIN = axDecayDialToSeconds(0);

/** …and `__USAT(v, 27)` caps the dial one raw step below 64, which is a 23-day
 *  half-life: their FREEZE, expressed as the number it really is. */
export const AX_DECAY_PARAM_MAX = axDecayDialToSeconds(AX_DIAL_USAT_MAX);

/**
 * Pure function. `__SSAT(v, 28)` in real units — the hard clip a mixer's output
 * and a soft clipper's input both take. Asymmetric by one raw step, exactly as
 * a two's-complement saturation is.
 *
 * @param {number} x - a value in frac32's ±16 headroom
 * @returns {number} the same value clipped to [−1, 1 − 2^−27]
 *
 * @example axSat1(0.5) // 0.5
 * @example axSat1(4) // 0.9999999925494194
 * @example axSat1(-4) // -1
 */
export function axSat1(x) {
  return x > FRAC32_MAX ? FRAC32_MAX : (x < -1 ? -1 : x);
}

/**
 * Pure function. `__USAT(v, 27)` in real units — the 0…1 clamp `adsr m` puts on
 * `param_s + inlet_s`.
 *
 * @param {number} x - a level
 * @returns {number} the same level clipped to [0, 1]
 *
 * @example axSatPositive(0.4) // 0.4
 * @example axSatPositive(-2) // 0
 * @example axSatPositive(9) // 1
 */
export function axSatPositive(x) {
  return x > 1 ? 1 : (x < 0 ? 0 : x);
}

/**
 * Pure function. The cubic soft saturator `dist/soft`'s description states:
 * `y = 1.5x − 0.5x³` inside ±1, hard at ±1 outside. Its input is `__SSAT`ed
 * first, so the outside branch is the clamp rather than a separate case.
 *
 * @param {number} x - input, any magnitude
 * @returns {number} the shaped value, in [−1, 1]
 *
 * @example softCubic(0) // 0
 * @example softCubic(1) // 1
 * @example softCubic(-1) // -1
 * @example softCubic(0.5) // 0.6875
 * @example softCubic(9) // 1
 */
export function softCubic(x) {
  const t = axSat1(x);
  return t * (SOFT_CLIP_CUBIC - t * t) * SOFT_CLIP_HALF;
}

/**
 * Pure function. The raw int32 an Axoloti buffer holds for a real value — what
 * `DPHardClip`'s bucket test and `dist/inf`'s crossing detector both compare.
 * `|0` wraps at 2^31 exactly as the C type does.
 *
 * @param {number} x - a real value, nominally in ±16
 * @returns {number} the frac32 int32
 *
 * @example axRawFrac32(1) // 134217728
 * @example axRawFrac32(-0.5) // -67108864
 * @example axRawFrac32(0) // 0
 */
export function axRawFrac32(x) {
  return (x * FRAC32_ONE) | 0;
}

/**
 * Pure function. `blept[t]` as a fraction of BLEP_UNITY — a settled step is 1,
 * the discontinuity is ~0, and the ringing overshoots past 1. The table lives
 * once, in `synth/ax2_kernels.js`; this is the complement of what it exports.
 *
 * @param {number} t - table index, 0…BLEP_LAST
 * @returns {number} the step's value there
 *
 * @example blepStep(2047) // 1
 * @example blepStep(0) < 0.001 // true
 * @example blepStep(500) // 0.9422607421875
 * @example blepStep(261) > 1 // true   -- the band-limited step's overshoot
 */
export function blepStep(t) {
  return 1 - blepResidual(t);
}

/**
 * Query. The last legal `blept` index and the per-sample advance, exposed so
 * tests/port_ax4_test.js can pin them against the table `synth/ax2_kernels.js`
 * actually ships — rather than two files holding the same 2047 with nothing
 * joining them.
 *
 * @returns {{last: number, subsamples: number}}
 *
 * @example blepShape() // {last: 2047, subsamples: 64}
 */
export function blepShape() {
  return { last: BLEP_LAST, subsamples: BLEP_SUBSAMPLES };
}

// ── ENVELOPES ───────────────────────────────────────────────────────────────

/** The ADSR's three stages, as `code.declaration`'s `int8_t stage` numbers them. */
const ADSR_RELEASE = 0;
const ADSR_ATTACK = 1;
const ADSR_DECAY = 2;

/**
 * `env/adsr` + `env/adsr m` (`code.krate`), factory
 * `objects/env/{adsr, adsr m}.axo`. THE union node: `adsr m` is `adsr` with the
 * four pfunctions inlined and four modulation inlets added, so shipping both
 * would be the duplication R7-11 says our param/inlet duality removes (D11).
 *
 *     // once per control tick, times in SECONDS (D2), levels in 0…1
 *     if (gate > 0 && !ntrig) { stage = ATTACK;  ntrig = 1 }
 *     if (gate <= 0 && ntrig) { stage = RELEASE; ntrig = 0 }
 *     RELEASE: val *= 1 − dt/r
 *     ATTACK:  val += dt/a ; if (val >= 1) { val = 1 ; stage = DECAY }
 *     DECAY:   s = clamp(sustain, 0, 1) ; val = s + (val − s)·(1 − dt/d)
 *     env = val
 *
 * ATTACK IS LINEAR AND DECAY/RELEASE ARE EXPONENTIAL — R7-11 states it and the
 * `val + param_a` / `___SMMUL(val, param_d)` split is where it comes from. The
 * attack's end test is their int32 OVERFLOW (`if (val<0) val = 0x7FFFFFFF`),
 * which is why the stage ends at full scale rather than at the time expiring.
 *
 * Command (advances stage, ntrig and val). Allocation-free.
 */
export class AdsrKernel {
  /** @param {number} sampleRate - the running context's rate */
  constructor(sampleRate) {
    this.tick = axTickSeconds(sampleRate);
    this.stage = ADSR_RELEASE;
    this.ntrig = false;
    this.val = 0;
  }

  /** Command. One 3000 Hz control tick. */
  control(c) {
    const high = c.gate > 0;
    if (high && !this.ntrig) {
      this.stage = ADSR_ATTACK;
      this.ntrig = true;
    }
    if (!high && this.ntrig) {
      this.stage = ADSR_RELEASE;
      this.ntrig = false;
    }
    if (this.stage === ADSR_RELEASE) {
      this.val *= 1 - axTimeStep(c.r, this.tick);
    } else if (this.stage === ADSR_ATTACK) {
      this.val += axTimeStep(c.a, this.tick);
      if (this.val >= 1) {
        this.val = 1;
        this.stage = ADSR_DECAY;
      }
    } else {
      const sustain = axSatPositive(c.s);
      this.val = sustain + (this.val - sustain) * (1 - axTimeStep(c.d, this.tick));
    }
  }

  /** Command. Hold the tick's value for all AX_BUFSIZE samples, as theirs does. */
  sample(c, ins, out) {
    out[0] = this.val;
  }
}

/**
 * `env/ahd m` (`code.krate`), factory `objects/env/ahd m.axo`. A one-pole that
 * rises toward full scale while the gate is high and falls toward zero when it
 * is not — the HOLD is implicit in "rises and stays there".
 *
 *     // once per control tick, a and d are HALF-LIVES in seconds (D2, D5)
 *     gate > 0 : val += (1 − val)·(ln2·dt/a)
 *     else     : val -= val·(ln2·dt/d)
 *     env = val
 *
 * Their coefficient is `2^26 − param/2` inside a `___SMMLA`, i.e. a per-tick
 * rate of `(64 − dial)/4096`; both params are `frac32.u.map.kdecaytime`, so the
 * dial is UNSIGNED and a negative one clamps to 0 (the FASTEST setting), not to
 * a slow one.
 *
 * Command (advances val). Allocation-free.
 */
export class AhdKernel {
  /** @param {number} sampleRate - the running context's rate */
  constructor(sampleRate) {
    this.tick = axTickSeconds(sampleRate);
    this.val = 0;
  }

  /** Command. One 3000 Hz control tick. */
  control(c) {
    if (c.gate > 0) this.val += (1 - this.val) * axDecayRate(c.a, this.tick);
    else this.val -= this.val * axDecayRate(c.d, this.tick);
  }

  /** Command. Hold the tick's value. */
  sample(c, ins, out) {
    out[0] = this.val;
  }
}

/**
 * `env/d` + `env/d m` (`code.krate`), factory `objects/env/{d, d m}.axo`. The
 * union node (D11), and the block's workhorse: a trigger snaps it to full scale
 * and it decays exponentially from there.
 *
 *     // once per control tick, d in SECONDS (D2)
 *     if (trig > 0 && !ntrig) { val = 1 ; ntrig = 1 }
 *     else { if (trig <= 0) ntrig = 0 ; val *= 1 − dt/d }
 *     env = val
 *
 * THE `else` IS LOAD-BEARING AND IS THEIRS: the tick that fires the trigger does
 * NOT also decay, so the first tick of an envelope is exactly 1.0.
 *
 * Command (advances ntrig and val). Allocation-free.
 */
export class EnvDecayKernel {
  /** @param {number} sampleRate - the running context's rate */
  constructor(sampleRate) {
    this.tick = axTickSeconds(sampleRate);
    this.ntrig = false;
    this.val = 0;
  }

  /** Command. One 3000 Hz control tick. */
  control(c) {
    const high = c.trig > 0;
    if (high && !this.ntrig) {
      this.val = 1;
      this.ntrig = true;
    } else {
      if (!high) this.ntrig = false;
      this.val *= 1 - axTimeStep(c.d, this.tick);
    }
  }

  /** Command. Hold the tick's value. */
  sample(c, ins, out) {
    out[0] = this.val;
  }
}

/**
 * `env/d lin m` (`code.krate`), factory `objects/env/d lin m.axo`. The same
 * trigger-and-fall, but the fall is a STRAIGHT LINE that stops at zero — which
 * is why it is the one to reach for when the envelope drives a pitch.
 *
 *     // once per control tick, d in SECONDS (D2) and it is the FULL duration
 *     if (trig > 0 && !ntrig) { val = 1 ; ntrig = 1 }
 *     else { if (trig <= 0) ntrig = 0 ; val -= dt/d ; if (val < 0) val = 0 }
 *     env = val
 *
 * `d` HERE IS THE WHOLE RAMP, not a time constant: their `val -= MTOF(−d)>>6`
 * against a 2^27 accumulator is exactly `LinearTimeExp` seconds from 1 to 0. On
 * the exponential siblings the same dial number is a 1/e time constant instead,
 * which is theirs, not a slip.
 *
 * Command (advances ntrig and val). Allocation-free.
 */
export class EnvDecayLinearKernel {
  /** @param {number} sampleRate - the running context's rate */
  constructor(sampleRate) {
    this.tick = axTickSeconds(sampleRate);
    this.ntrig = false;
    this.val = 0;
  }

  /** Command. One 3000 Hz control tick. */
  control(c) {
    const high = c.trig > 0;
    if (high && !this.ntrig) {
      this.val = 1;
      this.ntrig = true;
    } else {
      if (!high) this.ntrig = false;
      this.val -= axTimeStep(c.d, this.tick);
      if (this.val < 0) this.val = 0;
    }
  }

  /** Command. Hold the tick's value. */
  sample(c, ins, out) {
    out[0] = this.val;
  }
}

// ── GAIN AND MIX ────────────────────────────────────────────────────────────

/**
 * `sss/gain/vcaST` (`code.krate` + `code.srate`), contrib
 * `objects/sss/gain/vcaST.axo` by Remco van der Most — `gain/vca` widened to a
 * stereo pair, and the reason a patch uses it instead of two VCAs is that ONE
 * gain cannot drift against itself.
 *
 *     // once per control tick
 *     step = (v − prev)/16 ; g = prev ; prev = v
 *     // per sample
 *     o1 = a1·g ; o2 = a2·g ; g += step
 *
 * THE RAMP IS DELIBERATELY ONE BUFFER LATE — it interpolates from the PREVIOUS
 * tick's level to this one, so the gain lags 333 µs behind the control. R7-11
 * names this as the reference k→s ramp; omitting it is what makes a ported
 * modulated gain sound crunchy.
 *
 * Command (advances prev, gain and step). Allocation-free.
 */
export class VcaStereoKernel {
  constructor() {
    this.prev = 0;
    this.gain = 0;
    this.step = 0;
  }

  /** Command. One 3000 Hz control tick. */
  control(c) {
    this.step = (c.v - this.prev) / AX_BUFSIZE;
    this.gain = this.prev;
    this.prev = c.v;
  }

  /** Command. `ins` is [a1, a2]; `out` is [o1, o2]. */
  sample(c, ins, out) {
    out[0] = ins[0] * this.gain;
    out[1] = ins[1] * this.gain;
    this.gain += this.step;
  }
}

/**
 * `mix/xfade` (`code.krate` + `code.srate`), factory `objects/mix/xfade.axo` —
 * the THIRD of its three overloads, the one with buffer inputs and a control-rate
 * `c`, which is what our audio/number port types select.
 *
 *     // once per control tick
 *     ccompl = 1 − c
 *     // per sample
 *     o = i2·c + i1·ccompl
 *
 * A LINEAR crossfade, not an equal-power one: at c = 0.5 the sum of two
 * correlated inputs is unity and the sum of two uncorrelated ones is 3 dB down.
 * That is their `(int64)i2·c + (int64)i1·((128<<20) − c) >> 27` exactly.
 *
 * Command (latches the control-rate mix). Allocation-free.
 */
export class XfadeKernel {
  constructor() {
    this.mix = 0;
    this.compl = 1;
  }

  /** Command. One 3000 Hz control tick. */
  control(c) {
    this.mix = c.c;
    this.compl = 1 - c.c;
  }

  /** Command. `ins` is [i1, i2]. */
  sample(c, ins, out) {
    out[0] = ins[1] * this.mix + ins[0] * this.compl;
  }
}

/** `mix/mix 6` is the widest of the family, so the union node carries six. */
export const AX_MIX_CHANNELS = 6;

/**
 * `mix/mix 1` … `mix/mix 6` and their ` g` variants (`code.srate`), factory
 * `objects/mix/mix N.axo` — one node for the whole family (D9, D11), because
 * `mix N` and `mix N g` compute the same product and differ only in whether the
 * editor prints the dial as `x0.500` or as a bare number.
 *
 *     // gains latched once per control tick, each 0…1 for their dial 0…64
 *     // per sample
 *     out = clamp(bus_in + Σ in_k·gain_k, −1, 1)
 *
 * ⚠ THE OUTPUT SATURATES AT ±1.0 (D12). Their `__SSAT(…, 28)` is a HARD CLIP,
 * not the ±16 headroom the rest of frac32 has — so a mixer is the place an
 * Axoloti patch gets loud and dirty, and reproducing that is the difference
 * between a mix that sounds like theirs and one that just sums.
 * `bus_in` is added at UNITY, with no gain of its own; it is what chains one
 * mixer into the next.
 *
 * Command (latches the six gains). Allocation-free.
 */
export class MixKernel {
  constructor() {
    this.gains = new Float64Array(AX_MIX_CHANNELS);
  }

  /** Command. One 3000 Hz control tick — `param_gainN` is a k-rate value. */
  control(c) {
    this.gains[0] = c.gain1;
    this.gains[1] = c.gain2;
    this.gains[2] = c.gain3;
    this.gains[3] = c.gain4;
    this.gains[4] = c.gain5;
    this.gains[5] = c.gain6;
  }

  /** Command. `ins` is [bus_in, in1 … in6]. */
  sample(c, ins, out) {
    let accum = ins[0];
    for (let k = 0; k < AX_MIX_CHANNELS; k++) accum += ins[k + 1] * this.gains[k];
    out[0] = axSat1(accum);
  }
}

// ── DISTORTION ──────────────────────────────────────────────────────────────

/**
 * `dist/soft` (`code.srate`), factory `objects/dist/soft.axo`. Their own
 * description: `y = 1.5x − 0.5x³` inside ±1, flat outside. No oversampling and
 * no antialiasing — that is stated in the object, and it is why this is a
 * character effect rather than a transparent limiter.
 *
 *     x = clamp(in, −1, 1)
 *     out = 1.5·x − 0.5·x³
 *
 * The integer form is `ts + (ts>>1) − ___SMMUL(ts<<3, ___SMMUL(ts<<3, ts<<3))`,
 * whose scale factors work out to exactly that; the only fixed-point residue is
 * the arithmetic `>>1` flooring a negative odd value by one raw step (2^−27).
 *
 * Command (stateless, but the interface is uniform). Allocation-free.
 */
export class DistSoftKernel {
  /** Command. Pure per sample; there is no control-rate work. */
  control(c) {}

  /** Command. `ins` is [in]. */
  sample(c, ins, out) {
    out[0] = softCubic(ins[0]);
  }
}

/**
 * `dist/inf` (`code.krate`, which contains its own `for(j=0;j<BUFSIZE;j++)` loop
 * and is therefore per-sample work), factory `objects/dist/inf.axo`. INFINITE
 * gain: it discards the waveform entirely and re-synthesises a square wave from
 * the input's zero crossings, band-limited with the firmware's minBLEP table.
 * That is why it does not alias the way an infinitely steep clip otherwise must.
 *
 *     i1 = int32(in) >> 2
 *     rising  crossing: park a voice at blept[64 − 64·(−i0)/(i1 − i0)]
 *     falling crossing: park a voice at blept[64 − 64·( i0)/(i0 − i1)]
 *     i0 = i1
 *     out = Σ_v (v odd ? +blept[t_v] : −blept[t_v]) − (((next+1)&1)·2 − 1)/2
 *     every voice: t += 64, pinned at BLEP_LAST
 *
 * EIGHT VOICES, round-robin: a ninth crossing inside 32 samples steals the
 * oldest voice and clicks. Its output starts at −0.5 DC because `code.init`
 * parks every voice settled and the parity term is unbalanced there — theirs
 * does the same.
 *
 * Command (advances the voice bank, the parity counter and the previous sample).
 * Allocation-free after construction.
 */
export class DistInfKernel {
  constructor() {
    this.voices = new Int32Array(INF_BLEP_VOICES).fill(BLEP_LAST);
    this.next = 0;
    this.previous = 0;
  }

  /** Command. No control-rate work — their whole body is inside the sample loop. */
  control(c) {}

  /** Command. `ins` is [in]. */
  sample(c, ins, out) {
    const i1 = axRawFrac32(ins[0]) >> INF_INPUT_SHIFT;
    const i0 = this.previous;
    if (i1 > 0 && !(i0 > 0)) {
      this.next = (this.next + 1) & (INF_BLEP_VOICES - 1);
      this.voices[this.next] = BLEP_SUBSAMPLES - Math.trunc((-i0 * BLEP_SUBSAMPLES) / (i1 - i0));
    } else if (i1 < 0 && !(i0 < 0)) {
      this.next = (this.next + 1) & (INF_BLEP_VOICES - 1);
      this.voices[this.next] = BLEP_SUBSAMPLES - Math.trunc((i0 * BLEP_SUBSAMPLES) / (i0 - i1));
    }
    this.previous = i1;

    let sum = 0;
    for (let v = 0; v < INF_BLEP_VOICES; v++) {
      const t = this.voices[v];
      sum += (v & 1) ? blepStep(t) : -blepStep(t);
      const advanced = t + BLEP_SUBSAMPLES;
      this.voices[v] = advanced >= BLEP_LAST ? BLEP_LAST : advanced;
    }
    out[0] = sum - (((this.next + 1) & 1) * 2 - 1) * INF_PARITY_OFFSET;
  }
}

/**
 * `tiar/dist/DPSoftClip` (`code.krate` + `code.srate`), contrib
 * `objects/tiar/dist/DPSoftClip.axo` by Smashed Transistors.
 *
 *     // once per control tick, gains normalised 0…1 for their dial 0…64 (D9)
 *     drive = 4·inGain ; peak = 2·outGain
 *     // per sample
 *     u   = drive·in
 *     out = peak·softclip(u)      where softclip(u) = u(3 − u²)/2, ±1 outside
 *
 * ⚠ ITS ADVERTISED ANTIALIASING NEVER RUNS, AND THAT IS THE SOURCE'S BUG, NOT
 * OURS. See deviation D6 in this file's header for the C parse; the short form
 * is that `if(a & M != b & M)` is `(a & (M != b)) & M`, and `M`'s low bit is 0,
 * so the guard is 0 for every input that exists. The object is therefore a plain
 * aliasing cubic soft clipper, its sibling `DPHardClip` parenthesises correctly
 * and really does antialias, and the difference between the two is audible.
 * Reproduced deliberately; the `help` says so, so the label does not lie.
 *
 * Command (latches drive and peak). Allocation-free.
 */
export class DpSoftClipKernel {
  constructor() {
    this.drive = 0;
    this.peak = 0;
  }

  /** Command. One 3000 Hz control tick. */
  control(c) {
    this.drive = AX_DP_DRIVE_PER_UNIT * c.ingain;
    this.peak = AX_DP_PEAK_PER_UNIT * c.outgain;
  }

  /** Command. `ins` is [in]. */
  sample(c, ins, out) {
    out[0] = this.peak * softCubic(this.drive * ins[0]);
  }
}

/**
 * `tiar/dist/DPHardClip` (`code.krate` + `code.srate`), contrib
 * `objects/tiar/dist/DPHardClip.axo` by Smashed Transistors — a hard clipper
 * whose Differentiated Polynomial antialiasing DOES work.
 *
 *     // once per control tick
 *     drive = 4·inGain ; peak = 2·outGain
 *     // per sample
 *     x0 = drive·in ; I(x) = |x| ≤ 1 ? x²/2 : |x| − 1/2
 *     bucket changed (top 20 bits of the raw int32 input) and x0 ≠ x1 ?
 *         out = peak·(I(x0) − I(x1))/(x0 − x1)      // the MEAN of sat over the step
 *       : out = peak·clamp(x0, −1, 1)
 *
 * THE DP TRICK, in one line: `I` is the integral of the saturator, so its
 * difference quotient over one sample is the saturator's AVERAGE across that
 * sample rather than its value at the end — which is what removes most of the
 * alias energy a hard corner generates. The bucket test exists so the quotient
 * is never taken across a step too small to be meaningful.
 *
 * Command (latches drive and peak, carries one sample of history).
 * Allocation-free.
 */
export class DpHardClipKernel {
  constructor() {
    this.drive = 0;
    this.peak = 0;
    this.x1 = 0;
    this.integral1 = 0;
    this.rawPrevious = 0;
  }

  /** Command. One 3000 Hz control tick. */
  control(c) {
    this.drive = AX_DP_DRIVE_PER_UNIT * c.ingain;
    this.peak = AX_DP_PEAK_PER_UNIT * c.outgain;
  }

  /** Command. `ins` is [in]. */
  sample(c, ins, out) {
    const raw = axRawFrac32(ins[0]);
    const x0 = this.drive * ins[0];
    const magnitude = Math.abs(x0);
    const integral0 = magnitude <= 1 ? DP_HARD_I_OFFSET * magnitude * magnitude : magnitude - DP_HARD_I_OFFSET;
    // D7: `x0 !== this.x1` is ours. Their quotient is 0/0 when InGain is 0, and
    // an int32 cast of NaN is undefined behaviour; the added clause is
    // unreachable for any nonzero gain, because a bucket change means the raw
    // input differed.
    if ((raw & AX_DP_BUCKET_MASK) !== (this.rawPrevious & AX_DP_BUCKET_MASK) && x0 !== this.x1) {
      out[0] = this.peak * (integral0 - this.integral1) / (x0 - this.x1);
    } else {
      out[0] = this.peak * (x0 > 1 ? 1 : (x0 < -1 ? -1 : x0));
    }
    this.x1 = x0;
    this.integral1 = integral0;
    this.rawPrevious = raw;
  }
}
