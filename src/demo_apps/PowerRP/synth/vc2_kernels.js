/**
 * VC-2 — VCV RACK FUNDAMENTAL + CORE, PORTED TO OUR ENGINE.
 *
 * ── WHAT THIS FILE IS ───────────────────────────────────────────────────────
 * Sixteen VCV Rack modules' DSP and nothing else. No AudioNodes, no
 * AudioWorklet, no DOM: plain ES module, so `tests/port_vc2_test.js` runs every
 * recurrence in BARE NODE and measures it. `worklets/processors_vc2.js` wraps
 * each kernel in an AudioWorkletProcessor; `modules_vc2.js` wires those into
 * engine modules. Same separation, same reason as AX-2/AX-3: the arithmetic is
 * the deliverable, so the arithmetic must be reachable without a browser.
 *
 * ── THE DERIVATION RECORD (R7-17: "so we can debug shit and find flaws") ────
 * Sources, cloned READ-ONLY and read at these commits on 2026-08-06:
 *
 *   Fundamental  github.com/VCVRack/Fundamental @ 10dd0160c664770910e5584b7b00498cc48d9ddd
 *   Rack         github.com/VCVRack/Rack        @ 061ccf63c1758599396ac1bb10d47345d9d34076
 *
 * Every kernel's own docblock names its C++ FILE and FUNCTION (the registry
 * leaves that column blank on purpose), states the recurrence as ported, and
 * names its deviations. The shared `dsp::` helpers below name theirs too.
 *
 * ── L1. THE UNIT LAW (manifest § R7-UNITS, lead ruling 2026-08-06) ──────────
 * **INTERNALLY EVERY RECURRENCE BELOW IS IN RACK VOLTS**, verbatim from the C++.
 * The conversion happens at each kernel's PORT BOUNDARY, and there are exactly
 * four factors, each decided by what the quantity IS rather than by which module
 * it belongs to:
 *
 *   AUDIO AND GENERIC VOLTAGE   `volts = wire · 5`. An `audio` wire is ±1 and ±1
 *     (`VOLTS_PER_AUDIO_UNIT`)  IS ±5 Rack volts, Rack's own nominal level. THE
 *                               MEASUREMENT BEHIND THE FACTOR (and it is a
 *                               measurement, not a headcount): every
 *                               AudibleInstruments wrapper already divides its
 *                               audio input by 5 and multiplies its output by 5
 *                               around Mutable's float DSP, so ÷5 makes both of
 *                               those the identity and our wire IS that DSP's
 *                               internal float. Any other factor inserts a gain
 *                               present in neither codebase. It makes this
 *                               block's own `VCF` cancel the same way — see
 *                               `VcfKernel.sample`.
 *   LOGIC                       `gate = volts / 10`, i.e. a gate is **0…1** and
 *     (`GATE_VOLTS`)            Rack's 10 V gate is 1.0. Clause 1 is about LEVEL;
 *                               logic is not level, and 10/5 = 2.0 would sit
 *                               outside both our ±1 wire and the project's own
 *                               `gate()` bounds. The hysteresis is preserved as a
 *                               FRACTION of a gate, so it means the same thing:
 *                               fire at 20% (`TRIGGER_HIGH`), release at 1%
 *                               (`TRIGGER_LOW`). Our `audio_clock`'s 1.0 clears
 *                               that five times over.
 *   V/OCT PITCH                 `volts = semitones / 12`. A pitch port carries
 *     (`SEMITONES_PER_OCTAVE`)  SEMITONES, so an octave is 12.0 and a quantizer
 *                               step is 1.0. ORIGIN: 0 is **C4**
 *                               (`FREQ_C4` = 261.6256 Hz), NOT Axoloti's E4 —
 *                               do not reach for `core/audio_nodes.semitonesToHz`,
 *                               which is the E4 one.
 *   NORMALISED DEPTH            the wire carries the normalised quantity itself,
 *     (0…1, no factor)          so the kernel simply DROPS Rack's `/10`. This is
 *                               every CV Rack writes as `param + input/10 · trim`
 *                               and every output it writes as `10 · normalised`
 *                               (the ADSR's envelope). 0…1 is the house unit for
 *                               a depth (§ R7-UNITS clause 2), our own
 *                               `audio_adsr` emits it and our own `audio_vca`
 *                               reads it, so an envelope patched into a VCA is
 *                               unity-correct across the block boundary.
 *
 * WHY THIS BLOCK IS NOT THE VOLT-VALUED ISLAND IT FIRST SHIPPED AS: the first
 * version of this file made the wire one Rack volt so that every line transcribed
 * with no factors at all. Three sibling VCV blocks and the 34 shipped Axoloti
 * nodes had independently put full-scale audio at ±1, and a wire crossing that
 * boundary is 5× wrong IN LEVEL WITH NO ERROR — the exact silent-divergence class
 * this round exists to prevent. Three to one is not a close call, and the ruling
 * settled it; the conversions are named constants at the boundary so the
 * recurrences themselves are still the C++.
 *
 * THE OTHER THING THAT FRAMING COST, AND IT IS THE MORE INSTRUCTIVE HALF: under
 * one-volt-per-unit, a house `audio_clock`'s 1.0 gate was 1 V — BELOW Rack's 2 V
 * trigger threshold — so it did nothing at all, and the block shipped a `Rescale`
 * whose help advertised it as the ×10 adapter for that junction. The junction was
 * an artefact of the unit choice. Under R7-UNITS there is nothing to adapt, and
 * `Rescale` is what its source says it is: gain, offset and a folding limiter.
 *
 * ONE CONSEQUENCE WORTH KNOWING: `Fundamental/Delay`'s ±100 V wet clamp is ±20
 * here, and `Core/AudioInterface` is now a HALVING rather than a tenth — a ±1
 * wire is ±5 V, and Rack sends ±5 V to the sound card as ±0.5. It keeps its 6 dB
 * of headroom and its DC blocker; it is no longer load-bearing for LEVEL, and its
 * help says so rather than claiming a job it no longer has.
 *
 * ── L2. A KNOB CARRIES ITS QUANTITY'S REAL UNIT (R7-UNITS clause 2) ─────────
 * Hertz for a frequency, seconds for a time, BPM for a tempo, 0…1 for a depth,
 * semitones for an interval. Rack's own `configParam` range is kept wherever it
 * IS a real unit (every 0…1 depth, every ±1 attenuverter, Octave's ±4) and
 * INVERTED wherever it is a dial: VCF's cutoff is `C4·2^(10p−5)` hertz, Delay's
 * time is `0.001·10000^p` seconds, LFO's rate and Random's are `2^p` hertz,
 * SEQ3's tempo is `60·2^p` bpm, and the ADSR's three times are
 * `0.001·10000^p` seconds. Each inversion is one line at the top of the kernel
 * that consumes it.
 *
 * THIS FILE FIRST SHIPPED THE OTHER WAY — Rack's raw dials, on the reasoning that
 * a harvested patch's stored numbers would then transcribe unchanged — AND IT WAS
 * MEASURABLY WRONG, in the most instructive way available: five nodes in
 * `core/audio_patches_vcv_ambient.js` already set `rate: 2` on
 * `audio_vcv_random`, meaning 2 Hz, because the patch agent read the same ruling
 * and converted at harvest time. Against a log2 dial those five would have run at
 * 4 Hz. A unit disagreement between a spec and the patches written against it
 * does not fail — it detunes, silently, which is the one failure class this whole
 * round is organised around. The house library agrees with the patches
 * (`OSCILLATOR_SPEC` and `LFO_SPEC` are hertz, `ADSR_SPEC` and `DELAY_SPEC` are
 * seconds), so the dial-valued reading lost on every count.
 *
 * ── L3. A CV INPUT IS ITS OWN AudioParam, NEVER THE KNOB'S ──────────────────
 * A spec input `k` is the AudioParam `in_k`; a spec knob `k` is the AudioParam
 * `k`. They are never the same param, and the kernel combines them with the
 * module's own C++ line.
 *
 * THIS DEPARTS FROM AX-2, WHICH SUMS A KNOB AND ITS SAME-NAMED INPUT ON ONE
 * AudioParam, and the departure is forced rather than stylistic: **no Fundamental
 * module ever adds a knob to a CV in the same units.** Every one of them writes
 * `param + input/10 · trim` (a modulation) or `param + input` in the PITCH domain
 * (a V/oct), and `trim` is an attenuverter the patch file SETS. Summing on one
 * AudioParam would hard-code `trim = 1`, delete every attenuverter row, and make
 * a V/oct input arrive ten times too small. Web Audio cannot scale a connection,
 * so the trim has to be applied inside the kernel, so the CV has to arrive on its
 * own param. One law, sixteen modules, no exceptions.
 *
 * A CONSEQUENCE WORTH STATING: Rack 2's `configParam` default for every
 * attenuverter is **0**, so a freshly-dropped ADSR ignores its CV inputs until
 * you raise the trim. That is faithful (`paramsFromJson` only sets 1 when
 * loading a pre-2.0 patch), it is what a Rack user meets, and every such knob's
 * help says it. It is not an inert control — the trim is the control.
 *
 * ── L4. A CLOCK DIVIDER IS PART OF THE SOUND ────────────────────────────────
 * `dsp::ClockDivider` runs a block at sampleRate/N. ADSR computes its lambdas on
 * a divider of 16; the divisor is ported, not removed. Running it every sample
 * "for accuracy" changes what a fast envelope CV does, which is the R7-11 trap in
 * its VCV form.
 *
 * ── DELIBERATE DEVIATIONS, ALL OF THEM, NAMED ───────────────────────────────
 *
 * D1. THE RNG IS SEEDED AND OURS. Rack's `random::uniform`/`random::normal` are
 *     xoroshiro128+ seeded from `std::random_device` at startup, so THEIR noise
 *     is not reproducible between two runs of the same patch. Ours is a
 *     mulberry32 with a `seed` knob (`Vc2Rng`), plus Marsaglia polar for
 *     `normal()`. The DISTRIBUTIONS are identical — uniform on [0,1), unit
 *     normal — which is all any consumer here reads; the SEQUENCE differs, and
 *     it must, because the determinism law (`<app>/CLAUDE.md`, "the three kinds
 *     of state") is not negotiable and their behaviour violates it. Same ruling
 *     as AX-2's D4.
 * D2. `simd::` IS SCALAR HERE. Rack runs four polyphony channels per `float_4`.
 *     Our wires are mono, so every loop is `channels = 1` and the SIMD wrapper
 *     is dropped. This changes nothing arithmetically (float_4 is four floats)
 *     and it is why `getPolyVoltage` collapses to `getVoltage`.
 * D3. POLYPHONY IS NOT PORTED, AND MERGE/SPLIT THEREFORE DO NOT EXIST. A Rack
 *     cable carries up to 16 channels; ours carries one, and an input accepts at
 *     most one source (`core/nodeflow.js`: "An input accepts AT MOST ONE
 *     source"). On a MONO cable `Merge` and `Split` are the IDENTITY — measured
 *     in the C++: Split's body is `outputs[MONO_OUTPUTS+c].setVoltage(
 *     inputs[POLY_INPUT].getVoltage(c))`, which for one channel is a
 *     pass-through, and Merge with one connected input emits a one-channel
 *     cable. So they are patch STRUCTURE, not nodes: a poly Rack patch unrolls
 *     into N parallel mono chains, and the unrolled form contains neither. Sum
 *     survives the unrolling as a real node (16 mono inputs), because summing is
 *     arithmetic rather than plumbing.
 * D4. THE DELAY'S SINC RESAMPLER IS A LINEAR ONE. `Fundamental/Delay` chases its
 *     target delay with libsamplerate at `SRC_SINC_FASTEST`. The CHASE — ratio
 *     `4^clamp(consume/10000, ±1)` — is ported exactly, because that ratio is
 *     what makes sweeping the time knob pitch-bend the repeats; the
 *     INTERPOLATION under it is linear, not windowed-sinc. Cost: images above
 *     ~0.4·Nyquist while the delay is moving, none once it settles (at ratio 1
 *     the read pointer is integral and the interpolator is bypassed exactly).
 * D5. GRAY NOISE IS NOT PORTED. `Fundamental/Noise`'s gray output runs white
 *     through a 1024-point `dsp::RealFFT` (pffft), scales each bin by an
 *     inverse-A-weighting curve and inverse-transforms. The CURVE is in the
 *     source and is trivial; the BIN PACKING is not — the loop reads
 *     `freqBuffer[2i]`/`[2i+1]` for i < 1024 out of a 2048-float buffer, which
 *     is pffft's own ordered layout, and pffft is not in either pinned
 *     repository. Approximating it would claim a fidelity we cannot measure, so
 *     the output is omitted and said out loud. Same ruling as AX-2's D8.
 * D6. THE AUDIO INTERFACE IS MONO. Rack's `Audio-2` has L and R jacks and
 *     normals R from L when R is unpatched. Our ports are mono, so only the
 *     L/MONO jack exists — which IS the normalled case — and a patch's R jack is
 *     dropped. Recorded per patch as a substitution.
 * D7. LIGHTS, VU METERS AND `ChannelDisplay`s ARE DROPPED. Cosmetic furniture is
 *     not a node (R7-17-SEL). Every `lightDivider` block, `dsp::VuMeter2` and
 *     channel-count readout is absent; our `audio_meter` is the meter. Nothing
 *     they compute feeds a signal path — checked module by module.
 * D8. `Fundamental/VCF`'s SELF-OSCILLATION BOOTSTRAP IS SEEDED. Its input gets
 *     `1e-6·(2·random::uniform() − 1)` to kick the ladder into self-oscillation
 *     at full resonance. Kept (it is load-bearing: without it a silent input
 *     never starts ringing) but drawn from `Vc2Rng`, per D1.
 * D9. AN EXTRA `seed` KNOB EXISTS ON EVERY RNG-READING MODULE (Noise, Random,
 *     VCF). Rack has no such knob because it has no such need. Construct-time,
 *     as AX-2's is.
 * D10. `isConnected()` IS REPLACED BY AN ASSUMED-DEPTH KNOB AND A FIRST-EDGE
 *     LATCH. It has a section of its own below, immediately before
 *     `AudioInterfaceKernel`, because it is the only deviation that changes a
 *     module's CONTROL SURFACE rather than its arithmetic.
 * D11. THE QUANTIZER'S SCALE MASK IS AN INTEGER KNOB, not twelve booleans and not
 *     a named-scale dropdown. Their panel is twelve clickable piano keys, which is
 *     a nicer gesture and CANNOT BE SWEPT BY AN EQUATION; a 12-bit number can
 *     (`= 2741` is a major scale, `= floor(time) % 4096` is a scale that walks).
 *     Same reasoning and same precedent as AX-2's D6, which made an LFSR
 *     polynomial an integer for the same reason. The `help` names the useful
 *     values so the number is not a puzzle.
 *
 * Every kernel is a class with `sample(c, ins, out)` — a COMMAND (it advances
 * its own state), allocation-free because it runs on the audio thread. There is
 * no `control()` half: Rack's `process()` is sample-rate throughout, and the
 * modules that divide internally own their own counters (L4).
 */

// ── RACK'S UNITS AND CONSTANTS, AS RACK STATES THEM ─────────────────────────

/** `dsp::FREQ_C4` (Rack `include/dsp/common.hpp:17`). Middle C, and the origin
 *  of every V/oct in the library: `hz = FREQ_C4 · 2^volts`. */
export const FREQ_C4 = 261.6256;

/** LAW L1's audio factor: ±1 on a wire is ±5 Rack volts. Every voltage-domain
 *  port multiplies by this on the way in and divides by it on the way out. */
export const VOLTS_PER_AUDIO_UNIT = 5;

/** LAW L1's pitch factor: a V/oct port carries SEMITONES, so an octave is 12.
 *  (Also the divisor in `Octave`'s and `Quantizer`'s own arithmetic.) */
const SEMITONES_PER_OCTAVE = 12;

/**
 * Pure function. Hertz for a V/oct port's value, with Rack's C4 origin —
 * `hz = FREQ_C4 · 2^(semitones/12)`.
 *
 * NOT `core/audio_nodes.semitonesToHz`, WHICH IS A DIFFERENT FUNCTION: that one
 * is Axoloti's E4 origin (pitch 0 = 329.6276 Hz) and using it for a VCV pitch
 * would read every note a minor third sharp. Two libraries, two origins, and the
 * only defence is that each has its own converter with the origin in its name.
 *
 * @param {number} semitones - a V/oct port's value
 * @returns {number} hertz
 *
 * @example semitonesToHzC4(0) // 261.6256
 * @example semitonesToHzC4(12) // 523.2512
 * @example Math.round(semitonesToHzC4(9)) // 440
 */
export function semitonesToHzC4(semitones) {
  return FREQ_C4 * 2 ** (semitones / SEMITONES_PER_OCTAVE);
}

/**
 * ── L1's FOURTH CLAUSE: LOGIC IS NOT LEVEL (lead ruling, 2026-08-06) ────────
 * A `gate`/`trigger` port carries **0…1**, not volts ÷ 5. Rack's gate is 10 V,
 * and 10/5 would be 2.0 — outside our `audio` wire's ±1 and outside the
 * project's own `gate()` declaration of `min 0, max 1`, which predates this
 * block. So the LOGIC domain normalises to the GATE (÷10) while the LEVEL domain
 * normalises to ±5 V (÷5), and the two are different facts about different
 * quantities rather than one factor applied inconsistently.
 *
 * The hysteresis is preserved as a FRACTION OF A GATE, which is what makes it
 * mean the same thing: Rack fires at 2 V of a 10 V gate (20%) and releases at
 * 0.1 V (1%), so ours fires at 0.2 and releases at 0.01. A house `audio_clock`
 * emits 1.0 and clears that five times over.
 */
export const GATE_VOLTS = 10;
export const GATE_HIGH = 1;
export const TRIGGER_LOW = 0.1 / GATE_VOLTS;
export const TRIGGER_HIGH = 2 / GATE_VOLTS;

/** A unipolar CV's full scale IN VOLTS. Present because a few call sites still
 *  need the number itself (the Audio module's `/10`, and `Random`'s
 *  `10·uniform − 5` value draw); the CV INPUTS do not use it, because law L1
 *  makes a normalised CV arrive already divided. */
export const CV_FULL_SCALE_VOLTS = 10;

/** Rack's polyphony maximum (`engine::PORT_MAX_CHANNELS`). Only `Sum` still
 *  needs it: its one poly input unrolls into this many mono ports (D3). */
export const MAX_CHANNELS = 16;

// ── RACK'S `dsp::` AND `math::` HELPERS, PORTED ─────────────────────────────

/**
 * Pure function. Rack `math::clamp` (`include/math.hpp`).
 *
 * @param {number} x
 * @param {number} low
 * @param {number} high
 * @returns {number}
 *
 * @example clamp(1.5, 0, 1) // 1
 * @example clamp(-0.2, 0, 1) // 0
 * @example clamp(0.25, 0, 1) // 0.25
 */
export function clamp(x, low, high) {
  return Math.max(Math.min(x, high), low);
}

/**
 * Pure function. Rack `math::rescale` — maps `x` from [xMin, xMax] onto
 * [yMin, yMax] WITHOUT clamping, which is why `SequentialSwitch` can use it to
 * shift a Schmitt trigger's thresholds.
 *
 * @param {number} x
 * @param {number} xMin
 * @param {number} xMax
 * @param {number} yMin
 * @param {number} yMax
 * @returns {number}
 *
 * @example rescale(2, 0.1, 2, 0, 1) // 1
 * @example rescale(0.1, 0.1, 2, 0, 1) // 0
 * @example rescale(5, 0, 10, -1, 1) // 0
 */
export function rescale(x, xMin, xMax, yMin, yMax) {
  return yMin + (x - xMin) / (xMax - xMin) * (yMax - yMin);
}

/**
 * Pure function. Rack `math::crossfade` — `a` at p = 0, `b` at p = 1.
 *
 * @param {number} a
 * @param {number} b
 * @param {number} p
 * @returns {number}
 *
 * @example crossfade(0, 10, 0.25) // 2.5
 * @example crossfade(-1, 1, 1) // 1
 */
export function crossfade(a, b, p) {
  return a + (b - a) * p;
}

/**
 * Pure function. Rack `math::eucMod` — a modulo whose result takes the sign of
 * the DIVISOR, unlike JS `%`. The Quantizer's note-mask lookup depends on it:
 * `eucMod(-1, 12)` must be 11, and `-1 % 12` is `-1`.
 *
 * @param {number} a
 * @param {number} b
 * @returns {number}
 *
 * @example eucMod(-1, 12) // 11
 * @example eucMod(13, 12) // 1
 * @example // and the behaviour it exists to avoid: -1 % 12 is -1, not 11
 * @example -1 % 12 // -1
 */
export function eucMod(a, b) {
  const mod = a % b;
  return mod < 0 ? mod + b : mod;
}

/**
 * Pure function. Rack `math::eucDiv` — the division that pairs with `eucMod`,
 * flooring toward −∞ so that `eucDiv(a,b)·b + eucMod(a,b) === a` for negative
 * `a`. This is how the Quantizer separates an octave from a scale degree below
 * 0 V.
 *
 * @param {number} a
 * @param {number} b
 * @returns {number}
 *
 * @example eucDiv(-1, 24) // -1
 * @example eucDiv(25, 24) // 1
 * @example eucDiv(-1, 24) * 24 + eucMod(-1, 24) // -1
 */
export function eucDiv(a, b) {
  return Math.floor(a / b);
}

/**
 * Pure function. Rack `dsp::exp2_taylor5` (`include/dsp/approx.hpp:118`) — 2^x
 * as an exact power-of-two times a degree-5 Horner polynomial in the fractional
 * part, and the function EVERY pitch in this block goes through (VCF, LFO,
 * Delay, Random, SEQ3).
 *
 * PORTED RATHER THAN REPLACED BY `Math.pow(2, x)`, and the reason is the
 * MEASUREMENT rather than a principle: over the whole pitch span a knob can
 * reach (−8…10 octaves) its worst deviation from an exact 2^x is **0.00016
 * cents**, at x = 5.74 — six thousand times finer than the 1-cent floor of
 * audibility, and exact at every integer octave. So substituting `Math.pow`
 * would in fact have been inaudible; it is ported anyway because "inaudible" is
 * a claim that has to be re-measured every time someone wonders, and the
 * transcription costs six coefficients. `exp2Floor`'s bit trick is expressed as
 * `2 ** (xi - FLOAT_EXPONENT_BIAS)`, which is the same number by definition.
 *
 * @param {number} x
 * @returns {number} approximately 2^x
 *
 * @example exp2Taylor5(0) // 1
 * @example exp2Taylor5(1) // 2
 * @example Math.abs(exp2Taylor5(0.5) - Math.SQRT2) < 2e-7 // true
 */
export function exp2Taylor5(x) {
  const biased = x + FLOAT_EXPONENT_BIAS;
  const xi = Math.trunc(biased);
  const xf = biased - xi;
  let y = EXP2_TAYLOR5_COEFFICIENTS[EXP2_TAYLOR5_COEFFICIENTS.length - 1];
  for (let n = EXP2_TAYLOR5_COEFFICIENTS.length - 2; n >= 0; n--) {
    y = EXP2_TAYLOR5_COEFFICIENTS[n] + y * xf;
  }
  return 2 ** (xi - FLOAT_EXPONENT_BIAS) * y;
}

/** IEEE-754 single-precision exponent bias — the `x += 127` in `exp2Floor`,
 *  which is what makes the following truncation a floor for any pitch a knob
 *  can reach. */
const FLOAT_EXPONENT_BIAS = 127;

/** `exp2_taylor5`'s coefficients, verbatim from `approx.hpp:122-129`. */
const EXP2_TAYLOR5_COEFFICIENTS = [
  1.0, 0.69315169353961, 0.2401595990753, 0.055817908652, 0.008991698010, 0.001879100722,
];

/**
 * Pure function. Rack `dsp::tanhXdX_4_6` (`Fundamental/src/VCF.cpp`) — the
 * degree (4,6) rational approximation of `tanh(x)/x`, max relative error
 * 4.2e-6 on [−4, 4], approaching 0 beyond it.
 *
 * THIS IS THE LADDER'S NONLINEARITY and it is used three ways in one filter:
 * as the input saturator (`tanhXdX(u)·u`), as each stage's tanh SLOPE
 * (linearisation about the previous output — Mystran's trick), and as the output
 * soft-clip (`v·tanhXdX(v/2)` = `2·tanh(v/2)`).
 *
 * @param {number} x
 * @returns {number} approximately tanh(x)/x
 *
 * @example tanhXdX46(0) // 1
 * @example Math.abs(tanhXdX46(1) - Math.tanh(1)) < 1e-5 // true
 * @example Math.abs(tanhXdX46(2) * 2 - Math.tanh(2)) < 1e-4 // true
 */
export function tanhXdX46(x) {
  const x2 = x * x;
  const num = 1 + x2 * (0.121953514066257 + x2 * 0.00204623480007919);
  const den = 1 + x2 * (0.455305674254515 + x2 * (0.0204552909446164 + x2 * 9.48027717633287e-5));
  return num / den;
}

/**
 * Pure function. Rack `dsp::tan_3_4` (`Fundamental/src/VCF.cpp`) — the degree
 * (3,4) rational approximation of `tan(x)` on (−π/2, π/2), max relative error
 * 2.8e-5, used for the ladder's bilinear prewarp.
 *
 * @param {number} x
 * @returns {number} approximately tan(x)
 *
 * @example tan34(0) // 0
 * @example Math.abs(tan34(Math.PI / 4) - 1) < 1e-4 // true
 * @example Math.abs(tan34(0.1) - Math.tan(0.1)) < 1e-6 // true
 */
export function tan34(x) {
  const x2 = x * x;
  const num = 1 + x2 * -0.09776575533683811;
  const den = 1 + x2 * (-0.43119539396382 + x2 * 0.0105011966117302);
  return x * num / den;
}

/**
 * A SEEDED replacement for Rack's `random::` namespace — deviation D1.
 *
 * Command (every call advances the state). mulberry32 for `uniform()`, Marsaglia
 * polar for `normal()`; the polar method's spare value is cached, which is why
 * `normal()` is the one method whose cost alternates.
 *
 * `uniform()`'s image is [0, 1), matching `random::get<float>()`'s documented
 * image, so a consumer that multiplies by 10 and subtracts 5 spans [−5, 5) here
 * exactly as it does there.
 */
export class Vc2Rng {
  /** @param {number} seed - the `seed` knob; any integer */
  constructor(seed = 0) {
    this.state = (seed | 0) >>> 0;
    this.spare = 0;
    this.hasSpare = false;
  }

  /** Command. A uniform float in [0, 1). */
  uniform() {
    this.state = (this.state + MULBERRY32_INCREMENT) >>> 0;
    let z = this.state;
    z = Math.imul(z ^ (z >>> 15), z | 1);
    z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
    return ((z ^ (z >>> 14)) >>> 0) / 2 ** 32;
  }

  /** Command. A unit normal deviate (mean 0, variance 1). */
  normal() {
    if (this.hasSpare) {
      this.hasSpare = false;
      return this.spare;
    }
    let u = 0;
    let v = 0;
    let s = 0;
    do {
      u = this.uniform() * 2 - 1;
      v = this.uniform() * 2 - 1;
      s = u * u + v * v;
    } while (s >= 1 || s === 0);
    const scale = Math.sqrt(-2 * Math.log(s) / s);
    this.spare = v * scale;
    this.hasSpare = true;
    return u * scale;
  }
}

/** mulberry32's odd increment. Any odd constant gives full period; this is the
 *  published one. */
const MULBERRY32_INCREMENT = 0x6d2b79f5;

/**
 * Rack `dsp::SchmittTrigger` (`include/dsp/digital.hpp:83`), ported with its
 * THREE-state machine intact — UNINITIALIZED is not LOW, and that is why a
 * patch whose clock starts already high does not fire on its first sample.
 *
 * Command. `process(v, low, high)` returns true on a LOW→HIGH crossing only.
 */
export class SchmittTrigger {
  constructor() {
    this.state = SCHMITT_UNINITIALIZED;
  }

  /** Command. Feed one sample; true exactly on the rising crossing. */
  process(value, low = 0, high = 1) {
    if (this.state === SCHMITT_LOW && value >= high) {
      this.state = SCHMITT_HIGH;
      return true;
    }
    if (this.state === SCHMITT_HIGH && value <= low) {
      this.state = SCHMITT_LOW;
      return false;
    }
    if (this.state === SCHMITT_UNINITIALIZED && value >= high) this.state = SCHMITT_HIGH;
    else if (this.state === SCHMITT_UNINITIALIZED && value <= low) this.state = SCHMITT_LOW;
    return false;
  }

  /** Query. Is the trigger currently latched high? (`isHigh()`, which SEQ3's
   *  clock passthrough reads.) */
  isHigh() {
    return this.state === SCHMITT_HIGH;
  }
}

const SCHMITT_UNINITIALIZED = 0;
const SCHMITT_LOW = 1;
const SCHMITT_HIGH = 2;

/**
 * Rack `dsp::PulseGenerator` (`digital.hpp:167`). Command. `trigger(t)` arms it
 * for `t` seconds; `process(dt)` decrements and returns whether it is still
 * high. Fundamental arms it with 1e-3 everywhere, which is `PULSE_SECONDS`.
 */
export class PulseGenerator {
  constructor() {
    this.remaining = 0;
  }

  /** Command. Arm for `duration` seconds, extending an in-flight pulse. */
  trigger(duration = PULSE_SECONDS) {
    if (duration > this.remaining) this.remaining = duration;
  }

  /** Command. Advance by `deltaTime`; true while the pulse is high. */
  process(deltaTime) {
    if (this.remaining <= 0) return false;
    this.remaining -= deltaTime;
    return true;
  }

  /** Query. Is the pulse high, without advancing it? */
  isHigh() {
    return this.remaining > 0;
  }
}

/** The one pulse width Fundamental ever arms: `1e-3f` seconds. */
export const PULSE_SECONDS = 1e-3;

/**
 * Rack `dsp::Timer` (`digital.hpp:200`) — accumulates `deltaTime`, and is how
 * every module in this block MEASURES an external clock's period. Command.
 */
export class Timer {
  constructor() {
    this.time = 0;
  }

  /** Command. Advance and return the accumulated time. */
  process(deltaTime) {
    this.time += deltaTime;
    return this.time;
  }

  /** Command. Back to zero. */
  reset() {
    this.time = 0;
  }
}

/**
 * Rack `dsp::ClockDivider` (`digital.hpp:228`) — L4's mechanism. Command:
 * `process()` returns true every `division` calls.
 */
export class ClockDivider {
  /** @param {number} division - calls per true */
  constructor(division) {
    this.division = division;
    this.clock = 0;
  }

  /** Command. Count one call; true on every `division`-th. */
  process() {
    this.clock++;
    if (this.clock >= this.division) {
      this.clock = 0;
      return true;
    }
    return false;
  }
}

/**
 * Rack `dsp::TRCFilter` (`include/dsp/filter.hpp:14`) — the one-pole RC pair
 * that gives the Delay its tone control and the Audio module its DC block.
 *
 * Command. `setCutoffFreq(f)` takes f as a RATIO of the sample rate (that is
 * Rack's convention and the reason every call site divides by `sampleRate`);
 * `process(x)` advances; `lowpass()`/`highpass()` read the same step's two
 * outputs. The recurrence, verbatim:
 *
 *   c = 2/(2π·f);  y = (x + x[n−1] − y[n−1]·(1 − c)) / (1 + c)
 *   lowpass = y;   highpass = x[n−1] − y
 */
export class RcFilter {
  constructor() {
    this.c = 0;
    this.xstate = 0;
    this.ystate = 0;
  }

  /** Command. Cutoff as an ANGULAR frequency in radians (`setCutoff`). */
  setCutoff(r) {
    this.c = 2 / r;
  }

  /** Command. Cutoff as a fraction of the sample rate (`setCutoffFreq`). */
  setCutoffFreq(f) {
    this.setCutoff(2 * Math.PI * f);
  }

  /** Command. Advance one sample. */
  process(x) {
    const y = (x + this.xstate - this.ystate * (1 - this.c)) / (1 + this.c);
    this.xstate = x;
    this.ystate = y;
  }

  /** Query. The lowpass output of the last `process`. */
  lowpass() {
    return this.ystate;
  }

  /** Query. The highpass output of the last `process`. NOTE it is
   *  `x[n−1] − y`, not `x − y`: their state shift happens first. */
  highpass() {
    return this.xstate - this.ystate;
  }
}

/**
 * Rack `dsp::TSlewLimiter` (`filter.hpp:133`) — a LINEAR rate limiter in
 * units/second, not an exponential one. `SequentialSwitch`'s de-click uses it at
 * 400 Hz rise and fall, i.e. a channel's gain takes 1/400 s to cross 0…1.
 *
 * Command. `out = clamp(in, out − fall·dt, out + rise·dt)`.
 */
export class SlewLimiter {
  /** @param {number} rise - units per second upward
   *  @param {number} fall - units per second downward */
  constructor(rise, fall) {
    this.rise = rise;
    this.fall = fall;
    this.out = 0;
  }

  /** Command. Advance toward `input` and return the new output. */
  process(deltaTime, input) {
    this.out = clamp(input, this.out - this.fall * deltaTime, this.out + this.rise * deltaTime);
    return this.out;
  }
}

/**
 * Rack `dsp::IIRFilter<2,2>` (`filter.hpp:196`) as `Fundamental/Noise` uses it:
 * two `b` taps, one `a` tap. Command.
 *
 *   y = b0·x + b1·x[n−1] − a1·y[n−1]
 */
export class Iir22 {
  /** @param {number[]} b - [b0, b1]
   *  @param {number[]} a - [a1] */
  constructor(b, a) {
    this.b = b;
    this.a = a;
    this.x = 0;
    this.y = 0;
  }

  /** Command. Advance one sample and return the output. */
  process(input) {
    const out = this.b[0] * input + this.b[1] * this.x - this.a[0] * this.y;
    this.x = input;
    this.y = out;
    return out;
  }
}

/**
 * ── D10. WHAT REPLACES `isConnected()`, AND WHY IT NEEDED REPLACING ─────────
 *
 * Half of Fundamental branches on whether a jack has a cable in it: VCA-1's gain
 * is `level` alone when its CV jack is EMPTY and `level · cv/10` when it is not;
 * Delay's and LFO's clock rate is 2 Hz when unpatched and measured when patched.
 * Our engine cannot answer that question — a module receives AudioParams, and an
 * unwired param is not "absent", it reads its intrinsic value. Reproducing
 * VCA-1 literally would therefore make an unwired VCA SILENT (cv = 0 → gain 0),
 * which is a dead patch with nothing to explain it.
 *
 * Two mechanisms, both stated as deviations rather than hidden:
 *
 * 1. AN ASSUMED-DEPTH KNOB. Every CV input whose Rack semantics branch on
 *    `isConnected` gets a companion knob of the same key, defaulting to the value
 *    that reproduces the UNCONNECTED branch — 1, i.e. unity, i.e. Rack's own 10 V
 *    in the normalised unit law L1 gives that port. The kernel adds knob + wire,
 *    so: unwired plays the unconnected
 *    branch exactly, and wiring a CV with the knob at 0 plays the connected
 *    branch exactly. This is the same convention DING_SPEC's `frequency` already
 *    documents ("wire a sequencer in … so set it to 0 to hear the sequence as
 *    written"), applied to a jack Rack would have sensed instead.
 *
 * 2. FIRST-EDGE LATCHING for a CLOCK jack. A clock input counts as patched once
 *    it has ever crossed the trigger threshold. An unwired clock never crosses
 *    it, so the internal-rate branch runs forever — faithful. A wired clock runs
 *    the internal branch until its first edge and the external branch after —
 *    which differs from Rack for exactly one clock period, and only for a clock
 *    that is patched but has not yet ticked.
 *
 * Where the branch is a MODE rather than a level (Random's EXTERNAL jack selects
 * whether the module generates or samples), it becomes an explicit discrete knob
 * instead of either mechanism, because a mode that is inferred is a mode nobody
 * can see.
 */

/**
 * `Core/AudioInterface` — RACK'S 6 dB OF HEADROOM, AND ITS DC BLOCKER.
 *
 * DERIVATION: Rack `src/core/Audio.cpp`, `Audio<2,2>::process` (the `Audio-2`
 * specialisation, `NUM_AUDIO_INPUTS == 2`), read at 061ccf6. The recurrence, and
 * it is three lines because that is all the module does to a sample:
 *
 *   v = getVoltageSum() / 10                     ← the whole voltage conversion
 *   if (dcFilterEnabled) { dc.process(v); v = dc.highpass() }   ← 10 Hz, 1-pole
 *   v *= level²                                  ← Audio-2's knob only
 *
 * `dcFilters[i].setCutoffFreq(10.f * sampleTime)` is the cutoff, so it tracks
 * the sample rate; `onReset` enables the filter for `Audio-2` and disables it
 * for the 8- and 16-channel variants, which is why the knob defaults ON here.
 *
 * WHY THIS IS STILL A NODE, AND WHAT CHANGED ABOUT THE ANSWER.
 * `.frenzy/round7/NODE_REGISTRY.md` marks the row `chrome` and maps it to our
 * `audio_output`, on the ground that a device layer is not DSP. The device layer
 * IS dropped — no driver, no sample-rate converter, no ring buffer, no device
 * inputs. What remains is two things that are not chrome:
 *
 *   • **6 dB OF HEADROOM.** Rack sends a nominal ±5 V to the sound card as ±0.5,
 *     deliberately. Under R7-UNITS a ±1 wire IS ±5 V, so this module HALVES;
 *     under this block's first (overruled) volt-valued scheme it was the whole
 *     `/10` and was load-bearing for level. It no longer is, and saying so is the
 *     point — a node whose help claims a job it lost is the manifest's
 *     worst-measured defect class.
 *   • **THE DC BLOCKER**, which nothing else in the block has and which a
 *     wavefolder or an offset CV really does need.
 *
 * So: patch it before our `audio_output` when a patch wants Rack's own headroom
 * and DC behaviour, and leave it out when you want the full ±1. Our
 * `audio_output` is the sound card either way, which is what it already was.
 *
 * DEVIATIONS: D6 (mono — only the L/MONO jack, which is Rack's own normalled
 * case), D7 (no VU meter, no clip lights).
 */
export class AudioInterfaceKernel {
  /** @param {number} sampleRate */
  constructor(sampleRate) {
    this.dcFilter = new RcFilter();
    this.dcFilter.setCutoffFreq(DC_FILTER_HZ / sampleRate);
  }

  /**
   * Command. One sample: volts in, our ±1 audio out.
   *
   * @param {object} c - controls: `level`, `dcFilter`
   * @param {ArrayLike<number>} ins - [audio1] in volts
   * @param {Float64Array} out - [out] in our audio units
   */
  sample(c, ins, out) {
    let v = ins[0] * VOLTS_PER_AUDIO_UNIT / CV_FULL_SCALE_VOLTS;
    if (c.dcFilter >= 0.5) {
      this.dcFilter.process(v);
      v = this.dcFilter.highpass();
    }
    out[0] = v * (c.level * c.level);
  }
}

/** `Audio.cpp`'s DC blocker corner: `setCutoffFreq(10.f * sampleTime)`. */
const DC_FILTER_HZ = 10;

/**
 * `Fundamental/VCA` — the level-and-CV amplifier, both generations in one node.
 *
 * DERIVATION: `Fundamental/src/VCA-1.cpp`, `VCA_1::process` (the modern module),
 * plus `Fundamental/src/VCA.cpp`, `VCA::processChannel` (deprecated, and the
 * source of the third response law). Read at 10dd016.
 *
 *   VCA-1:  cv = clamp(in_cv/10, 0, 1);  if (exponential) cv = cv⁴
 *           out = in · level · cv
 *   VCA:    cv = clamp(in_cv/10, 0, 1)
 *           out = in · level · rescale(50^cv, 1, 50, 0, 1)     ← the EXP jack
 *
 * The registry row absorbs both raw objects, so both laws are options rather
 * than one being dropped: `exp4` is VCA-1's context-menu "Exponential response",
 * `exp50` is old VCA's dedicated exponential input, and they are audibly
 * different curves (exp4 is gentle near unity, exp50 is a 34 dB taper).
 *
 * DEVIATION D10: the `cv` knob is the assumed jack voltage, 10 V by default, so
 * an unwired VCA passes `level` exactly as Rack's `isConnected` branch does.
 */
export class VcaKernel {
  constructor() {
    this.response = "linear";
  }

  /** Command. Set the response law. LOUD on an unknown name — a VCA that
   *  silently kept the old curve is the failure this project forbids. */
  setResponse(value) {
    if (!VCA_RESPONSES.includes(value)) {
      throw new Error(`VCA response must be one of ${VCA_RESPONSES.join(", ")}; got ${JSON.stringify(value)}`);
    }
    this.response = value;
  }

  /**
   * Command. One sample.
   *
   * @param {object} c - controls: `level`, `cv` (assumed jack volts), `in_cv`
   * @param {ArrayLike<number>} ins - [in]
   * @param {Float64Array} out - [out]
   */
  sample(c, ins, out) {
    let cv = clamp(c.cv + c.in_cv, 0, 1);
    if (this.response === "exp4") cv = cv * cv * cv * cv;
    else if (this.response === "exp50") cv = rescale(VCA_EXP_BASE ** cv, 1, VCA_EXP_BASE, 0, 1);
    out[0] = ins[0] * c.level * cv;
  }
}

/** The three response laws, in the order the spec lists them. */
export const VCA_RESPONSES = ["linear", "exp4", "exp50"];

/** Old `VCA.cpp`'s `const float expBase = 50.f`. */
const VCA_EXP_BASE = 50;

/**
 * `Fundamental/Octave` — the V/oct transposer, and EXACT-INTEGER by contract.
 *
 * DERIVATION: `Fundamental/src/Octave.cpp`, `Octave::process`, read at 10dd016.
 *
 *   octave = round(shift) + round(in_octave)      ← two SEPARATE roundings
 *   out    = in_pitch + octave
 *
 * THE TWO ROUNDINGS ARE NOT ONE. Rack rounds the knob and the CV independently
 * (`octaveParam` is `std::round`ed once per block, the CV per channel), so a
 * knob at +1 and a CV at 0.5 V give +2 octaves — `round(1) + round(0.5)` — where
 * a single rounding of the sum would give +1. Getting this wrong is a whole
 * octave, silently, on the exact patch that automates the CV.
 *
 * `Math.round` matches `std::round`'s half-away-from-zero for every value a knob
 * or a CV can carry here (both differ from `Math.round` only for negative
 * halves, where `std::round(-0.5) = -1` and `Math.round(-0.5) = -0`; ported
 * exactly by `roundHalfAwayFromZero` below).
 */
export class OctaveKernel {
  /**
   * Command. One sample.
   *
   * @param {object} c - controls: `octave` (the knob, whole octaves), `in_octave`
   * @param {ArrayLike<number>} ins - [] (pitch arrives as a param, see the spec)
   * @param {Float64Array} out - [pitch] in volts
   */
  sample(c, ins, out) {
    const octave = roundHalfAwayFromZero(c.octave)
      + roundHalfAwayFromZero(c.in_octave / SEMITONES_PER_OCTAVE);
    out[0] = c.in_pitch + octave * SEMITONES_PER_OCTAVE;
  }
}

/**
 * Pure function. C's `std::round`: halves go AWAY from zero, where JS's
 * `Math.round` sends them toward +∞.
 *
 * @param {number} x
 * @returns {number}
 *
 * @example roundHalfAwayFromZero(0.5) // 1
 * @example roundHalfAwayFromZero(-0.5) // -1
 * @example // the difference this exists for: JS rounds a negative half UP
 * @example Math.round(-0.5) // -0
 * @example roundHalfAwayFromZero(-1.4) // -1
 */
export function roundHalfAwayFromZero(x) {
  return x < 0 ? -Math.round(-x) : Math.round(x);
}

/**
 * `Fundamental/Quantizer` — a 12-note scale mask over V/oct, EXACT-INTEGER.
 *
 * DERIVATION: `Fundamental/src/Quantizer.cpp`, `Quantizer::process` and
 * `Quantizer::updateRanges`, read at 10dd016.
 *
 *   updateRanges():  for each of 24 half-semitone ranges i, ranges[i] is the
 *                    ENABLED note (searched over −12…24) minimising
 *                    |(i+1)/2 − note|, with an early break as soon as the
 *                    distance stops decreasing, and the mask IGNORED entirely
 *                    when no note is enabled
 *   process():       range  = floor((in + offset) · 24)
 *                    octave = eucDiv(range, 24);  range −= octave·24
 *                    note   = ranges[range] + octave·12
 *                    out    = note / 12
 *
 * WHY THE SEARCH IS PORTED AND NOT REPLACED BY "NEAREST ENABLED SEMITONE": the
 * early `break` makes the two differ. The loop walks note upward from −12 and
 * stops at the first increase in distance, so with only note 0 enabled it never
 * examines the octave above; the table it builds is nevertheless correct because
 * `ranges[]` is only ever indexed within one octave. Reimplementing it as a
 * global minimum happens to agree — measured for all 4096 masks in
 * `tests/port_vc2_test.js`, which is the assertion that lets this port claim the
 * table is theirs rather than merely similar.
 *
 * `(i + 1) / 2` IS INTEGER DIVISION in C++, so ranges 0 and 1 both target note
 * 0, ranges 2 and 3 target note 1, and so on. Writing it as a float divide is a
 * half-semitone shift of every boundary — the one arithmetic trap in the module.
 *
 * The mask is an INTEGER knob rather than twelve booleans or a scale dropdown
 * (deviation D11), which is AX-2's D6 precedent: a number an equation can sweep,
 * where their piano-key widget cannot be swept at all.
 */
export class QuantizerKernel {
  constructor() {
    this.ranges = new Int32Array(QUANTIZER_RANGES);
    this.mask = -1;
    this.updateRanges(QUANTIZER_ALL_NOTES);
  }

  /**
   * Command. Rebuild the range table for a 12-bit mask (bit 0 = C). A no-op
   * when the mask has not changed, because this runs on the audio thread and
   * the search is 24 × up-to-37 comparisons.
   */
  updateRanges(mask) {
    const bits = mask & QUANTIZER_ALL_NOTES;
    if (bits === this.mask) return;
    this.mask = bits;
    const anyEnabled = bits !== 0;
    for (let i = 0; i < QUANTIZER_RANGES; i++) {
      let closestNote = 0;
      let closestDist = Infinity;
      for (let note = -SEMITONES_PER_OCTAVE; note <= 2 * SEMITONES_PER_OCTAVE; note++) {
        const dist = Math.abs(Math.trunc((i + 1) / 2) - note);
        if (anyEnabled && !(bits & (1 << eucMod(note, SEMITONES_PER_OCTAVE)))) continue;
        if (dist < closestDist) {
          closestNote = note;
          closestDist = dist;
        } else {
          break;
        }
      }
      this.ranges[i] = closestNote;
    }
  }

  /**
   * Command. One sample.
   *
   * @param {object} c - controls: `mask`, `offset` (semitones), `in_pitch`
   * @param {ArrayLike<number>} ins - []
   * @param {Float64Array} out - [pitch] in volts
   */
  sample(c, ins, out) {
    this.updateRanges(c.mask | 0);
    // `offset` IS A KNOB WITH NO JACK, as `Quantizer.cpp`'s enum has it — there is
    // no `in_offset` to add, and reading one would be reading `undefined`.
    const pitch = c.in_pitch + c.offset;
    let range = Math.floor(pitch * QUANTIZER_RANGES_PER_SEMITONE);
    const octave = eucDiv(range, QUANTIZER_RANGES);
    range -= octave * QUANTIZER_RANGES;
    const note = this.ranges[range] + octave * SEMITONES_PER_OCTAVE;
    out[0] = note;
  }
}

/** Their `int ranges[24]`: two per semitone, so a boundary falls halfway
 *  between adjacent notes. Their `floor(pitch · 24)` is in VOLTS; our port is in
 *  semitones (law L1), so the same index is `floor(semitones · 2)`. */
const QUANTIZER_RANGES = 24;
const QUANTIZER_RANGES_PER_SEMITONE = QUANTIZER_RANGES / SEMITONES_PER_OCTAVE;

/** All twelve notes enabled — their `onReset`, and the mask's default. */
export const QUANTIZER_ALL_NOTES = 0xfff;

/**
 * `Fundamental/Sum` — a poly cable's channels summed to one, unrolled (D3).
 *
 * DERIVATION: `Fundamental/src/Sum.cpp`, `Sum::process`, read at 10dd016.
 *
 *   out = getVoltageSum() · level
 *
 * `getVoltageSum()` adds every CHANNEL of one cable. Our cable has one channel
 * and an input takes one wire, so the port is 16 mono inputs (`MAX_CHANNELS`)
 * and the sum is over those — which is what a poly patch unrolls to, exactly.
 * Sixteen rather than a smaller round number because 16 is Rack's own maximum;
 * any other count would be a choice nobody could check.
 */
export class SumKernel {
  /**
   * Command. One sample.
   *
   * @param {object} c - controls: `level`
   * @param {ArrayLike<number>} ins - [poly1 … poly16] in volts
   * @param {Float64Array} out - [mono] in volts
   */
  sample(c, ins, out) {
    let sum = 0;
    for (let i = 0; i < ins.length; i++) sum += ins[i];
    out[0] = sum * c.level;
  }
}

/**
 * `Fundamental/Rescale` — gain, offset and a two-sided limiter that can FOLD.
 *
 * DERIVATION: `Fundamental/src/Rescale.cpp`, `Rescale::process`, read at
 * 10dd016.
 *
 *   x = in · (gain · multiplier) + offset
 *   if (max <= min)                  x = min
 *   else if (reflectMin && reflectMax) x = |fmod((x−min)/range + 1, 2) − 1|·range + min
 *   else if (reflectMin)             x = min(|x − min| + min, max)
 *   else if (reflectMax)             x = max(max − |max − x|, min)
 *   else                             x = clamp(x, min, max)
 *
 * `multiplier` is a context-menu 1/10/100/1000 and `reflectMin`/`reflectMax` are
 * `dataToJson` booleans, so all three become knobs (R7-11: a module's JSON
 * fields are property state in our world).
 *
 * IT IS OPTIONAL IN THE REGISTRY (row needed only by P18) AND SHIPPED ANYWAY.
 * THE REASON IT WAS SHIPPED IS GONE, AND THAT IS WORTH KEEPING ON THE RECORD:
 * under this block's first, overruled unit scheme a house 1.0 gate was 1 V, below
 * Rack's 2 V threshold, and this module's ×10 was the adapter that made those
 * wires work at all. R7-UNITS removed the junction. What is left is a genuinely
 * useful utility — a bipolar-to-unipolar shifter (gain 0.5, offset 0.5) and a
 * two-sided FOLDER, which is a wavefolder with both reflects on — so it stays,
 * on its own merits rather than as scaffolding.
 */
export class RescaleKernel {
  /**
   * Command. One sample.
   *
   * @param {object} c - controls: `gain`, `multiplier`, `offset`, `min`, `max`,
   *                     `reflectMin`, `reflectMax`
   * @param {ArrayLike<number>} ins - [in] in volts
   * @param {Float64Array} out - [out] in volts
   */
  sample(c, ins, out) {
    const min = c.min;
    const max = c.max;
    let x = ins[0] * (c.gain * c.multiplier) + c.offset;
    const reflectMin = c.reflectMin >= 0.5;
    const reflectMax = c.reflectMax >= 0.5;
    if (max <= min) {
      x = min;
    } else if (reflectMin && reflectMax) {
      const range = max - min;
      x = (x - min) / range;
      x = ((x + 1) % 2) - 1;
      x = Math.abs(x) * range + min;
    } else if (reflectMin) {
      x = Math.min(Math.abs(x - min) + min, max);
    } else if (reflectMax) {
      x = Math.max(max - Math.abs(max - x), min);
    } else {
      x = clamp(x, min, max);
    }
    out[0] = x;
  }
}

/**
 * `Fundamental/Compare` — two signals, eight answers.
 *
 * DERIVATION: `Fundamental/src/Compare.cpp`, `Compare::process`, read at
 * 10dd016.
 *
 *   b = in_b + bOffset;  bAbs = |b|
 *   max = max(a, b);  min = min(a, b)
 *   clip = bAbs < a ? bAbs : (a < −bAbs ? −bAbs : a);  clipped = either branch
 *   lim = a − clip
 *   clipgate = clipped ? 10 : 0;  limgate = clipped ? 0 : 10
 *   greater = a > b ? 10 : 0;  less = a < b ? 10 : 0
 *
 * THE THRESHOLD SEMANTICS THAT ARE LOAD-BEARING (P5 wires this as a window
 * comparator): `clip` limits `a` to ±|b| — the SIGN of b is discarded for the
 * clipper but NOT for `max`/`min`/`greater`/`less`, which use b signed. So one
 * module answers "fold this into a window" and "which of these two is larger"
 * with the same knob meaning two different things, and that asymmetry is theirs.
 * `lim` is the REMAINDER (`a − clip`), which is what makes Compare a wavefolder's
 * front end rather than only a comparator.
 */
export class CompareKernel {
  /**
   * Command. One sample.
   *
   * @param {object} c - controls: `b` (the offset knob, volts), `in_b`
   * @param {ArrayLike<number>} ins - [a] in volts
   * @param {Float64Array} out - [max, min, clip, lim, clipgate, limgate,
   *                             greater, less]
   */
  sample(c, ins, out) {
    const a = ins[0];
    const b = c.in_b + c.b;
    const bAbs = Math.abs(b);
    out[0] = Math.max(a, b);
    out[1] = Math.min(a, b);
    let clip = a;
    let clipped = false;
    if (bAbs < a) {
      clip = bAbs;
      clipped = true;
    } else if (a < -bAbs) {
      clip = -bAbs;
      clipped = true;
    }
    out[2] = clip;
    out[3] = a - clip;
    out[4] = clipped ? GATE_HIGH : 0;
    out[5] = clipped ? 0 : GATE_HIGH;
    out[6] = a > b ? GATE_HIGH : 0;
    out[7] = a < b ? GATE_HIGH : 0;
  }
}

/**
 * `Fundamental/SequentialSwitch2` — four inputs, one output, clocked.
 *
 * DERIVATION: `Fundamental/src/SequentialSwitch.cpp`,
 * `SequentialSwitch<4,1>::process` (the `modelSequentialSwitch2` instantiation),
 * read at 10dd016.
 *
 *   length = 2 + steps                                   ← steps is 0/1/2
 *   if (clockTrigger.process(rescale(clock, 0.1, 2, 0, 1))) index++
 *   if (resetTrigger.process(rescale(reset, 0.1, 2, 0, 1))) index = 0
 *   if (index >= length) index = 0
 *   declick off: out = in[index]
 *   declick on:  out = Σ in[i] · slew_i(dt, i == index)   ← rise = fall = 400 Hz
 *
 * TWO EDGE SEMANTICS THAT DECIDE WHETHER P5's SWITCHING SOUNDS RIGHT:
 *  1. THE RESCALE, NOT A THRESHOLD PAIR. They feed `rescale(v, 0.1, 2, 0, 1)`
 *     into a DEFAULT-threshold Schmitt (0 and 1), which is the same 0.1/2 V
 *     hysteresis every other module writes as arguments — but it also means a
 *     clock at 1 V lands at 0.47 and does NOT fire. Ported as the rescale so the
 *     two spellings cannot drift apart.
 *  2. THE WRAP IS CHECKED AFTER THE INCREMENT, so lowering `steps` while running
 *     takes effect on the NEXT clock rather than immediately, and index can sit
 *     briefly beyond the new length. That is theirs and it is audible as a
 *     skipped step.
 *
 * De-click is `dataToJson` state (default false in 2.5.0+, true for older
 * patches), so it is a knob. The slew is LINEAR at 400 units/second, i.e. 2.5 ms
 * per full crossfade — long enough to be a real crossfade at audio rate.
 */
export class SequentialSwitch2Kernel {
  /** @param {number} sampleRate */
  constructor(sampleRate) {
    this.sampleTime = 1 / sampleRate;
    this.clockTrigger = new SchmittTrigger();
    this.resetTrigger = new SchmittTrigger();
    this.index = 0;
    this.clickFilters = [];
    for (let i = 0; i < SWITCH_CHANNELS; i++) {
      this.clickFilters.push(new SlewLimiter(SWITCH_DECLICK_HZ, SWITCH_DECLICK_HZ));
    }
  }

  /**
   * Command. One sample.
   *
   * @param {object} c - controls: `steps`, `declick`, `in_clock`, `in_reset`
   * @param {ArrayLike<number>} ins - [in1 … in4] in volts
   * @param {Float64Array} out - [out] in volts
   */
  sample(c, ins, out) {
    const length = 2 + Math.trunc(c.steps);
    const scaled = rescale(c.in_clock, TRIGGER_LOW, TRIGGER_HIGH, 0, 1);
    if (this.clockTrigger.process(scaled)) this.index++;
    if (this.resetTrigger.process(rescale(c.in_reset, TRIGGER_LOW, TRIGGER_HIGH, 0, 1))) {
      this.index = 0;
    }
    if (this.index >= length) this.index = 0;

    if (c.declick >= 0.5) {
      let sum = 0;
      for (let i = 0; i < SWITCH_CHANNELS; i++) {
        const gain = this.clickFilters[i].process(this.sampleTime, i === this.index ? 1 : 0);
        if (gain !== 0) sum += ins[i] * gain;
      }
      out[0] = sum;
      return;
    }
    out[0] = ins[this.index];
  }
}

/** `SequentialSwitch<4,1>`'s input count, and the length of its click-filter
 *  array (they size it 4 regardless of the template). */
const SWITCH_CHANNELS = 4;

/** `clickFilters[i].rise = 400.f; fall = 400.f;` — units per second. */
const SWITCH_DECLICK_HZ = 400;

/**
 * `Fundamental/Noise` — six spectra from two generators, all calibrated to the
 * same loudness.
 *
 * DERIVATION: `Fundamental/src/Noise.cpp`, `Noise::process` plus
 * `PinkNoiseGenerator<8>::process` and the hard-coded red filter, read at
 * 10dd016.
 *
 *   gain   = 5/√2                                  ← the RMS of a 5 V sine
 *   white  = normal()                     · gain   ← GAUSSIAN, not uniform
 *   red    = iir(white)/0.0645            · gain   ← Butterworth 20 Hz @ 44.1 k
 *   violet = (white − white[n−1])/1.41    · gain
 *   pink   = voss()/0.816                 · gain   ← 8-octave Voss-McCartney
 *   blue   = (pink − pink[n−1])/0.705     · gain
 *   black  = uniform()·10 − 5                      ← NO gain, and not calibrated
 *
 * THREE THINGS THAT ARE EASY TO GET WRONG AND CHANGE THE SOUND:
 *  1. WHITE IS GAUSSIAN. `random::normal()`, not `uniform()`. Uniform white has
 *     the same flat spectrum and a visibly different histogram, and every other
 *     colour here is DERIVED from white, so substituting uniform changes all
 *     four of them. (Their own `black` is the uniform one, and its comment says
 *     "I made this definition up".)
 *  2. THE RED FILTER'S COEFFICIENTS ARE FROZEN AT 44.1 kHz. `b = {0.00425611,
 *     0.00425611}, a = {−0.99148778}` are a 20 Hz Butterworth AT THAT RATE and
 *     are not recomputed for any other. At 48 kHz their corner is therefore
 *     ~21.8 Hz. Reproduced verbatim, because "fixing" it would make our red
 *     noise a different colour from theirs on the same patch.
 *  3. THE VOSS TREE IS DRIVEN BY A COUNTER'S CHANGED BITS. `diff = lastFrame ^
 *     frame`; row i is redrawn only when bit i flips, which is what gives each
 *     octave half the rate of the one below. The counter wraps at 2^8, so the
 *     tree's slowest row changes every 256 samples.
 *
 * DEVIATIONS: D1 (seeded RNG), D5 (gray omitted — its 1024-point FFT bin packing
 * is pffft's and pffft is in neither pinned repo), D7 (no lights).
 */
export class NoiseKernel {
  /** @param {number} sampleRate (unused: every coefficient here is rate-free
   *                             or frozen at 44.1 kHz — see note 2)
   *  @param {object} options - `{seed}` */
  constructor(sampleRate, options = {}) {
    this.rng = new Vc2Rng(options.seed ?? 0);
    this.redFilter = new Iir22(NOISE_RED_B, NOISE_RED_A);
    this.lastWhite = 0;
    this.lastPink = 0;
    this.pinkFrame = -1;
    this.pinkValues = new Float64Array(NOISE_PINK_QUALITY);
  }

  /** Command. One Voss-McCartney step — their `PinkNoiseGenerator<8>::process`,
   *  including the pre-increment `frame` wrap that makes the XOR meaningful. */
  pink() {
    const lastFrame = this.pinkFrame;
    this.pinkFrame++;
    if (this.pinkFrame >= (1 << NOISE_PINK_QUALITY)) this.pinkFrame = 0;
    const diff = lastFrame ^ this.pinkFrame;
    let sum = 0;
    for (let i = 0; i < NOISE_PINK_QUALITY; i++) {
      if (diff & (1 << i)) this.pinkValues[i] = this.rng.uniform() - 0.5;
      sum += this.pinkValues[i];
    }
    return sum;
  }

  /**
   * Command. One sample of all six colours.
   *
   * EVERY OUTPUT IS COMPUTED EVERY SAMPLE, where Rack skips a colour whose jack
   * is empty. That is not merely an optimisation there: skipping WHITE also
   * freezes `lastWhite`, so patching violet later gives a different stream than
   * patching it from the start. Computing all six makes our streams independent
   * of the patch, which is the determinism law's side of the same coin.
   *
   * @param {object} c - controls: none
   * @param {ArrayLike<number>} ins - []
   * @param {Float64Array} out - [white, pink, red, violet, blue, black] in volts
   */
  sample(c, ins, out) {
    const white = this.rng.normal();
    out[0] = white * NOISE_GAIN;
    out[2] = this.redFilter.process(white) / NOISE_RED_RMS * NOISE_GAIN;
    out[3] = (white - this.lastWhite) / NOISE_VIOLET_RMS * NOISE_GAIN;
    this.lastWhite = white;

    const pink = this.pink() / NOISE_PINK_RMS;
    out[1] = pink * NOISE_GAIN;
    out[4] = (pink - this.lastPink) / NOISE_BLUE_RMS * NOISE_GAIN;
    this.lastPink = pink;

    out[5] = (this.rng.uniform() * CV_FULL_SCALE_VOLTS - CV_FULL_SCALE_VOLTS / 2) / VOLTS_PER_AUDIO_UNIT;
  }
}

/** `const float gain = 5.f / std::sqrt(2.f)` — "scaled to match the RMS of a
 *  sine wave with 5V amplitude", their comment — over law L1's factor of 5, so on
 *  our wires every colour is 1/√2 RMS, which is a 0 dBFS sine's RMS. The two
 *  statements are the same calibration in two units. */
const NOISE_GAIN = 5 / Math.SQRT2 / VOLTS_PER_AUDIO_UNIT;

/** `PinkNoiseGenerator<QUALITY = 8>` — the number of octave rows. */
const NOISE_PINK_QUALITY = 8;

/** Their per-colour RMS normalisers, verbatim. Each one is a measured constant
 *  in their source, not a derivation, so it is copied rather than recomputed. */
const NOISE_RED_RMS = 0.0645;
const NOISE_VIOLET_RMS = 1.41;
const NOISE_PINK_RMS = 0.816;
const NOISE_BLUE_RMS = 0.705;

/** "Butterworth lowpass with cutoff 20 Hz @ 44.1kHz", hard-coded — see note 2. */
const NOISE_RED_B = [0.00425611, 0.00425611];
const NOISE_RED_A = [-0.99148778];

/**
 * `Fundamental/LFO` — four phase-locked waveforms with a clock input.
 *
 * DERIVATION: `Fundamental/src/LFO.cpp`, `LFO::process`, read at 10dd016.
 *
 *   clockFreq   = patched ? 1/period (clamped 0.001…1000) : 2
 *   pitch       = freq + in_fm · fm
 *   f           = clockFreq/2 · exp2_taylor5(pitch)
 *   pw          = clamp(pw + in_pw/10 · pwm, 0.01, 0.99)
 *   phase      += min(f·dt, 0.5);  phase −= trunc(phase)
 *   if (resetTrigger) phase = 0
 *   sin = 5·sin(2π(phase − 0.25·offset));  tri = 5·(4|p − round(p)| − 1)
 *   saw = 5·2(p − round(p));               sqr = 5·(phase < pw ? 1 : −1)
 *   …each then inverted if `invert`, and +1 (i.e. 0…10 V) if `offset`
 *
 * IT IS NAIVE, AND THAT IS THE SOURCE'S CHOICE, NOT A SHORTCUT HERE. The brief
 * for this block expected MinBLEP anti-aliasing; the modern Fundamental LFO has
 * none — `simd::sin`, `simd::round` and a bare comparison, with the phase step
 * merely CLAMPED at 0.5 (`fmin(freq·dt, 0.5f)`) so it cannot run backwards.
 * MinBLEP lives in `VCO.cpp`/`WTVCO.cpp`, which are other rows. Ported naive
 * because porting it band-limited would make our LFO2 sound different from every
 * patch's LFO2 at the top of its 10-octave range, where authors use it as an
 * audio-rate FM source. `dsp/minblep.hpp` is untouched by this block.
 *
 * THE OFFSET SWITCH MOVES THE SINE'S PHASE, not just its DC. `if (offset) p −=
 * 0.25` before the sine and `p += 0.25` before the triangle, so a unipolar sine
 * STARTS AT ZERO and rises, and its bipolar sibling starts at zero going up too.
 * Dropping the quarter-cycle shift would put every unipolar LFO a quarter cycle
 * out against the same patch in Rack.
 *
 * DEVIATION D10: `clock` uses first-edge latching; `offset`/`invert` are Rack's
 * own switches and stay knobs.
 */
export class LfoKernel {
  /** @param {number} sampleRate */
  constructor(sampleRate) {
    this.sampleTime = 1 / sampleRate;
    this.phase = 0;
    this.clockFreq = LFO_UNPATCHED_CLOCK_HZ;
    this.clockPatched = false;
    this.clockTrigger = new SchmittTrigger();
    this.resetTrigger = new SchmittTrigger();
    this.clockTimer = new Timer();
  }

  /**
   * Command. One sample.
   *
   * @param {object} c - controls: `freq`, `fm`, `pw`, `pwm`, `offset`, `invert`,
   *                     `in_fm`, `in_pw`, `in_reset`, `in_clock`
   * @param {ArrayLike<number>} ins - []
   * @param {Float64Array} out - [sin, tri, saw, sqr] in volts
   */
  sample(c, ins, out) {
    this.clockTimer.process(this.sampleTime);
    if (this.clockTrigger.process(c.in_clock, TRIGGER_LOW, TRIGGER_HIGH)) {
      const measured = 1 / this.clockTimer.time;
      this.clockTimer.reset();
      this.clockPatched = true;
      if (measured >= LFO_CLOCK_MIN_HZ && measured <= LFO_CLOCK_MAX_HZ) this.clockFreq = measured;
    }
    if (!this.clockPatched) this.clockFreq = LFO_UNPATCHED_CLOCK_HZ;

    const offset = c.offset > 0;
    const invert = c.invert > 0;
    // Their `FREQ_PARAM` is log2 hertz against a `clockFreq/2` base; law L2 makes
    // the knob the hertz itself, so the pitch is its log. With a clock patched the
    // rate becomes that clock's, multiplied — which is what the knob is FOR there.
    const pitch = Math.log2(c.freq) + c.in_fm / SEMITONES_PER_OCTAVE * c.fm;
    const freq = this.clockFreq / 2 * exp2Taylor5(pitch);
    const pw = clamp(c.pw + c.in_pw * c.pwm, LFO_PW_MIN, LFO_PW_MAX);

    this.phase += Math.min(freq * this.sampleTime, LFO_MAX_PHASE_STEP);
    this.phase -= Math.trunc(this.phase);
    if (this.resetTrigger.process(c.in_reset, TRIGGER_LOW, TRIGGER_HIGH)) this.phase = 0;

    const shape = (v) => (invert ? -v : v) + (offset ? 1 : 0);
    const sinePhase = offset ? this.phase - LFO_OFFSET_PHASE : this.phase;
    out[0] = LFO_AMPLITUDE * shape(Math.sin(2 * Math.PI * sinePhase));
    const triPhase = offset ? this.phase + LFO_OFFSET_PHASE : this.phase;
    out[1] = LFO_AMPLITUDE * shape(4 * Math.abs(triPhase - Math.round(triPhase)) - 1);
    const sawPhase = offset ? this.phase - LFO_SAW_OFFSET_PHASE : this.phase;
    out[2] = LFO_AMPLITUDE * shape(2 * (sawPhase - Math.round(sawPhase)));
    out[3] = LFO_AMPLITUDE * shape(this.phase < pw ? 1 : -1);
  }
}

/** `clockFreq = 2.f` — "Default frequency when clock is unpatched". Halved by
 *  `clockFreq / 2.f`, so an unpatched LFO at freq = 0 runs at 1 Hz. */
const LFO_UNPATCHED_CLOCK_HZ = 2;

/** Their `if (0.001f <= clockFreq && clockFreq <= 1000.f)` guard: a measured
 *  period outside this is ignored rather than believed. */
const LFO_CLOCK_MIN_HZ = 0.001;
const LFO_CLOCK_MAX_HZ = 1000;

/** `configParam(PW_PARAM, 0.01f, 0.99f, …)` and the same clamp in `process`. */
const LFO_PW_MIN = 0.01;
const LFO_PW_MAX = 0.99;

/** `fmin(freq * args.sampleTime, 0.5f)` — the phase may not step past Nyquist. */
const LFO_MAX_PHASE_STEP = 0.5;

/** Every LFO output is ±5 V, i.e. Rack's nominal amplitude — which is ±1 on our
 *  wires, by law L1. The unipolar switch adds 1 before this scaling, so a
 *  unipolar wave spans 0…2, exactly as its 0…10 V original does. */
const LFO_AMPLITUDE = 5 / VOLTS_PER_AUDIO_UNIT;

/** The quarter- and half-cycle shifts the unipolar switch applies so that a
 *  unipolar wave starts at 0 V (see the docblock). */
const LFO_OFFSET_PHASE = 0.25;
const LFO_SAW_OFFSET_PHASE = 0.5;

/**
 * `Fundamental/ADSR` — the envelope, and NOT the curve our own `audio_adsr` has.
 *
 * DERIVATION: `Fundamental/src/ADSR.cpp`, `ADSR::process`, read at 10dd016.
 *
 *   λ_stage = LAMBDA_BASE^(−param) / MIN_TIME      ← computed on a /16 divider
 *   gate      = in_gate >= 1 V, or the push knob
 *   attacking |= rising edge of gate; |= retrigger Schmitt; &= gate
 *   target = attacking ? 1.2 : (gate ? sustain : 0)
 *   λ      = attacking ? λ_a : (gate ? λ_d : λ_r)
 *   env   += (target − env) · λ · dt
 *   attacking &= (env < 1)
 *   out    = 10 · env
 *
 * WHAT MAKES THIS SOUND DIFFERENT FROM OURS, in one sentence: every stage is the
 * SAME first-order approach and the attack overshoots its target on purpose. It
 * aims at **1.2**, not 1.0, and gives up as soon as `env` crosses 1 — so the
 * attack is the first 83% of an exponential rise, which is nearly linear and has
 * no flat approach at the top. Our `audio_adsr` schedules Web Audio ramps in
 * SECONDS; this integrates a rate, and there is no ramp scheduling anywhere.
 *
 * THE TIME LAW IS NOT SECONDS EITHER: `param` is 0…1 and the stage time is
 * `MIN_TIME · (MAX_TIME/MIN_TIME)^param` = 1 ms … 10 s logarithmically, so the
 * knob's middle is 100 ms. That is why the knobs here are 0…1 dials (law L2) —
 * they are the patch's stored numbers.
 *
 * THE /16 DIVIDER IS PORTED (law L4). The lambdas and the sustain level are
 * recomputed every 16th sample, so a CV modulating `attack` at audio rate is
 * SAMPLED at 3 kHz here exactly as it is there. Hoisting it to every sample is
 * the R7-11 trap; hoisting it to once per quantum is worse.
 */
export class AdsrKernel {
  /** @param {number} sampleRate */
  constructor(sampleRate) {
    this.sampleTime = 1 / sampleRate;
    this.cvDivider = new ClockDivider(ADSR_CV_DIVISION);
    this.retrigTrigger = new SchmittTrigger();
    this.gate = false;
    this.attacking = false;
    this.env = 0;
    this.attackLambda = 0;
    this.decayLambda = 0;
    this.releaseLambda = 0;
    this.sustain = 0;
  }

  /**
   * Command. One sample.
   *
   * @param {object} c - controls: `attack`, `decay`, `sustain`, `release`,
   *                     `attackCv`, `decayCv`, `sustainCv`, `releaseCv`,
   *                     `push`, `in_attack`, `in_decay`, `in_sustain`,
   *                     `in_release`, `in_gate`, `in_retrig`
   * @param {ArrayLike<number>} ins - []
   * @param {Float64Array} out - [envelope] in volts
   */
  sample(c, ins, out) {
    if (this.cvDivider.process()) {
      // THE CV IS SUMMED IN DIAL SPACE, NOT IN SECONDS, and that is the whole
      // subtlety of putting these knobs in real units (law L2): their `param +
      // input/10 · trim` is a LOGARITHMIC displacement — a CV of 0.1 multiplies
      // the time by 10000^0.1 = 2.5 wherever the knob is parked. Adding the CV to
      // the seconds instead would make the same wire mean 100 ms at one setting
      // and nothing at another, which is not the modulation the patch authored.
      const attack = clamp(adsrDial(c.attack) + c.in_attack * c.attackCv, 0, 1);
      const decay = clamp(adsrDial(c.decay) + c.in_decay * c.decayCv, 0, 1);
      const sustain = clamp(c.sustain + c.in_sustain * c.sustainCv, 0, 1);
      const release = clamp(adsrDial(c.release) + c.in_release * c.releaseCv, 0, 1);
      this.attackLambda = ADSR_LAMBDA_BASE ** -attack / ADSR_MIN_TIME;
      this.decayLambda = ADSR_LAMBDA_BASE ** -decay / ADSR_MIN_TIME;
      this.releaseLambda = ADSR_LAMBDA_BASE ** -release / ADSR_MIN_TIME;
      this.sustain = sustain;
    }

    const oldGate = this.gate;
    this.gate = c.push > 0 ? true : c.in_gate >= ADSR_GATE_LEVEL;
    if (this.gate && !oldGate) this.attacking = true;
    if (this.retrigTrigger.process(c.in_retrig, 0, ADSR_GATE_LEVEL)) this.attacking = true;
    if (!this.gate) this.attacking = false;

    const target = this.attacking ? ADSR_ATTACK_TARGET : (this.gate ? this.sustain : 0);
    const lambda = this.attacking
      ? this.attackLambda
      : (this.gate ? this.decayLambda : this.releaseLambda);
    this.env += (target - this.env) * lambda * this.sampleTime;
    if (this.env >= 1) this.attacking = false;

    out[0] = this.env;
  }
}

/**
 * Pure function. A stage time in SECONDS as their 0…1 dial — the inverse of
 * `time = MIN_TIME · LAMBDA_BASE^dial`, and the one line law L2 costs the ADSR.
 *
 * @param {number} seconds - 0.001…10
 * @returns {number} their dial position, 0…1
 *
 * @example adsrDial(0.001) // 0
 * @example adsrDial(10) // 1
 * @example adsrDial(0.1) // 0.5
 */
export function adsrDial(seconds) {
  return Math.log(seconds / ADSR_MIN_TIME) / Math.log(ADSR_LAMBDA_BASE);
}

/** `cvDivider.setDivision(16)` — law L4. */
const ADSR_CV_DIVISION = 16;

/** `MIN_TIME = 1e-3f`, `MAX_TIME = 10.f`, `LAMBDA_BASE = MAX_TIME/MIN_TIME`. */
const ADSR_MIN_TIME = 1e-3;
const ADSR_LAMBDA_BASE = 10 / 1e-3;

/** `ATT_TARGET = 1.2f` — the overshoot that makes the attack nearly linear. */
const ADSR_ATTACK_TARGET = 1.2;

/** `gate = inputs[GATE_INPUT].getVoltageSimd(c) >= 1.f` — a 1 V threshold with
 *  NO hysteresis, unlike every Schmitt-triggered input in the block, expressed in
 *  wire units by law L1's fourth clause — a tenth of a gate, which a house 1.0
 *  gate clears ten times over. */
const ADSR_GATE_LEVEL = 1 / GATE_VOLTS;

/**
 * `Fundamental/Random` — a random voltage with four interpolation shapes.
 *
 * DERIVATION: `Fundamental/src/Random.cpp`, `Random::process`, read at 10dd016.
 *
 *   clockFreq = external ? 1/period : exp2_taylor5(rate + in_rate·rate_cv)
 *   deltaPhase = min(clockFreq·dt, 0.5)
 *   on each trigger:  if (prob < 1 && uniform() > prob) return   ← SKIPS the step
 *                     last = next
 *                     next = source ? external : crossfade(next, v, rand)
 *                     phase = 0;  pulse.trigger(1 ms)
 *   phase = min(phase + deltaPhase, 1)
 *   stepped = ceil(phase·steps)/steps,  steps = ceil(shape²·15 + 1)
 *   linear  = min(phase/shape, 1)
 *   smooth  = (1 − cos(π·min(phase/shape, 1)))/2
 *   exp     = (shape⁸^phase − 1)/(shape⁸ − 1)
 *   …each then rescaled from [0,1] onto [last, next]
 *
 * THE CROSSFADE IS THE MODULE'S CHARACTER AND IT IS EASY TO MISS.
 * `next = crossfade(next, v, rand)` fades from the PREVIOUS value toward a fresh
 * one by `rand`, so at rand = 0 the sequence never changes at all and at 0.5 it
 * random-walks rather than jumping — that is what makes Random a drifting
 * modulator instead of a sample-and-hold, and it is one multiply.
 *
 * THE FOUR SHAPES SHARE ONE PHASE, so they are four views of the same step and
 * stay in lockstep; `shape` steepens all of them at once. `linear`'s slope is
 * `1/shape`, guarded at 1e6 (shape = 0 means "jump instantly").
 *
 * DEVIATIONS: D1 (seeded RNG — their `prob` and value draws), D10 (`source` is
 * an explicit knob where Rack senses the EXTERNAL jack, and `trig` latches on
 * its first edge), D7 (no lights).
 */
export class RandomKernel {
  /** @param {number} sampleRate
   *  @param {object} options - `{seed}` */
  constructor(sampleRate, options = {}) {
    this.sampleTime = 1 / sampleRate;
    this.rng = new Vc2Rng(options.seed ?? 0);
    this.last = 0;
    this.next = 0;
    this.phase = 0;
    this.clockPhase = 0;
    this.clockFreq = 0;
    this.clockPatched = false;
    this.clockTimer = new Timer();
    this.clockTrigger = new SchmittTrigger();
    this.pulse = new PulseGenerator();
    this.source = "internal";
  }

  /** Command. Choose whether a step draws a random value or samples the
   *  external input. LOUD on an unknown name. */
  setSource(value) {
    if (!RANDOM_SOURCES.includes(value)) {
      throw new Error(`Random source must be one of ${RANDOM_SOURCES.join(", ")}; got ${JSON.stringify(value)}`);
    }
    this.source = value;
  }

  /** Command. One step: draw (or sample) the next value, subject to `prob`. */
  step(c, external) {
    const prob = clamp(c.prob + c.in_prob * c.probCv, 0, 1);
    if (prob < 1 && this.rng.uniform() > prob) return;
    this.last = this.next;
    if (this.source === "external") {
      this.next = external;
    } else {
      const rand = clamp(c.rand + c.in_rand * c.randCv, 0, 1);
      let v = CV_FULL_SCALE_VOLTS / VOLTS_PER_AUDIO_UNIT * this.rng.uniform();
      if (c.offset <= 0) v -= CV_FULL_SCALE_VOLTS / VOLTS_PER_AUDIO_UNIT / 2;
      this.next = crossfade(this.next, v, rand);
    }
    this.phase = 0;
    this.pulse.trigger(PULSE_SECONDS);
  }

  /**
   * Command. One sample.
   *
   * @param {object} c - controls: `rate`, `shape`, `offset`, `prob`, `rand`,
   *                     `rateCv`, `shapeCv`, `probCv`, `randCv`, and the
   *                     `in_*` twins of rate/shape/prob/rand/trig
   * @param {ArrayLike<number>} ins - [external] in volts
   * @param {Float64Array} out - [stepped, linear, smooth, exponential, trig]
   */
  sample(c, ins, out) {
    let deltaPhase = 0;
    this.clockTimer.process(this.sampleTime);
    const clocked = this.clockTrigger.process(c.in_trig, TRIGGER_LOW, TRIGGER_HIGH);
    if (clocked) {
      this.clockFreq = 1 / this.clockTimer.time;
      this.clockTimer.reset();
      this.clockPatched = true;
      this.step(c, ins[0]);
    }
    if (this.clockPatched) {
      deltaPhase = Math.min(this.clockFreq * this.sampleTime, RANDOM_MAX_PHASE_STEP);
    } else {
      const rate = Math.log2(c.rate) + c.in_rate / SEMITONES_PER_OCTAVE * c.rateCv;
      this.clockFreq = exp2Taylor5(rate);
      deltaPhase = Math.min(this.clockFreq * this.sampleTime, RANDOM_MAX_PHASE_STEP);
      this.clockPhase += deltaPhase;
      if (this.clockPhase >= 1) {
        this.clockPhase -= 1;
        this.step(c, ins[0]);
      }
    }

    this.phase = Math.min(1, this.phase + deltaPhase);
    const shape = clamp(c.shape + c.in_shape * c.shapeCv, 0, 1);
    const span = (v) => rescale(v, 0, 1, this.last, this.next);

    const steps = Math.ceil(shape * shape * (RANDOM_MAX_STEPS - 1) + 1);
    out[0] = span(Math.ceil(this.phase * steps) / steps);

    const slope = 1 / shape;
    out[1] = span(slope < RANDOM_SLOPE_LIMIT ? Math.min(this.phase * slope, 1) : 1);

    if (slope < RANDOM_SLOPE_LIMIT) {
      const v = Math.min(this.phase * slope, 1);
      out[2] = span((1 - Math.cos(Math.PI * v)) / 2);
    } else {
      out[2] = span(1);
    }

    const b = shape ** RANDOM_EXP_POWER;
    if (b > RANDOM_EXP_LINEAR_ABOVE) out[3] = span(this.phase);
    else if (b > RANDOM_EXP_FLOOR) out[3] = span((b ** this.phase - 1) / (b - 1));
    else out[3] = span(1);

    out[4] = this.pulse.process(this.sampleTime) ? GATE_HIGH : 0;
  }
}

/** Their two value sources: generate, or sample the EXTERNAL jack (D10). */
export const RANDOM_SOURCES = ["internal", "external"];

/** `fmin(clockFreq * args.sampleTime, 0.5f)`, as the LFO's. */
const RANDOM_MAX_PHASE_STEP = 0.5;

/** `steps = ceil(pow(shape,2) * 15 + 1)` — 1 to 16 stair treads. */
const RANDOM_MAX_STEPS = 16;

/** `if (slope < 1e6f)` — beyond this the ramp is treated as instantaneous. */
const RANDOM_SLOPE_LIMIT = 1e6;

/** `b = pow(shape, 8)`, then `0.999f < b` is linear and `b <= 1e-20f` is a
 *  step. Both guards are theirs and both are reachable from the knob. */
const RANDOM_EXP_POWER = 8;
const RANDOM_EXP_LINEAR_ABOVE = 0.999;
const RANDOM_EXP_FLOOR = 1e-20;

/**
 * Pure function. One first-order allpass CASCADE step, `H(z) = (a + z⁻¹)/(1 +
 * a·z⁻¹)` per section — Rack's `allpassCascadeProcess` (`Fundamental/src/VCF.cpp`).
 *
 * MUTATES `state` IN PLACE, which is why it is near-pure rather than pure: the
 * cascade's whole job is to carry state. It is written as a free function
 * because the up- and downsamplers differ ONLY in which coefficient set and
 * which state array they pass, and duplicating three lines twice is how the two
 * branches drift apart.
 *
 * @param {number} x - input sample
 * @param {Float64Array} state - one element per section, updated in place
 * @param {number[]} coefficients - one per section
 * @returns {number} the cascade's output
 *
 * @example // a single section with a = 0 is a one-sample delay:
 * @example allpassCascade(1, new Float64Array(1), [0]) // 0
 * @example // and the next call returns the sample it held:
 * @example // s = new Float64Array(1); allpassCascade(1, s, [0]); allpassCascade(0, s, [0]) // 1
 */
export function allpassCascade(x, state, coefficients) {
  let value = x;
  for (let i = 0; i < coefficients.length; i++) {
    const a = coefficients[i];
    const y = a * value + state[i];
    state[i] = value - a * y;
    value = y;
  }
  return value;
}

/**
 * `Fundamental/VCF` — THE HARD ONE: a 4-pole transistor ladder with a saturator
 * in the feedback path, at 2× oversampling.
 *
 * DERIVATION: `Fundamental/src/VCF.cpp`, `LadderFilter<float_4>::process` and
 * `VCF::process`, read at 10dd016. Their own citations, kept because they are the
 * derivation: Huovilainen 2004 (the ladder model), Zavalishin 2018 (trapezoidal
 * integrators), Mystran's per-stage tanh linearisation.
 *
 * ── WHY THIS IS NOT A BIQUAD, STATED BECAUSE OUR `audio_filter` IS ONE ──────
 * `audio_filter` is a `BiquadFilterNode`: two poles, linear, resonance as a Q
 * peak, and it cannot self-oscillate or distort. This is four poles, each
 * integrating `tanh(in) − tanh(out)`, with the fourth pole's PREVIOUS output fed
 * back through the input saturator. Three behaviours follow that a biquad has
 * none of, and they are the reason the row is `variant(ours)` rather than a
 * no-op: it SELF-OSCILLATES near resonance 4 (their comment), the resonance
 * SQUASHES the passband because the feedback subtracts from the input, and the
 * drive knob is a real overdrive (gain `(1 + drive)⁵`, up to 32×) into a
 * saturator rather than a volume control.
 *
 * ── THE RECURRENCE, AS PORTED (per oversampled step n of 2) ─────────────────
 *   g   = tan_3_4(π · cutoff/2)                    ← prewarp at 2× rate
 *   u0  = x[n] − resonance · y3[n−1]
 *   u0c = clamp(u0, −4, 4);  u0s = tanhXdX(u0c) · u0c
 *   t_k = max(tanhXdX(y_k[n−1]), 0.01)             ← per-stage slope, floored
 *   y0  = (g·u0s     + s0)/(1 + g·t0)
 *   y1  = (g·t0·y0   + s1)/(1 + g·t1)
 *   y2  = (g·t1·y1   + s2)/(1 + g·t2)
 *   y3  = (g·t2·y2   + s3)/(1 + g·t3)
 *   s_k = 2·y_k − s_k                              ← trapezoidal state update
 *   lp  = y3 · tanhXdX(y3/2)                       ← = 2·tanh(y3/2), soft clip
 *   hp  = (u0c − 4y0 + 6y1 − 4y2 + y3) soft-clipped ← binomial, cancels at DC
 *
 * FOUR TRAPS, ALL MEASURED RATHER THAN GUESSED:
 *  1. THE `tMinimum = 0.01` FLOOR IS STABILITY, NOT TASTE. `tanhXdX_4_6`
 *     approaches 0 for large |y|, and a zero slope removes a stage's damping
 *     entirely — the ladder then latches. Omit the floor and the filter blows up
 *     on a loud input instead of saturating.
 *  2. THE FEEDBACK IS ONE SAMPLE OLD AT THE OVERSAMPLED RATE (`yPrevious[3]`),
 *     not zero-delay. That delay is what sets the self-oscillation frequency, so
 *     "improving" it to a zero-delay solve retunes the resonance.
 *  3. `resonance = clamp(res, 0, 1)² · 10`, so the knob's top half is where all
 *     the action is and self-oscillation starts around res = 0.63 (4/10 under a
 *     square law), not at the top of the knob.
 *  4. THE HALFBAND BRANCHES ARE SWAPPED ON THE WAY BACK DOWN — the downsampler
 *     feeds `input[1]` to branch A and `input[0]` to branch B. Swapped, the round
 *     trip is `A·B` (a product of two allpasses, so unity everywhere); copying the
 *     UPSAMPLER's assignment gives `½(A² + B²)`, which is unity at low frequencies
 *     and cancels toward Nyquist. MEASURED on the shipped `allpassCascade`
 *     (48 kHz round trip, swapped vs not): 1.000 / 0.9999 at 200 Hz, 0.999 / 0.997
 *     at 1 kHz, 1.000 / 0.947 at 5 kHz, 0.995 / **0.789** at 10 kHz, 1.000 /
 *     **0.259** at 20 kHz. So the wrong version is INVISIBLE where anyone would
 *     casually check it and loses the top two octaves — a filter that "works" and
 *     is dull, which is the AX-3 `qinv` failure in its VCV form.
 *
 * DEVIATIONS: D2 (scalar, not `float_4` × 4 filters), D8 (the −120 dB bootstrap
 * noise is seeded), and BOTH OUTPUTS ARE ALWAYS COMPUTED where Rack skips an
 * unpatched one — `computeLowpass`/`computeHighpass` gate only the two soft
 * clips, so computing both costs four adds and removes a
 * patch-order-dependent state divergence.
 */
export class VcfKernel {
  /** @param {number} sampleRate
   *  @param {object} options - `{seed}` */
  constructor(sampleRate, options = {}) {
    this.sampleTime = 1 / sampleRate;
    this.rng = new Vc2Rng(options.seed ?? 0);
    this.upA = new Float64Array(HALFBAND_SECTIONS);
    this.upB = new Float64Array(HALFBAND_SECTIONS);
    this.downLpA = new Float64Array(HALFBAND_SECTIONS);
    this.downLpB = new Float64Array(HALFBAND_SECTIONS);
    this.downHpA = new Float64Array(HALFBAND_SECTIONS);
    this.downHpB = new Float64Array(HALFBAND_SECTIONS);
    this.s = new Float64Array(LADDER_POLES);
    this.y = new Float64Array(LADDER_POLES);
    this.overLp = new Float64Array(OVERSAMPLE);
    this.overHp = new Float64Array(OVERSAMPLE);
    this.overIn = new Float64Array(OVERSAMPLE);
  }

  /**
   * Command. One sample.
   *
   * @param {object} c - controls: `freq`, `res`, `drive`, `freqCv`, `resCv`,
   *                     `driveCv`, `in_freq`, `in_res`, `in_drive`
   * @param {ArrayLike<number>} ins - [in] in volts
   * @param {Float64Array} out - [lpf, hpf] in volts
   */
  sample(c, ins, out) {
    // VCF::process — the parameter block, verbatim including the 2.0
    // backward-compatibility rescale of the cutoff dial.
    // THEIR DIAL, INVERTED (law L2): `freq = C4·2^(10·dial − 5)` hertz, so the
    // pitch their recurrence wants is `log2(hz / C4)`.
    const freqParam = Math.log2(c.freq / FREQ_C4);
    const drive = clamp(c.drive + c.in_drive * c.driveCv, -1, 1);
    const gain = (1 + drive) ** VCF_DRIVE_POWER;
    const resonance = clamp(c.res + c.in_res * c.resCv, 0, 1);
    const pitch = freqParam + c.in_freq / SEMITONES_PER_OCTAVE * c.freqCv;
    const cutoff = clamp(FREQ_C4 * exp2Taylor5(pitch) * this.sampleTime, 0, VCF_MAX_CUTOFF);

    // THE MODULE'S OWN /5 AND OUR OWN x5 CANCEL EXACTLY. Their `scale = 5.f`
    // exists to work in ±1 internally, and law L1 says a ±1 wire IS ±5 V — so the
    // conversion pair is the identity here and is written as such rather than as
    // `ins[0] * VOLTS_PER_AUDIO_UNIT / VCF_INPUT_SCALE`, which is the same number
    // and invites someone to "simplify" only one half of it.
    let input = ins[0] * gain;
    input += VCF_BOOTSTRAP_AMPLITUDE * (2 * this.rng.uniform() - 1);

    // LadderFilter::process
    const g = tan34(Math.PI * (cutoff * OVERSAMPLE_CUTOFF_SCALE));
    const res = resonance * resonance * VCF_RESONANCE_SCALE;
    this.overIn[0] = allpassCascade(input, this.upA, HALFBAND_COEFFICIENTS_A);
    this.overIn[1] = allpassCascade(input, this.upB, HALFBAND_COEFFICIENTS_B);

    for (let n = 0; n < OVERSAMPLE; n++) {
      const u0 = this.overIn[n] - res * this.y[3];
      const u0Clamped = clamp(u0, -TANH_VALID_RANGE, TANH_VALID_RANGE);
      const u0Saturated = tanhXdX46(u0Clamped) * u0Clamped;

      const t0 = Math.max(tanhXdX46(this.y[0]), LADDER_MIN_SLOPE);
      const t1 = Math.max(tanhXdX46(this.y[1]), LADDER_MIN_SLOPE);
      const t2 = Math.max(tanhXdX46(this.y[2]), LADDER_MIN_SLOPE);
      const t3 = Math.max(tanhXdX46(this.y[3]), LADDER_MIN_SLOPE);

      const y0 = (g * u0Saturated + this.s[0]) / (1 + g * t0);
      const y1 = (g * t0 * y0 + this.s[1]) / (1 + g * t1);
      const y2 = (g * t1 * y1 + this.s[2]) / (1 + g * t2);
      const y3 = (g * t2 * y2 + this.s[3]) / (1 + g * t3);

      this.s[0] = 2 * y0 - this.s[0];
      this.s[1] = 2 * y1 - this.s[1];
      this.s[2] = 2 * y2 - this.s[2];
      this.s[3] = 2 * y3 - this.s[3];
      this.y[0] = y0;
      this.y[1] = y1;
      this.y[2] = y2;
      this.y[3] = y3;

      this.overLp[n] = y3 * tanhXdX46(y3 * SOFT_CLIP_HALF);
      const highpass = u0Clamped - 4 * y0 + 6 * y1 - 4 * y2 + y3;
      this.overHp[n] = highpass * tanhXdX46(highpass * SOFT_CLIP_HALF);
    }

    // Downsampler2x::process — note the SWAPPED branch inputs (trap 4).
    const lpA = allpassCascade(this.overLp[1], this.downLpA, HALFBAND_COEFFICIENTS_A);
    const lpB = allpassCascade(this.overLp[0], this.downLpB, HALFBAND_COEFFICIENTS_B);
    const hpA = allpassCascade(this.overHp[1], this.downHpA, HALFBAND_COEFFICIENTS_A);
    const hpB = allpassCascade(this.overHp[0], this.downHpB, HALFBAND_COEFFICIENTS_B);
    out[0] = HALFBAND_MIX * (lpA + lpB);
    out[1] = HALFBAND_MIX * (hpA + hpB);
  }
}

/** `HALFBAND_2X_COEFFICIENTS_A/B` — a polyphase IIR halfband for 2× resampling:
 *  passband flat within 1e-7 dB, stopband 78 dB down (their measurement). */
const HALFBAND_COEFFICIENTS_A = [0.062822416060049985, 0.4243808557204406, 0.7818614603969013];
const HALFBAND_COEFFICIENTS_B = [0.22380733034648345, 0.61653443504951111, 0.92747359487482584];
const HALFBAND_SECTIONS = 3;

/** `T(0.5) * (outputA + outputB)` — the halfband's `1/2(A + z⁻¹B)`. */
const HALFBAND_MIX = 0.5;

/** The ladder runs at twice the host rate, so its prewarp uses half the
 *  normalised cutoff (`frame.cutoff * T(0.5)`). */
const OVERSAMPLE = 2;
const OVERSAMPLE_CUTOFF_SCALE = 0.5;

/** Four poles, and their `s[4]`/`yPrevious[4]`. */
const LADDER_POLES = 4;

/** `const T tMinimum = T(0.01)` — trap 1: the slope floor that keeps each stage
 *  self-damping. */
const LADDER_MIN_SLOPE = 0.01;

/** `tanhXdX_4_6`'s stated valid range, and the clamp applied before saturating
 *  the ladder's input (`simd::clamp(u0, T(-4), T(4))`). */
const TANH_VALID_RANGE = 4;

/** `2·tanh(v/2) = v · tanhXdX(v/2)` — the ±2 soft clip on each output. */
const SOFT_CLIP_HALF = 0.5;

/** `freqParam = freqParam * 10.f - 5.f` — the pre-2.0 dial mapping, which spans
 *  ±5 octaves around C4. Kept as the two numbers because the SPEC's range is
 *  derived from them (`C4·2^±5` = 8.2 Hz…8.4 kHz, widened by their own configParam
 *  to 8 Hz…22 kHz), and the test re-derives the spec's bounds from these. */
export const VCF_FREQ_DIAL_SPAN = 10;
export const VCF_FREQ_DIAL_OFFSET = 5;

/** `const float scale = 5.f` — the module works in ±1 internally and multiplies
 *  back on the way out, which is why its saturation knee is at 5 V. IDENTICAL to
 *  law L1's `VOLTS_PER_AUDIO_UNIT`, which is why the pair cancels in `sample`;
 *  kept as a named constant because it is a DIFFERENT FACT that happens to be the
 *  same number, and if either ever changes the cancellation must be revisited. */
const VCF_INPUT_SCALE = VOLTS_PER_AUDIO_UNIT;

/** `gain(drive) = (1 + drive)^5`: 0 at −1, 1 at 0, 32 at +1. */
const VCF_DRIVE_POWER = 5;

/** `frame.resonance = pow(resonance, 2) * 10.f`, and "the filter self-oscillates
 *  near 4" — so oscillation begins around res = 0.63 (trap 3). */
const VCF_RESONANCE_SCALE = 10;

/** `simd::clamp(…, 0.f, 0.499f)` — per-pole normalised cutoff, just under
 *  Nyquist at the OVERSAMPLED rate. */
const VCF_MAX_CUTOFF = 0.499;

/** `input += 1e-6f * (2.f * random::uniform() - 1.f)` — "Add -120 dB noise to
 *  bootstrap self-oscillation" (D8: seeded here). */
const VCF_BOOTSTRAP_AMPLITUDE = 1e-6;

/**
 * `Fundamental/VCMixer` — four channel strips with CV, plus a mix VCA.
 *
 * DERIVATION: `Fundamental/src/VCMixer.cpp`, `VCMixer::process`, read at
 * 10dd016.
 *
 *   per channel i:  out_i = ch_i · lvl_i²                     ← SQUARE law
 *                   cv    = max(0, in_cv_i/10)               ← fmax, NOT clamp
 *                   if (chExp) cv = (cv·cv)·(cv·cv)
 *                   out_i ·= cv;   mix += out_i
 *   mix ·= mix_lvl                                            ← LINEAR law
 *   cv   = max(0, in_mix_cv/10);  if (mixExp) cv = cv⁴;  mix ·= cv
 *
 * THREE THINGS THAT ARE NOT WHAT OUR `audio_mixer` DOES:
 *  1. THE CHANNEL FADERS ARE SQUARE LAW AND THE MIX FADER IS NOT. `lvl²` over a
 *     0…√2 knob reaches +6 dB; `mixLvl` over 0…2 is linear and reaches +6 dB
 *     too — same top, different taper, and the difference is exactly what makes
 *     a VCMixer fader feel like a fader.
 *  2. THE CV IS NOT CLAMPED ABOVE. `simd::fmax(0.f, cv)` floors at zero and
 *     leaves the ceiling open, so a 20 V CV gives 2× gain. Clamping to 1 (as a
 *     VCA-1 does) would quietly cap every send-return patch that drives a
 *     channel CV hot.
 *  3. THE CHANNEL OUTPUTS ARE PRE-MIX-FADER AND POST-CV. They are the send
 *     points P2's send/return topology hangs off, so they are ports here rather
 *     than a dropped convenience.
 *
 * DEVIATIONS: D10 (each `cv` knob is the assumed jack voltage, 10 V, so an
 * unwired channel passes its fader exactly), D7 (no VU meters).
 */
export class VcMixerKernel {
  /**
   * Command. One sample.
   *
   * @param {object} c - controls: `lvl1`…`lvl4`, `mixLvl`, `cv1`…`cv4`,
   *                     `mixCv`, `chExp`, `mixExp`, and the `in_*` twins
   * @param {ArrayLike<number>} ins - [ch1 … ch4] in volts
   * @param {Float64Array} out - [mix, ch1, ch2, ch3, ch4] in volts
   */
  constructor() {
    // THE KEY NAMES ARE BUILT ONCE. `c[\`lvl${i}\`]` inside the loop would
    // concatenate a string per channel per sample — an allocation on the audio
    // thread, which is the one thing a processor may never do.
    this.levelKeys = [];
    this.cvKeys = [];
    this.inCvKeys = [];
    for (let i = 1; i <= VCMIXER_CHANNELS; i++) {
      this.levelKeys.push(`lvl${i}`);
      this.cvKeys.push(`cv${i}`);
      this.inCvKeys.push(`in_cv${i}`);
    }
  }

  sample(c, ins, out) {
    const chExp = c.chExp >= 0.5;
    let mix = 0;
    for (let i = 0; i < VCMIXER_CHANNELS; i++) {
      const level = c[this.levelKeys[i]];
      let value = ins[i] * (level * level);
      let cv = Math.max(0, c[this.cvKeys[i]] + c[this.inCvKeys[i]]);
      if (chExp) cv = (cv * cv) * (cv * cv);
      value *= cv;
      mix += value;
      out[1 + i] = value;
    }
    mix *= c.mixLvl;
    let mixCv = Math.max(0, c.mixCv + c.in_mixCv);
    if (c.mixExp >= 0.5) mixCv = (mixCv * mixCv) * (mixCv * mixCv);
    out[0] = mix * mixCv;
  }
}

/** `ENUMS(CH_INPUTS, 4)` — the strip count. */
const VCMIXER_CHANNELS = 4;

/**
 * `Fundamental/Delay` — a 1 ms…10 s echo whose time knob PITCH-BENDS the
 * repeats while it moves.
 *
 * DERIVATION: `Fundamental/src/Delay.cpp`, `Delay::process`, read at 10dd016.
 *
 *   clockFreq = patched ? 1/period (0.001…1000) : 2
 *   dry   = in + lastWet · feedback
 *   pitch = log2(1000) − log2(10000)·time + in_time·time_cv
 *   freq  = clockFreq/2 · exp2_taylor5(pitch)
 *   index = clamp(sampleRate/freq − 20, 2, HISTORY−1)         ← the −16−4 fudge
 *   consume = index − buffered;  ratio = 4^clamp(consume/10000, ±1)
 *   …read the history at 1/ratio samples per output sample
 *   wet   = clamp(read, ±100)
 *   colorFreq = 100^(2·tone − 1)
 *   wet   = lowpass(wet, clamp(20000·colorFreq, 20, 20000)/sr)
 *   wet   = highpass(wet, clamp(20·colorFreq, 20, 20000)/sr)
 *   out   = crossfade(in, wet, mix);  lastWet = wet
 *
 * ── THE TWO THINGS THAT ARE THE SOUND ──────────────────────────────────────
 *  1. THE CHASE, NOT THE DELAY. The read rate is `1/ratio` where ratio is
 *     `4^clamp(consume/10000, ±1)`, so a time change does not jump — the module
 *     resamples its history until the buffered length matches, which transposes
 *     the repeats by up to two octaves while it catches up. Ported exactly;
 *     `consume/10000` means it takes seconds to settle, which is why the effect
 *     is musical rather than a glitch.
 *  2. ONE KNOB, TWO FILTERS, MOVING OPPOSITE WAYS. `colorFreq = 100^(2·tone−1)`
 *     drives BOTH a lowpass at `20000·colorFreq` and a highpass at
 *     `20·colorFreq`, each clamped to the audio band — so turning tone down
 *     darkens the repeats and turning it up thins them, from one control. Two
 *     separate `RcFilter`s, and their `highpass()` reading `x[n−1] − y` rather
 *     than `x − y` is part of it (see `RcFilter`).
 *
 * DEVIATIONS: D4 (linear interpolation under their exact ratio, not
 * `SRC_SINC_FASTEST`), D10 (`clock` latches on its first edge). NOT
 * `feedbackSafe`: the recursion is inside the module, which
 * `core/audio_specs.js`'s DELAY_SPEC settles as "not a cycle in the graph", and
 * `tests/audio_nodes_test.js` pins that flag to exactly one port in the repo.
 */
export class DelayKernel {
  /** @param {number} sampleRate */
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    this.sampleTime = 1 / sampleRate;
    this.history = new Float64Array(DELAY_HISTORY_SIZE);
    this.writeIndex = 0;
    this.readPosition = 0;
    this.buffered = 0;
    this.lastWet = 0;
    this.lowpassFilter = new RcFilter();
    this.highpassFilter = new RcFilter();
    this.clockFreq = DELAY_UNPATCHED_CLOCK_HZ;
    this.clockPatched = false;
    this.clockTrigger = new SchmittTrigger();
    this.clockTimer = new Timer();
  }

  /**
   * Command. One sample.
   *
   * @param {object} c - controls: `time`, `feedback`, `tone`, `mix`, `timeCv`,
   *                     `feedbackCv`, `toneCv`, `mixCv`, `in_*` twins,
   *                     `in_clock`
   * @param {ArrayLike<number>} ins - [in] in volts
   * @param {Float64Array} out - [mix, wet] in volts
   */
  sample(c, ins, out) {
    this.clockTimer.process(this.sampleTime);
    if (this.clockTrigger.process(c.in_clock, TRIGGER_LOW, TRIGGER_HIGH)) {
      const measured = 1 / this.clockTimer.time;
      this.clockTimer.reset();
      this.clockPatched = true;
      if (measured >= LFO_CLOCK_MIN_HZ && measured <= LFO_CLOCK_MAX_HZ) this.clockFreq = measured;
    }
    if (!this.clockPatched) this.clockFreq = DELAY_UNPATCHED_CLOCK_HZ;

    const input = ins[0];
    const feedback = clamp(c.feedback + c.in_feedback * c.feedbackCv, 0, 1);
    const dry = input + this.lastWet * feedback;

    // THEIR DIAL, INVERTED (law L2). Their `pitch = log2(1000) −
    // log2(10000)·dial` with `time = 0.001·10000^dial` reduces to `−log2(time)`,
    // which is exact at every dial position. NOTE WHAT THE CLOCK DOES TO THIS
    // KNOB'S UNIT: `freq = clockFreq/2 · 2^pitch`, so with a clock patched the
    // delay becomes a DIVISION of that clock and the knob reads as a ratio rather
    // than as seconds — their behaviour, and their panel label is equally silent
    // about it.
    const pitch = -Math.log2(c.time) + c.in_time / SEMITONES_PER_OCTAVE * c.timeCv;
    const freq = this.clockFreq / 2 * exp2Taylor5(pitch);
    let index = this.sampleRate / freq;
    index -= DELAY_INDEX_FUDGE;
    index = clamp(index, DELAY_MIN_INDEX, DELAY_HISTORY_SIZE - 1);

    this.history[this.writeIndex] = dry;
    this.writeIndex = (this.writeIndex + 1) % DELAY_HISTORY_SIZE;
    this.buffered += 1;

    const consume = index - this.buffered;
    const ratio = DELAY_RATIO_BASE ** clamp(consume / DELAY_CONSUME_SCALE, -1, 1);
    let wet = this.read();
    this.readPosition += 1 / ratio;
    this.buffered -= 1 / ratio;
    wet = clamp(wet, -DELAY_WET_LIMIT, DELAY_WET_LIMIT);

    const color = clamp(c.tone + c.in_tone * c.toneCv, 0, 1);
    const colorFreq = DELAY_COLOR_BASE ** (2 * color - 1);
    const lowpassFreq = clamp(DELAY_LOWPASS_HZ * colorFreq, DELAY_TONE_MIN_HZ, DELAY_TONE_MAX_HZ);
    this.lowpassFilter.setCutoffFreq(lowpassFreq / this.sampleRate);
    this.lowpassFilter.process(wet);
    wet = this.lowpassFilter.lowpass();
    const highpassFreq = clamp(DELAY_HIGHPASS_HZ * colorFreq, DELAY_TONE_MIN_HZ, DELAY_TONE_MAX_HZ);
    this.highpassFilter.setCutoffFreq(highpassFreq / this.sampleRate);
    this.highpassFilter.process(wet);
    wet = this.highpassFilter.highpass();

    out[1] = wet;
    this.lastWet = wet;
    const mix = clamp(c.mix + c.in_mix * c.mixCv, 0, 1);
    out[0] = crossfade(input, wet, mix);
  }

  /**
   * Command (advances nothing; reads the ring at the fractional read position).
   * Linear interpolation — deviation D4 — and EXACT when the position is
   * integral, which is every sample once the delay has settled.
   *
   * @returns {number} the delayed sample, in volts
   */
  read() {
    const position = this.readPosition % DELAY_HISTORY_SIZE;
    const i0 = Math.floor(position);
    const frac = position - i0;
    const a = this.history[i0];
    const b = this.history[(i0 + 1) % DELAY_HISTORY_SIZE];
    return frac === 0 ? a : a + (b - a) * frac;
  }
}

/** `HISTORY_SIZE = 1 << 21` — 43.7 s at 48 kHz, so the 10 s maximum fits with
 *  room for the chase to overshoot. */
const DELAY_HISTORY_SIZE = 1 << 21;

/** `clockFreq = 2.f` when the clock jack is empty, exactly as the LFO's. */
const DELAY_UNPATCHED_CLOCK_HZ = 2;

/** `time = 0.001 · 10000^TIME_PARAM` — the pre-2.0 time dial, whose two constants
 *  are the SPEC's range in seconds (1 ms…10 s) and are exported for the test that
 *  re-derives it. */
export const DELAY_TIME_MIN_SECONDS = 0.001;
export const DELAY_TIME_MAX_SECONDS = 10;

/** `index -= 16 + 4.f` — "In order to delay accurate samples, subtract by the
 *  historyBuffer size, and an experimentally tweaked amount." Their words, their
 *  fudge; it is 0.4 ms and it is what makes a clocked delay land on the beat. */
const DELAY_INDEX_FUDGE = 20;

/** `clamp(index, 2.f, HISTORY_SIZE − 1)`. */
const DELAY_MIN_INDEX = 2;

/** `ratio = pow(4.f, clamp(consume / 10000.f, -1.f, 1.f))` — the chase (trap 1). */
const DELAY_RATIO_BASE = 4;
const DELAY_CONSUME_SCALE = 10000;

/** `clamp(wet, -100.f, 100.f)` — a runaway feedback loop is bounded at 100 V
 *  rather than allowed to reach infinity; 20 on our wires, by law L1. */
const DELAY_WET_LIMIT = 100 / VOLTS_PER_AUDIO_UNIT;

/** `colorFreq = pow(100.f, 2.f*color − 1.f)`, then 20 kHz lowpass and 20 Hz
 *  highpass corners scaled by it and clamped to the audio band. */
const DELAY_COLOR_BASE = 100;
const DELAY_LOWPASS_HZ = 20000;
const DELAY_HIGHPASS_HZ = 20;
const DELAY_TONE_MIN_HZ = 20;
const DELAY_TONE_MAX_HZ = 20000;

/**
 * `Fundamental/SEQ3` — three CV rows, eight steps, its own clock.
 *
 * DERIVATION: `Fundamental/src/SEQ3.cpp`, `SEQ3::process`, read at 10dd016.
 *
 *   run toggles on the run button OR a rising RUN input
 *   reset: index = 0, phase = 0, and a 1 ms reset pulse
 *   external clock: rising CLOCK, IGNORED while the reset pulse is high
 *   internal clock: phase += exp2_taylor5(tempo + in_tempo·tempo_cv)·dt
 *                   clock on phase >= 1 (also ignored during reset)
 *                   clockGate = (phase < 0.5)
 *   numSteps = clamp(round(steps + in_steps·steps_cv), 1, 8)
 *   on clock: index++; wrap at numSteps
 *   if (index changed) clockPulse.trigger(1 ms)
 *   if (!clockPassthrough) clockGate = clockPulse
 *   cv_j   = cv[j][index];   step_i = (index == i) ? 10 : 0
 *   trig   = (clockGate && gates[index]) ? 10 : 0
 *   steps  = numSteps − 1;  clock/run/reset = their gates
 *
 * ── THE FOUR SEMANTICS A SEQUENCED PATCH DEPENDS ON ────────────────────────
 *  1. A CLOCK ARRIVING DURING THE RESET PULSE IS DROPPED (`clockTriggered &&
 *     !resetGate`). That 1 ms window is why a reset and a clock on the same edge
 *     leave you on step 1 rather than step 2.
 *  2. `clockPassthrough` CHANGES WHAT `clock` AND `trig` MEAN. Off (the default),
 *     both are 1 ms pulses generated on a step CHANGE; on, they are the incoming
 *     clock's own gate — so a downstream envelope sees a pulse in one mode and a
 *     50% square in the other. It is `dataToJson` state, hence a knob.
 *  3. `trig` IS GATED BY THE PER-STEP TOGGLE, not by the CV rows: a step with
 *     its gate off still outputs its three CVs. That is what makes SEQ3 usable
 *     as three independent modulation sequencers with one rhythm.
 *  4. THE STEPS INPUT IS SUMMED IN VOLTS AND ROUNDED, with `stepsCv` defaulting
 *     to 1 (their `configParam(STEPS_CV_PARAM, 0, 1, 1)` — the one attenuverter
 *     in the block whose default is NOT 0), so 1 V shortens the pattern by one
 *     step out of the box.
 *
 * DEVIATIONS: D7 (no step lights — the `step_i` OUTPUTS are real and are kept),
 * and the eight CV rows and eight gates are ordinary knobs (`cv1_1`…`cv3_8`,
 * `gate1`…`gate8`), which is R7-11's "a module's JSON fields become knobs"
 * applied to `gates[]`. `running` is likewise a knob AND a rising-edge input.
 */
export class Seq3Kernel {
  /** @param {number} sampleRate */
  constructor(sampleRate) {
    this.sampleTime = 1 / sampleRate;
    this.phase = 0;
    this.index = 0;
    this.running = true;
    this.runLatched = null;
    this.runTrigger = new SchmittTrigger();
    this.resetTrigger = new SchmittTrigger();
    this.clockTrigger = new SchmittTrigger();
    this.runPulse = new PulseGenerator();
    this.clockPulse = new PulseGenerator();
    this.resetPulse = new PulseGenerator();
    this.clockEverFired = false;
    // Built once, for the reason VcMixerKernel's constructor states: a template
    // literal per step per sample is an allocation on the audio thread.
    this.cvKeys = [[], [], []];
    this.gateKeys = [];
    for (let step = 1; step <= SEQ3_STEPS; step++) {
      for (let row = 0; row < SEQ3_ROWS; row++) this.cvKeys[row].push(`cv${row + 1}_${step}`);
      this.gateKeys.push(`gate${step}`);
    }
  }

  /**
   * Command. One sample.
   *
   * @param {object} c - controls: `tempo`, `tempoCv`, `steps`, `stepsCv`,
   *                     `running`, `clockPassthrough`, `cv1_1`…`cv3_8`,
   *                     `gate1`…`gate8`, `in_tempo`, `in_clock`, `in_reset`,
   *                     `in_steps`, `in_run`
   * @param {ArrayLike<number>} ins - []
   * @param {Float64Array} out - [cv1, cv2, cv3, trig, steps, clock, run, reset,
   *                             step1 … step8] in volts
   */
  sample(c, ins, out) {
    // `running` is a knob AND a rising-edge input, so the knob is the value
    // until an edge arrives and the LATCH is the value afterwards — the same
    // shape D10's clock latch takes, for the same reason: a toggle whose only
    // authority was the document could never be toggled by a wire.
    if (this.runLatched === null) this.running = c.running > 0;
    if (this.runTrigger.process(c.in_run, TRIGGER_LOW, TRIGGER_HIGH)) {
      this.runLatched = !(this.runLatched === null ? this.running : this.runLatched);
      this.running = this.runLatched;
      this.runPulse.trigger(PULSE_SECONDS);
    }
    const runGate = this.runPulse.process(this.sampleTime);

    const oldIndex = this.index;

    if (this.resetTrigger.process(c.in_reset, TRIGGER_LOW, TRIGGER_HIGH)) {
      this.resetPulse.trigger(PULSE_SECONDS);
      this.index = 0;
      this.phase = 0;
    }
    const resetGate = this.resetPulse.process(this.sampleTime);

    let clock = false;
    let clockGate = false;
    if (this.running) {
      // THE CLOCK TRIGGER IS PROCESSED FIRST AND THE LATCH READ SECOND, and the
      // order is load-bearing: D10's latch can only be set by an edge, so
      // gating the `process()` call on the latch would mean the latch was never
      // set and an externally-clocked SEQ3 ran on its internal tempo forever.
      // Only inside `running`, as theirs is.
      const clockTriggered = this.clockTrigger.process(c.in_clock, TRIGGER_LOW, TRIGGER_HIGH);
      if (clockTriggered) this.clockEverFired = true;
      if (this.clockEverFired) {
        if (clockTriggered && !resetGate) clock = true;
        clockGate = this.clockTrigger.isHigh();
      } else {
        // Their `TEMPO_PARAM` is log2 hertz DISPLAYED as bpm at 60x; law L2 makes
        // the knob the bpm, which is also our own CLOCK_SPEC's unit.
        const clockPitch = Math.log2(c.tempo / SECONDS_PER_MINUTE)
          + c.in_tempo / SEMITONES_PER_OCTAVE * c.tempoCv;
        this.phase += exp2Taylor5(clockPitch) * this.sampleTime;
        if (this.phase >= 1 && !resetGate) {
          clock = true;
          this.phase -= Math.trunc(this.phase);
        }
        clockGate = this.phase < SEQ3_CLOCK_DUTY;
      }
    }

    const steps = c.steps + c.in_steps * c.stepsCv;
    const numSteps = clamp(roundHalfAwayFromZero(steps), 1, SEQ3_STEPS) | 0;

    if (clock) {
      this.index++;
      if (this.index >= numSteps) this.index = 0;
    }
    if (this.index !== oldIndex) this.clockPulse.trigger(PULSE_SECONDS);
    if (c.clockPassthrough < 0.5) clockGate = this.clockPulse.process(this.sampleTime);

    const i = this.index;
    out[0] = c[this.cvKeys[0][i]];
    out[1] = c[this.cvKeys[1][i]];
    out[2] = c[this.cvKeys[2][i]];
    out[3] = clockGate && c[this.gateKeys[i]] > 0 ? GATE_HIGH : 0;
    out[4] = numSteps - 1;
    out[5] = clockGate ? GATE_HIGH : 0;
    out[6] = runGate ? GATE_HIGH : 0;
    out[7] = resetGate ? GATE_HIGH : 0;
    for (let s = 0; s < SEQ3_STEPS; s++) {
      out[SEQ3_STEP_OUTPUT_BASE + s] = i === s ? GATE_HIGH : 0;
    }
  }
}

/** Their `configParam(TEMPO_PARAM, …, 2.f, 60.f)` displays a log2-hertz dial as
 *  beats per minute, which is the unit law L2 keeps. */
const SECONDS_PER_MINUTE = 60;

/** `clockGate = (phase < 0.5f)` — the internal clock's duty cycle. */
const SEQ3_CLOCK_DUTY = 0.5;

/** Eight steps, three CV rows, and eight `STEP_OUTPUTS` after the eight scalar
 *  outputs (`cv1..3, trig, steps, clock, run, reset`). */
const SEQ3_STEPS = 8;
const SEQ3_ROWS = 3;
const SEQ3_STEP_OUTPUT_BASE = 8;
