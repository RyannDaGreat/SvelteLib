/**
 * THE AX-3 FILTER KERNELS — nine Axoloti filters' arithmetic, and nothing else.
 *
 * No AudioNode, no AudioWorklet, no DOM: a plain ES module, so
 * `tests/port_ax3_test.js` can run every recurrence in BARE NODE and compare it
 * against an integer model of the original C. THE ARITHMETIC IS THE DELIVERABLE,
 * so the arithmetic has to be reachable by a test that needs no browser — which
 * is the reasoning that put AX-2's minBLEP table in `ax2_kernels.js`, applied
 * here. This file replaced a design where the kernels lived INSIDE the worklet
 * and the test reached them by evaluating that file behind a shim; one copy in a
 * normal module is plainly better than one copy behind an eval.
 *
 * `worklets/processors_ax3.js` imports this and wraps each kernel in an
 * AudioWorkletProcessor; `modules_ax3.js` wires those into engine modules and
 * owns the URL the engine loads.
 *
 * ⚠ THAT URL MUST GO THROUGH VITE'S WORKER PIPELINE. A plain
 * `new URL("./worklets/processors_ax3.js", import.meta.url)` copies the worklet
 * into the build BYTE FOR BYTE and never emits this file at all, so the import
 * below 404s in production while the build exits 0. Measured, both directions;
 * the evidence and the fix are in modules_ax3.js.
 *
 * ── THE DERIVATION RECORDS ARE NOT HERE ─────────────────────────────────────
 * Each node's source object, commit, code block, float recurrence and named
 * deviations live on its spec in `core/audio_specs_ax3.js` (R7-17's debugging
 * record). Every function below cites the firmware file and line it came from;
 * the spec is where the WHY of each deviation is written down.
 *
 * ── THE ARITHMETIC LAWS THESE KERNELS OBEY (manifest § R7-11) ───────────────
 * - `frac32` is signed Q27: full scale +/-1.0, with +/-16.0 of headroom above it.
 *   Everything here works in the +/-1.0 domain, so the headroom shows up only
 *   where the original SATURATES or WRAPS at int32 — and where it does, so do we.
 * - THE CONTROL RATE IS fs/16 — 3000 Hz on their 48 kHz, EIGHT ticks per
 *   128-frame quantum. Coefficient computation is separated from the per-sample
 *   recurrence here; the PROCESSOR drives that split, and hoisting it to once per
 *   quantum runs every filter 8x slow.
 * - Coefficients are HELD across their sixteen samples, never interpolated. The
 *   one exception is `axZdfUpdate`, whose author wrote his own /16 ramp — and his
 *   is deliberately one buffer LATE, which is reproduced.
 * - PITCH IS SEMITONES and pitch 0 = MIDI 64 = E4 = 329.6276 Hz. See
 *   core/audio_specs_ax3.js on why these nodes are tuned in semitones rather than
 *   in the hertz the rest of the library uses.
 */

// ── THE SHARED FIXED-POINT LAWS, IN FLOAT ───────────────────────────────────

/** Axoloti's `BUFSIZE`. Its control rate is fs/16 — 3000 Hz at 48 kHz. */
export const AX_BUFSIZE = 16;

/** A frac32 dial reads 0…64 for 0…1.0 (`ValueFrac32.getFrac()` is `v * 2^21`,
 *  and `__USAT(.,27)` clamps at 64). Resonance dials are quoted on this scale
 *  because the coefficient really is `1 - dial/64`; see `axQinv`. */
export const AX_DIAL_FULL = 64;

/**
 * frac32 is Q27 inside an int32, so the representable range is ±2^31/2^27. A state
 * variable that overflows on their hardware WRAPS through this span.
 *
 * ⚠ `Math.pow(2, 31)`, NOT `1 << 31`. JavaScript's shift operators are defined on
 * SIGNED 32-bit integers, so `1 << 31` is -2147483648 and this constant shipped as
 * MINUS sixteen — which railed vcf3's saturator at the wrong sign (a constant
 * -16.0 output) and made `axWrapFrac32` take its slow path on every sample while
 * still returning the right answer, because the two sign errors cancelled in the
 * interior. Caught by a browser render, NOT by the node suite, because the suite
 * had spelled the same limit as its own literal; it now reads the constant.
 */
export const FRAC32_ONE = Math.pow(2, 27);
export const FRAC32_HEADROOM = Math.pow(2, 31) / FRAC32_ONE;
export const FRAC32_SPAN = FRAC32_HEADROOM * 2;

/** A440, and the offset that puts pitch 0 at MIDI 64. */
export const AX_A440_HZ = 440;
export const AX_PITCH_A440_SEMITONES = 5;
export const AX_SEMITONES_PER_OCTAVE = 12;

/**
 * Pure function. Axoloti pitch (semitones, 0 = MIDI 64 = E4) to hertz.
 *
 * `pitcht[]` is built as `440 * 2^((i - 69 - 64)/12)` and indexed at 128+pitch,
 * so pitch 0 is MIDI 64. THE PIECEWISE-LINEAR INTERPOLATION IS NOT REPRODUCED:
 * their table exists to avoid a `pow()` on a Cortex-M4 and its ≤0.7-cent error is
 * an artefact of a lookup we do not perform.
 *
 * @param {number} pitch - semitones relative to E4
 * @returns {number} hertz
 *
 * @example axPitchToHz(0) // 329.62755691287
 * @example axPitchToHz(5) // 440
 * @example axPitchToHz(12) / axPitchToHz(0) // 2
 */
export function axPitchToHz(pitch) {
  return AX_A440_HZ * Math.pow(2, (pitch - AX_PITCH_A440_SEMITONES) / AX_SEMITONES_PER_OCTAVE);
}

/**
 * Pure function. The cutoff a pitch names, with `mtof`'s hard clamp applied.
 *
 * `axoloti_math.c` clamps `pitcht` at `phi > 1<<31`, i.e. at exactly half the
 * sample rate, and that clamp is LOAD-BEARING: it is the point where the one-pole's
 * alpha reaches 1.0. Reproduced against the RUNNING sample rate rather than a
 * hard-wired 24000 so the port still tunes correctly on a 44.1 kHz context.
 *
 * @param {number} pitch - semitones relative to E4
 * @param {number} fs - sample rate in hertz
 * @returns {number} hertz, never above fs/2
 *
 * @example axCutoffHz(0, 48000) // 329.62755691287
 * @example axCutoffHz(96, 48000) // 24000
 */
export function axCutoffHz(pitch, fs) {
  return Math.min(axPitchToHz(pitch), fs / 2);
}

/**
 * Pure function. Inverse-Q from a resonance dial: `qinv = 1 - dial/64 = 1/(2Q)`,
 * with `Q = 32/(64 - dial)` — exactly `FilterQ.java`.
 *
 * THE FLOOR IS NOT A SAFETY NET, IT IS THEIRS. `__USAT(param_reso, 27)` saturates
 * at `2^27 - 1`, so `INT_MAX - (that << 4)` leaves sixteen units, i.e. one LSB of
 * q31. A qinv of exactly 0 would be a biquad with a ZERO NUMERATOR — silence —
 * where the hardware rings at Q = 2^26.
 *
 * @param {number} dial - resonance, 0…64
 * @returns {number} 1/(2Q)
 *
 * @example axQinv(0) // 1
 * @example axQinv(32) // 0.5
 * @example axQinv(48) // 0.25
 * @example // the dial's own top end can never reach zero
 * @example axQinv(64) // 7.450580596923828e-9
 */
export const AX_QINV_MIN = 16 / Math.pow(2, 31);
export function axQinv(dial) {
  const d = dial < 0 ? 0 : dial > AX_DIAL_FULL ? AX_DIAL_FULL : dial;
  const qinv = 1 - d / AX_DIAL_FULL;
  return qinv < AX_QINV_MIN ? AX_QINV_MIN : qinv;
}

/**
 * Pure function. Saturate to ±1.0 — `__SSAT(x, 28)` on a frac32.
 *
 * @param {number} x
 * @returns {number}
 *
 * @example axSat1(0.5) // 0.5
 * @example axSat1(3) // 1
 * @example axSat1(-3) // -1
 */
export function axSat1(x) {
  return x > 1 ? 1 : x < -1 ? -1 : x;
}

/**
 * Pure function. int32 WRAPAROUND in the frac32 domain — what an unsaturated
 * Axoloti state variable does when it overflows.
 *
 * The Chamberlin SVF's `low` and `band` carry no `__SSAT` at all, so at high
 * cutoff with high resonance theirs does not explode, it FOLDS. Reproducing the
 * fold rather than clamping keeps the port bounded without inventing a limiter
 * their filter does not have.
 *
 * @param {number} x
 * @returns {number} x mapped into [-16, 16)
 *
 * @example axWrapFrac32(0.25) // 0.25
 * @example axWrapFrac32(17) // -15
 * @example axWrapFrac32(-17) // 15
 */
export function axWrapFrac32(x) {
  if (x >= -FRAC32_HEADROOM && x < FRAC32_HEADROOM) return x;
  return x - FRAC32_SPAN * Math.floor((x + FRAC32_HEADROOM) / FRAC32_SPAN);
}

/**
 * Pure function. One a-rate AudioParam's value at a sample index.
 *
 * An unconnected AudioParam arrives as a length-1 array holding its constant;
 * a driven one arrives with one entry per frame. Both are normal, and reading
 * `[0]` for the constant case is the spec's own contract, not a fallback.
 *
 * @param {Float32Array} p - a parameter array from `process`'s third argument
 * @param {number} i - sample index within the quantum
 * @returns {number}
 *
 * @example axParamAt(new Float32Array([7]), 99) // 7
 * @example axParamAt(new Float32Array([1, 2, 3]), 2) // 3
 */
export function axParamAt(p, i) {
  return p.length === 1 ? p[0] : p[i];
}

/** The three biquad numerators, as integers so the sample loop compares no
 *  strings. `mode` arrives from the Inspector as a word and is mapped once. */
export const AX_BIQUAD_LOWPASS = 0;
export const AX_BIQUAD_BANDPASS = 1;
export const AX_BIQUAD_HIGHPASS = 2;
export const AX_BIQUAD_MODES = { lowpass: AX_BIQUAD_LOWPASS, bandpass: AX_BIQUAD_BANDPASS, highpass: AX_BIQUAD_HIGHPASS };

/**
 * Pure function. `biquad_lp_coefs` / `biquad_bp_coefs` / `biquad_hp_coefs`
 * (axoloti/axoloti `firmware/axoloti_filters.h:97-169` @ tag 1.0.12) in float.
 *
 * ⚠ THE EXTRA `qinv`. The low- and high-pass numerators carry a constant-peak-gain
 * normalisation the textbook RBJ cookbook does not — the outer
 * `___SMMUL(..., q_inv)` at `:111` and `:166`. DC gain is therefore `1/(2Q)` and
 * the peak stays near 0.5 at every Q. OMIT IT AND EVERY RESONANT SWEEP IS FAR TOO
 * LOUD. The BANDPASS has no such factor — its `b0 = alpha/a0` is already
 * constant-peak, which is what its own source comment says.
 *
 * Returns coefficients in `biquad_dsp`'s own sign convention: `cy1` and `cy2` are
 * SUBTRACTED (they are `a1/a0` and `a2/a0`, not their negatives).
 *
 * @param {number} mode - AX_BIQUAD_LOWPASS | AX_BIQUAD_BANDPASS | AX_BIQUAD_HIGHPASS
 * @param {number} fc - cutoff in hertz, already clamped to fs/2
 * @param {number} dial - resonance dial, 0…64
 * @param {number} fs - sample rate
 * @param {Float64Array} out - five slots: b0, b1, b2, cy1, cy2
 * @returns {void} (writes `out`)
 *
 * @example // a gentle lowpass at 1 kHz: the extra qinv leaves DC gain at 1/(2Q) = 1
 * @example // axBiquadCoefs(0, 1000, 0, 48000, o); o[0] + o[1] + o[2] // 0.9999999... at Q=0.5
 * @example // at dial 48 (Q=2) the SAME sum is 0.25, not 1 — that is the normalisation
 */
export function axBiquadCoefs(mode, fc, dial, fs, out) {
  const qinv = axQinv(dial);
  const w0 = 2 * Math.PI * fc / fs;
  const cosW0 = Math.cos(w0);
  const alpha = Math.sin(w0) * qinv;
  const a0 = 1 + alpha;
  if (mode === AX_BIQUAD_BANDPASS) {
    const b0 = alpha / a0;
    out[0] = b0;
    out[1] = 0;
    out[2] = -b0;
  } else if (mode === AX_BIQUAD_HIGHPASS) {
    const b0 = ((1 + cosW0) / 2) * qinv / a0;
    out[0] = b0;
    out[1] = -2 * b0;
    out[2] = b0;
  } else {
    const b0 = ((1 - cosW0) / 2) * qinv / a0;
    out[0] = b0;
    out[1] = 2 * b0;
    out[2] = b0;
  }
  out[3] = (-2 * cosW0) / a0;
  out[4] = (1 - alpha) / a0;
}

/**
 * Pure function. `f_filter_biquad_A` (axoloti/axoloti
 * `firmware/axoloti_filters.c:72-118` @ tag 1.0.12) in float.
 *
 * THIS IS NOT `biquad_lp_coefs` WITH A DIFFERENT NAME, and two differences change
 * the sound rather than the arithmetic:
 *
 *  1. NO EXTRA `qinv` on the numerator. vcf3 is the pre-normalisation filter, so
 *     its resonant sweeps genuinely DO get louder with Q — the thing the newer
 *     `filter/lp` was changed to stop doing.
 *  2. THE NUMERATOR IS `[2, 1, 2]·B0`, NOT `[1, 2, 1]·B0`. `filter_b0` is applied
 *     to x[n] AND x[n-2] while `filter_b1 = filter_b0 >> 1` — a HALVING where the
 *     newer code doubles — is applied to x[n-1]. So there is no zero at Nyquist
 *     and the passband sits ~1.9 dB high. It reads as a transcription slip in the
 *     original, but it is what a vcf3 patch was voiced against, so it is ported.
 *
 * The angle is the same as the newer path despite the missing `filter_W0 >> 1`:
 * this one calls `SINE2TINTERP`, which takes a FULL uint32 phase, where
 * `arm_sin_q31` takes q31. Two spellings of `sin(2π·fc/fs)`.
 *
 * @param {number} fc - cutoff in hertz
 * @param {number} dial - resonance dial, 0…64
 * @param {number} fs - sample rate
 * @param {Float64Array} out - four slots: bOuter (x[n] and x[n-2]), bInner (x[n-1]), cy1, cy2
 * @returns {void} (writes `out`)
 *
 * @example // axVcf3Coefs(1000, 0, 48000, o); o[1] / o[0] // 0.5 — the halving, every time
 */
export function axVcf3Coefs(fc, dial, fs, out) {
  const qinv = axQinv(dial);
  const w0 = 2 * Math.PI * fc / fs;
  const cosW0 = Math.cos(w0);
  const alpha = Math.sin(w0) * qinv;
  const a0 = 1 + alpha;
  const bOuter = (1 - cosW0) / a0;
  out[0] = bOuter;
  out[1] = bOuter / 2;
  out[2] = (-2 * cosW0) / a0;
  out[3] = (1 - alpha) / a0;
}

export const AX_ONEPOLE_LOWPASS = 0;
export const AX_ONEPOLE_HIGHPASS = 1;
export const AX_ONEPOLE_MODES = { lowpass: AX_ONEPOLE_LOWPASS, highpass: AX_ONEPOLE_HIGHPASS };

/**
 * Pure function. The one-pole coefficient, `___SMMLA((in-val)<<1, f, val)` where
 * `f` is `MTOF`'s PHASE INCREMENT — so the coefficient is `2·fc/fs`.
 *
 * ⚠ IT IS NOT `1 - exp(-2π·fc/fs)`. For a recurrence `y += α(x-y)` the -3 dB
 * point is at `α·fs/(2π)`, so this filter's corner is at `fc/π` — about a third
 * of the frequency its knob names. Copy the recurrence, not the intent.
 *
 * At `fc = fs/2` (where `mtof` clamps) α reaches exactly 1.0, which is their
 * instability point and is reproduced rather than backed away from.
 *
 * @param {number} fc - cutoff in hertz
 * @param {number} fs - sample rate
 * @returns {number} the per-sample mixing coefficient
 *
 * @example axOnePoleAlpha(1000, 48000) // 0.041666666666666664
 * @example axOnePoleAlpha(24000, 48000) // 1
 */
export function axOnePoleAlpha(fc, fs) {
  return 2 * fc / fs;
}

/**
 * Pure function. The SVF's damping term, `damp = ___SMMUL(damp, damp)` over
 * `(0x80<<24) - (param_reso<<4)`.
 *
 * TWO THINGS THAT ARE EASY TO MISS. The square has NO shift after it, and an
 * unshifted `___SMMUL` of two q31s is a BUILT-IN HALVING — so this is `qinv²/2`,
 * not `qinv²`. And `0x80<<24` overflows to INT32_MIN, which is exactly what makes
 * `-2^31 - reso` wrap to `2^31 - reso`; the resonance dial and the biquad's share
 * one `qinv`, they just use it to different powers.
 *
 * `damp` sits in the Chamberlin recursion's `1/Q` slot, so the SVF's effective Q
 * is `2/qinv²` where the biquad's is `1/(2·qinv)` — the same dial is a much
 * sharper control here.
 *
 * @param {number} dial - resonance dial, 0…64
 * @returns {number} the Chamberlin damping coefficient
 *
 * @example axSvfDamp(0) // 0.5
 * @example axSvfDamp(32) // 0.125
 * @example axSvfDamp(48) // 0.03125
 */
export function axSvfDamp(dial) {
  const qinv = axQinv(dial);
  return qinv * qinv / 2;
}

/**
 * Pure function. The SVF's frequency coefficient, `SINE2TINTERP(MTOFEXTENDED(p))`.
 *
 * ⚠ THE COEFFICIENT REUSES THE OSCILLATOR'S SINE TABLE, and that is the whole
 * trick: `MTOFEXTENDED` yields a PHASE INCREMENT, and a phase increment fed
 * straight into the sine table is `sin(2π·fc/fs)`. There is no separate tuning
 * table anywhere in the firmware. The textbook Chamberlin coefficient is
 * `2·sin(π·fc/fs)`; this is `sin(2π·fc/fs)`, which agrees with it at low cutoff
 * and DIVERGES above it — it peaks at fs/4 and then FALLS, so above a quarter of
 * the sample rate their filter tunes backwards. That fold is the sound of a high
 * SVF sweep on this platform.
 *
 * @param {number} fc - cutoff in hertz
 * @param {number} fs - sample rate
 * @returns {number} the Chamberlin frequency coefficient
 *
 * @example axSvfF(1000, 48000) // 0.13052619222005157
 * @example axSvfF(12000, 48000) // 1
 * @example // the fold: 18 kHz tunes to the same coefficient as 6 kHz
 * @example axSvfF(18000, 48000) - axSvfF(6000, 48000) // 0
 */
export function axSvfF(fc, fs) {
  return Math.sin(2 * Math.PI * fc / fs);
}

/** Both delay lines are sized at the largest the sources allow: TSG's biggest
 *  `buffsize` combo entry is 16384 (341 ms at 48 kHz) and `filter/allpass`'s
 *  spinner tops out at 10000, so this covers both. A power of two so the read
 *  pointer wraps with a mask, exactly as TSG's does. */
export const AX_DELAY_LINE_SAMPLES = 16384;
export const AX_DELAY_LINE_MASK = AX_DELAY_LINE_SAMPLES - 1;

/** TSG refuses to read closer than eight samples behind the write head; the
 *  fixed-delay object's own spinner floor is 1. Eight is the binding one. */
export const AX_MIN_DELAY_SAMPLES = 8;

/**
 * tiar's own state limit, `(0x1FFFFFFF) - (1<<20)` in frac32 units: just under
 * ±4.0, applied ONCE PER CONTROL TICK rather than per sample. Reproduced at the
 * same rate, because a per-sample clamp is a different (softer) nonlinearity.
 */
export const ZDF_STATE_LIMIT = (0x1FFFFFFF - (1 << 20)) / FRAC32_ONE;

/**
 * tiar's `TRF_coef` folded into (fc, fs). His constant is
 * `(820/2^27)·2π/(128·48000)` multiplied by `MTOFEXTENDED`'s phase increment
 * `2^32·fc/fs`, and everything but `205·2π·fc/fs²` cancels. Kept in this reduced
 * form because the original spells one sample rate in two places, which would
 * silently mistune the port at 44.1 kHz.
 */
export const ZDF_TRF_SCALE = 205;

/**
 * Pure function. tiar's `update()` — the "ZDF step invariant" coefficient step.
 *
 * A Chamberlin one-step state matrix is built at a heavily oversampled rate, then
 * SQUARED seven times, which raises it to the 128th power — that is the whole
 * method, and it is why the filter stays stable and in tune where a plain
 * Chamberlin does not. The three deltas at the end are his per-sample
 * interpolation, and like Axoloti's `gain/vca` ramp they are deliberately ONE
 * BUFFER LATE: `a` starts this block at the PREVIOUS block's value and only
 * reaches the new one at the sixteenth sample.
 *
 * @param {number} d - damping, 1/(2q)
 * @param {number} f - the oversampled frequency coefficient
 * @param {Float64Array} s - nine slots: a, b, c (current), na, nb, nc (target), da, db, dc
 * @returns {void} (writes slots 3…8 of `s`)
 *
 * @example // axZdfUpdate(1, 0.003125, s) leaves s[3] (na) just under 1 — a wide-open filter
 */
export function axZdfUpdate(d, f, s) {
  let a = f * f;
  const tmp = 1 - a - d * f;
  let b = f * tmp + f;
  let c = tmp * tmp - a;
  let na = 0;
  let nb = 0;
  let nc = 0;
  for (let step = 0; step < 7; step++) {
    const b2 = b * b;
    na = b2 + a * (2 - a);
    nb = b * (1 + c - a);
    nc = c * c - b2;
    a = na;
    b = nb;
    c = nc;
  }
  s[3] = na;
  s[4] = nb;
  s[5] = nc;
  s[6] = (na - s[0]) / AX_BUFSIZE;
  s[7] = (nb - s[1]) / AX_BUFSIZE;
  s[8] = (nc - s[2]) / AX_BUFSIZE;
}

/**
 * Pure function. tiar's resonance map, `0.25 + q(1 + q²(18.75 + 60q))`, verbatim
 * from his `code.krate` — a quartic that takes the 0…1 dial to Q = 0.25…80. The
 * numbers are his curve, not a derivation of ours.
 *
 * @param {number} dial - resonance dial, 0…64
 * @returns {number} Q
 *
 * @example axZdfQ(0) // 0.25
 * @example axZdfQ(64) // 80
 */
export function axZdfQ(dial) {
  const d = dial < 0 ? 0 : dial > AX_DIAL_FULL ? AX_DIAL_FULL : dial;
  const q = d / AX_DIAL_FULL;
  return 0.25 + q * (1 + q * q * (18.75 + q * 60));
}

/**
 * tiar's ten tabulated 10-pole Butterworth lowpasses — five cascaded biquads
 * each, `(b0, a1)` per stage, verbatim from his `code.krate`. The remaining
 * coefficients are DERIVED in his `calc()` and are derived here too rather than
 * tabulated: `b1 = 2·b0` and `a2 = 1 - 2·b1 - a1`, the latter being what pins
 * unity gain at DC.
 *
 * The keys are his own menu labels. They are nominal cutoffs AT 48 kHz — a design
 * he baked in as numbers, so on a 44.1 kHz context every one of them lands
 * proportionally lower. Named in the spec rather than silently rescaled, because
 * rescaling would need the pole positions he did not ship.
 */
export const AX_BUTT10_STAGES = Object.freeze({
  "17.7k": [[0.753126, -1.218067], [0.486465, -0.786782], [0.629527, -1.018164], [0.507411, -0.820659], [0.552540, -0.893649]],
  "15.3k": [[0.621309, -0.733416], [0.373874, -0.441334], [0.502253, -0.592878], [0.392078, -0.462823], [0.431976, -0.509921]],
  "12.7k": [[0.472370, -0.158397], [0.275096, -0.092246], [0.375837, -0.126027], [0.289176, -0.096968], [0.320270, -0.107394]],
  "9k": [[0.269777, 0.668954], [0.161365, 0.400131], [0.217451, 0.539203], [0.169297, 0.419799], [0.186705, 0.462966]],
  "6.5k": [[0.152447, 1.180262], [0.097731, 0.756643], [0.126983, 0.983119], [0.101999, 0.789688], [0.111212, 0.861017]],
  "4.2k": [[0.068127, 1.576759], [0.048594, 1.124686], [0.059553, 1.378322], [0.050275, 1.163580], [0.053804, 1.245270]],
  "3.3k": [[0.043113, 1.704935], [0.032490, 1.284833], [0.038593, 1.526199], [0.033451, 1.322835], [0.035439, 1.401464]],
  "2.5k": [[0.025268, 1.803428], [0.020139, 1.437375], [0.023156, 1.652679], [0.020627, 1.472214], [0.021621, 1.543164]],
  "1.4k": [[0.008141, 1.912150], [0.007095, 1.666465], [0.007733, 1.816243], [0.007203, 1.691808], [0.007417, 1.742062]],
  "900": [[0.003403, 1.950375], [0.003105, 1.779490], [0.003290, 1.885522], [0.003137, 1.797855], [0.003200, 1.833754]],
});

export const AX_BUTT10_STAGE_COUNT = 5;
export const AX_BUTT10_DEFAULT_FC = "9k";
