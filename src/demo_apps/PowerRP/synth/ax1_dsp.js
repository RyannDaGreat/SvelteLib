/**
 * AX-1 PORTED DSP — Axoloti's integer arithmetic, logic and step tables, in float.
 *
 * ── WHAT THIS FILE IS ───────────────────────────────────────────────────────
 * Axoloti is a fixed-point machine: every value is an `int32_t` whose meaning is a
 * CONVENTION rather than a type, and every object's body is two or three lines of
 * shifts and `___SMMUL`. We run on float32 in an AudioWorklet. This file is the
 * translation, and it holds BOTH sides of it on purpose:
 *
 *   `axInt*` / `AX_INT_OPS`  — the EXACT integer recurrence, transcribed from the
 *                              `.axo`'s own `<code.krate>` / `<code.srate>`.
 *   `axFloat*` / `AX_FLOAT_OPS` — what we actually run.
 *
 * KEEPING THE INTEGER SIDE IS THE POINT, not archaeology. Port fidelity is a
 * NUMERIC claim ("mathematically near identical so that they sound the same",
 * manifest § R7-11), and a numeric claim is proven by measurement: tests/port_ax1_test.js
 * sweeps every op through both and reports MAX ABSOLUTE ERROR. Without the integer
 * side there is nothing to measure against and "faithful" would be an assertion.
 *
 * ── THE THREE LAYERS (manifest § R7-11; get these wrong and the port is silently
 *    off by a factor of 16) ────────────────────────────────────────────────────
 *
 *     XML dial value (−64…64) ──×2^21──▶ raw int32 ──pfunction──▶ param_X ──/2^27──▶ float
 *
 * - `frac32` is signed Q4.27: `real = i / 2^27`. Audio full scale ±1.0 = ±2^27,
 *   with ±16.0 of headroom above it. **A dial reading 64 IS 1.0.**
 * - `param_X` IS NOT THE DIAL VALUE — every param goes through a `pfunction` first
 *   (firmware/parameter_functions.h). `axParam*` below is that layer.
 * - `bool32 → frac32` is **+1.0**, not +1/64. `frac32 → int32` is `>>21`.
 *
 * ── THE K-RATE BRIDGE ───────────────────────────────────────────────────────
 * Axoloti is 48 kHz with `BUFSIZE 16`, so its control rate is EXACTLY 3000 Hz. In a
 * 128-frame AudioWorklet quantum that is 8 k-rate ticks, each followed by 16 samples.
 * `AX_KRATE_BLOCK` is that 16 and `synth/worklets/processors_ax1.js` is where it is
 * spent. Hoisting k-rate work to once per quantum is the obvious optimisation and
 * makes every one of these run 8× slow.
 *
 * ── WHY THE WORKLET RESTATES THESE INSTEAD OF IMPORTING THEM ────────────────
 * The AudioWorklet global scope cannot import. `synth/worklets/processors.js`
 * already carries that duplication for SCHMITT_LOW/SCHMITT_HIGH with a test pinning
 * the two files together; this file follows that precedent exactly, and
 * tests/port_ax1_test.js pins the shared constants the same way.
 *
 * Nothing here imports PowerRP or a browser global: it is ordinary arithmetic, so it
 * runs in bare node and every claim in it is testable there.
 *
 * All functions are PURE unless their docstring says otherwise.
 */

// ─── The number formats ──────────────────────────────────────────────────────

/** frac32 1.0 — audio full scale. `real = i / FRAC32_ONE` (signed Q4.27). */
export const FRAC32_ONE = 2 ** 27;
/** q31 1.0 — the format table outputs, phase fractions and `finalvalue` use. */
export const Q31_ONE = 2 ** 31;
/** One Axoloti DIAL UNIT in raw int32. A dial reading 64 is 64·2^21 = frac32 1.0. */
export const XML_TO_RAW = 2 ** 21;
/** The dial's full-scale reading. `dial 64 ⟺ 1.0` is the whole R7-11 trap. */
export const AX_DIAL_FULL_SCALE = 64;

/** Axoloti's sample rate (firmware/axoloti_defines.h:26 `#define SAMPLERATE 48000`). */
export const AX_SAMPLE_RATE = 48000;
/** Axoloti's control block, in samples (`#define BUFSIZE 16`). */
export const AX_KRATE_BLOCK = 16;
/** The control rate, 48000/16 = 3000 Hz EXACTLY. Every recurrence below ticks here. */
export const AX_CONTROL_RATE = AX_SAMPLE_RATE / AX_KRATE_BLOCK;

// ─── The fixed-point primitives (firmware/axoloti_math.h:61-82) ──────────────
// One ARM instruction each on the real hardware. Reproduced here in BigInt so the
// 64-bit intermediate is exact — `a * b` in doubles loses bits above 2^53 and the
// products here reach 2^62, so a plain multiply would quietly round the reference
// we are measuring against.

/**
 * Pure function. `___SMMUL(a,b)` — the high half of a 32×32 product:
 * `(int32_t)(((int64_t)a * b) >> 32)`.
 *
 * THE GENERAL LAW, because it is the single commonest way to get a port wrong:
 * `___SMMUL(a,b) << s` computes `a·b / 2^(32−s)`. The ubiquitous `<<1` is only
 * correct when one operand is a q31 coefficient; TWO frac32 operands need `<<5`.
 * Off by that and a gain is off by 16×.
 *
 * @param {number} a - int32
 * @param {number} b - int32
 * @returns {number} int32
 *
 * @example axSmmul(1 << 30, 1 << 30) // 2 ** 28  — 0.25·0.25 in q31 is 0.0625·2^32/2^32
 * @example axSmmul(-(1 << 31), 1 << 30) // -(2 ** 29)
 * @example axSmmul(0, 12345) // 0
 */
export function axSmmul(a, b) {
  return Number((BigInt.asIntN(32, BigInt(a | 0)) * BigInt.asIntN(32, BigInt(b | 0))) >> 32n);
}

/**
 * Pure function. `___SMMLA(a,b,acc)` — multiply-accumulate: `acc + ((a*b) >> 32)`.
 * The accumulator form; it is NEVER shifted in the sources (208 uses, 0 shifted).
 *
 * @param {number} a - int32
 * @param {number} b - int32
 * @param {number} acc - int32 accumulator
 * @returns {number} int32
 *
 * @example axSmmla(1 << 30, 1 << 30, 7) // 2 ** 28 + 7
 * @example axSmmla(0, 999, 42) // 42
 */
export function axSmmla(a, b, acc) {
  return (axSmmul(a, b) + (acc | 0)) | 0;
}

/**
 * Pure function. `__SSAT(x,n)` — signed saturate to n bits, i.e. clamp to
 * [−2^(n−1), 2^(n−1)−1]. `__SSAT(x,28)` is "clamp a frac32 to ±1.0" and is by far
 * the commonest instance (71 of 92 uses in the factory library).
 *
 * @param {number} x - int32
 * @param {number} n - bit width, 1…32
 * @returns {number} int32 clamped
 *
 * @example axSsat(1 << 29, 28) // 134217727  — 2^27 − 1, the frac32 ceiling
 * @example axSsat(-(1 << 29), 28) // -134217728
 * @example axSsat(1000, 28) // 1000  — inside the range, untouched
 */
export function axSsat(x, n) {
  const hi = 2 ** (n - 1) - 1;
  const lo = -(2 ** (n - 1));
  return Math.max(lo, Math.min(hi, x | 0));
}

/**
 * Pure function. `__USAT(x,n)` — unsigned saturate to n bits: clamp to [0, 2^n−1].
 * `__USAT(x,27)` is "clamp a frac32 to [0,1)".
 *
 * @param {number} x - int32
 * @param {number} n - bit width
 * @returns {number} int32 clamped
 *
 * @example axUsat(-5, 27) // 0
 * @example axUsat(1 << 28, 27) // 134217727
 * @example axUsat(1 << 20, 27) // 1048576
 */
export function axUsat(x, n) {
  return Math.max(0, Math.min(2 ** n - 1, x | 0));
}

// ─── The parameter functions (firmware/parameter_functions.h:21-76) ──────────
// `param_X` as the object's C code sees it. These take the DIAL READING (−64…64,
// what the XML stores) and return the int32 the object body reads.

/**
 * Pure function. `pfun_unsigned_clamp` — the default for the whole `frac32.u.map`
 * family. `__USAT(dial·2^21, 27)`, i.e. a dial 0…64 becomes frac32 [0, 1).
 *
 * @param {number} dial - dial reading, nominally 0…64
 * @returns {number} int32 param value
 *
 * @example axParamUnsigned(64) // 134217727  — clamped one LSB below 1.0
 * @example axParamUnsigned(32) // 67108864   — exactly 0.5
 * @example axParamUnsigned(-3) // 0          — clamped, not wrapped
 */
export function axParamUnsigned(dial) {
  return axUsat(Math.trunc(dial * XML_TO_RAW), 27);
}

/**
 * Pure function. `pfun_signed_clamp` — `frac32.s.map` and its `.pitch` / `.ratio`
 * relatives. `__SSAT(dial·2^21, 28)`: a dial −64…64 becomes frac32 [−1, 1).
 *
 * @param {number} dial - dial reading, nominally −64…64
 * @returns {number} int32 param value
 *
 * @example axParamSigned(-64) // -134217728
 * @example axParamSigned(0) // 0
 * @example axParamSigned(16) // 33554432  — 0.25
 */
export function axParamSigned(dial) {
  return axSsat(Math.trunc(dial * XML_TO_RAW), 28);
}

/**
 * Pure function. `pfun_unsigned_clamp_fullrange` — `frac32.u.map.gain`.
 * `__USAT(v,27) << 4`: the SAME dial, RESCALED to q31, which is why `*c`'s body can
 * write `___SMMUL(param_amp, in) << 1` and mean a plain 0…1 attenuation.
 *
 * @param {number} dial - dial reading, 0…64
 * @returns {number} int32 param value, q31
 *
 * @example axParamGain(64) // 2147483632  — ≈ q31 1.0 (16 LSBs short, by construction)
 * @example axParamGain(32) // 1073741824  — q31 0.5
 * @example axParamGain(0) // 0
 */
export function axParamGain(dial) {
  return axParamUnsigned(dial) << 4;
}

/**
 * Pure function. `pfun_signed_clamp_fullrange` — `frac32.u.map.gain16`.
 * `__SSAT(v,28) << 4`. The `<<4` is a rescale to q31 of a value that may be a whole
 * frac32 1.0, which is how `math/gain` reaches ×16 rather than ×1.
 *
 * @param {number} dial - dial reading, −64…64
 * @returns {number} int32 param value, q31-scaled
 *
 * @example axParamGain16(64) // 2147483632
 * @example axParamGain16(4) // 134217728  — dial 4 of 64 is ×1 in `math/gain`'s law
 * @example axParamGain16(0) // 0
 */
export function axParamGain16(dial) {
  return axSsat(Math.trunc(dial * XML_TO_RAW), 28) << 4;
}

// ─── Cross-type coercion (manifest § R7-11) ──────────────────────────────────

/**
 * Pure function. `bool32 → frac32`. **+1.0, NOT +1/64** — the coercion that looks
 * like a typo and is not. A logic output patched into an audio path is FULL SCALE.
 *
 * @param {boolean|number} b - anything truthy-in-C (`> 0`)
 * @returns {number} 1 or 0, as a float frac32
 *
 * @example axBoolToFrac(true) // 1
 * @example axBoolToFrac(0.5) // 1   — `> 0` is the C test, not `>= 1`
 * @example axBoolToFrac(-1) // 0
 */
export function axBoolToFrac(b) {
  return b > 0 ? 1 : 0;
}

/**
 * Pure function. `frac32 → int32`, which is `>>21` on the raw value — so frac32 1.0
 * arrives as **64**, not as 1. Every step index in this file that comes off a
 * fractional wire has passed through here.
 *
 * @param {number} frac - a float frac32 value (1.0 = full scale)
 * @returns {number} integer
 *
 * @example axFracToInt(1) // 64
 * @example axFracToInt(0.25) // 16
 * @example axFracToInt(-1) // -64
 */
export function axFracToInt(frac) {
  return Math.floor(frac * AX_DIAL_FULL_SCALE);
}

/** Clamp to frac32's nominal ±1.0 — the float form of `__SSAT(x,28)`. */
const sat1 = (x) => Math.max(-1, Math.min(1, x));

// ─── math/op — the arithmetic family ─────────────────────────────────────────

/**
 * Pure function. One entry of the `muls N` family — `objects/math/muls 2/4/8/16.axo`,
 * whose four bodies are the SAME LINE at four widths:
 *
 *     __SSAT(inlet_in, 28 − log2(N)) << log2(N)
 *
 * **THE SATURATE IS BEFORE THE SHIFT AND THAT IS THE WHOLE CHARACTER OF THE OBJECT.**
 * It clamps the INPUT to ±1/N and then multiplies, so the output pins at ±1.0 and the
 * knee sits at ±1/N. Clamp after the multiply instead and the ceiling is the same but
 * everything between 1/N and 1.0 is different — which is the part you hear.
 *
 * Generated rather than written four times because the four differ in exactly one
 * number, and because it lets the test derive its error bound from that number: their
 * `__SSAT` tops out ONE input LSB short of the clamp, and the shift multiplies that
 * shortfall by N, so `satMultiply16` is legitimately 16 frac32 LSB away from ours.
 *
 * @param {number} factor - the multiplier N, a power of two from 2 to 16
 * @returns {object} an AX_MATH_OPS entry
 *
 * @example saturatingMultiply(2).float(0.75) // 1    — the input clamped at 0.5, doubled
 * @example saturatingMultiply(2).float(0.25) // 0.5  — below the knee, a plain double
 * @example saturatingMultiply(4).ceilingSlackLsb // 4
 */
function saturatingMultiply(factor) {
  const knee = 1 / factor;
  const bits = 28 - Math.log2(factor);
  return {
    float: (a) => factor * Math.max(-knee, Math.min(knee, a)),
    int: (a) => axSsat(a, bits) << Math.log2(factor),
    unary: true,
    ceilingSlackLsb: factor,
    help: `a × ${factor}, saturating. The clamp happens BEFORE the multiply, so an input beyond ±${knee} pins the output at ±1.0 rather than being multiplied and then clipped.`,
  };
}

/**
 * THE ARITHMETIC OP TABLE — one entry per Axoloti object `math/op` absorbs.
 *
 * Each entry is `{ float, int, unary, help }`:
 *   `float(a, b)`  the recurrence we run, over float frac32 values
 *   `int(ai, bi)`  the EXACT `<code.krate>`, over raw int32 — the thing we measure
 *                  ourselves against. `bi` is the already-pfunction'd param where
 *                  the source used one (named per entry).
 *   `unary`        true if `b` is ignored, so the spec's help can say which is which
 *
 * The two sides are separate functions rather than one parameterised one because
 * they are DIFFERENT ARITHMETIC — that is the whole subject. A shared body would
 * have to be the float one, and then the reference would be measuring itself.
 */
export const AX_MATH_OPS = Object.freeze({
  /** `objects/math/PLUS.axo` <code.krate> — `outlet_out = inlet_in1 + inlet_in2`. */
  add: {
    float: (a, b) => a + b,
    int: (a, b) => (a + b) | 0,
    unary: false,
    help: "a + b. No scaling anywhere: frac32 is a plain fixed-point integer, so addition is addition.",
  },
  /** `objects/math/MINUS.axo` <code.krate> — `inlet_in1 - inlet_in2`. */
  subtract: {
    float: (a, b) => a - b,
    int: (a, b) => (a - b) | 0,
    unary: false,
    help: "a − b.",
  },
  /**
   * `objects/math/STAR.axo` <code.krate> — `___SMMUL(inlet_a<<3, inlet_b<<2)`.
   * The shifts ARE the scaling law: `(a·2^3)·(b·2^2) / 2^32 = a·b / 2^27`, which is
   * exactly frac32 × frac32 → frac32.
   *
   * **THE PRE-SHIFTS OVERFLOW BEFORE frac32's HEADROOM RUNS OUT, AND WE DO NOT COPY
   * THAT.** `a << 3` is an int32 shift, so it wraps once |a| reaches 2^28 — i.e. once
   * the SIGNAL reaches 2.0, even though frac32 nominally carries ±16.0. `b << 2`
   * wraps at 4.0. Past those points their object does not saturate, it INVERTS: an
   * input of +2.0 comes back as −2.0 and the product changes sign. That is
   * int32 wraparound rather than a designed behaviour, and reproducing it would mean
   * porting a crash rather than a sound. Bounds pinned in tests/port_ax1_test.js.
   */
  multiply: {
    float: (a, b) => a * b,
    int: (a, b) => axSmmul(a << 3, b << 2),
    unary: false,
    /** Their `a<<3` wraps int32 at this input magnitude; ours does not. */
    intValidAbsA: 2,
    /** Their `b<<2` wraps here. */
    intValidAbsB: 4,
    help: "a × b at frac32 scale — 1.0 × 1.0 is 1.0. Ring modulation when both are audio. Their integer form WRAPS (not saturates) above ±2.0 on a and ±4.0 on b; ours keeps multiplying, which is a deliberate divergence from an overflow.",
  },
  /**
   * `objects/tiar/math/DP STAR.axo` <code.srate> (Smashed Transistors) — an
   * ANTIALIASED ring modulator. Instead of multiplying the two samples it integrates
   * the product over the sample interval assuming both inputs are linear across it,
   * which is the "differentiated parabolic" trick: the product of two ramps is a
   * parabola, and its mean over the interval is the two-point Simpson form below.
   * That is why it takes one extra sample of delay and why a hard ring mod stops
   * spraying aliases.
   *
   * The source is ALREADY float in the original (it converts in and out of q27), so
   * this is the one op with no fixed-point step to reproduce.
   */
  ringModAntialiased: {
    float: (a, b, s) => (a * (2 * b + s.y1) + s.x1 * (b + 2 * s.y1)) / 6,
    int: null,
    unary: false,
    stateful: true,
    help: "Antialiased ring modulator (Smashed Transistors' `DP *`): the product AVERAGED over the sample interval rather than sampled at its start, which is what stops a hard ring mod folding aliases down. Costs one sample of delay.",
  },
  /** `objects/math/PLUS1.axo` <code.krate> — `inlet_a + (1<<21)`, i.e. ONE DIAL UNIT
   *  = 1/64 of full scale, not 1.0. The object's name is a trap. */
  addDialUnit: {
    float: (a) => a + 1 / AX_DIAL_FULL_SCALE,
    int: (a) => (a + (1 << 21)) | 0,
    unary: true,
    help: "a + 1 DIAL UNIT (1/64 of full scale), which is what Axoloti's `+1` adds — not +1.0. The name is theirs; the quantity is 0.015625.",
  },
  /** `objects/math/abs.axo` <code.krate> — `inlet_in>0 ? inlet_in : -inlet_in`. */
  absolute: {
    float: (a) => (a > 0 ? a : -a),
    int: (a) => (a > 0 ? a : -a) | 0,
    unary: true,
    help: "|a|. Full-wave rectification when a is audio, which doubles the perceived pitch.",
  },
  /** `objects/math/inv.axo` <code.krate> — `-inlet_in`. NEGATE, not reciprocal. */
  negate: {
    float: (a) => -a,
    int: (a) => -a | 0,
    unary: true,
    help: "−a. Axoloti calls this `inv`; it is a sign flip, NOT a reciprocal.",
  },
  /** `objects/math/max.axo` <code.krate> — `(in1>in2) ? in1 : in2`. */
  maximum: {
    float: (a, b) => (a > b ? a : b),
    int: (a, b) => (a > b ? a : b) | 0,
    unary: false,
    help: "max(a, b). With b at 0 this is a half-wave rectifier.",
  },
  /** `objects/math/GT.axo` <code.krate> — `inlet_in1 > inlet_in2`, a bool32 outlet.
   *  bool32 → frac32 is +1.0, so this emits FULL SCALE, not 1/64. */
  greaterThan: {
    float: (a, b) => axBoolToFrac(a > b),
    int: (a, b) => (a > b ? 1 : 0),
    unary: false,
    help: "1.0 when a > b, else 0. A comparator — its true is FULL SCALE, because bool32 coerces to frac32 as +1.0.",
  },
  /** `objects/math/div 2.axo` <code.krate> — `inlet_in >> 1`. An ARITHMETIC shift, so
   *  it floors rather than truncating toward zero: negative inputs land one LSB
   *  (2^−27) below the exact quotient. Measured in tests/port_ax1_test.js. */
  divide2: {
    float: (a) => a / 2,
    int: (a) => a >> 1,
    unary: true,
    help: "a ÷ 2.",
  },
  /** `objects/math/div 4.axo` <code.krate> — `inlet_in >> 2`. */
  divide4: {
    float: (a) => a / 4,
    int: (a) => a >> 2,
    unary: true,
    help: "a ÷ 4.",
  },
  /** `objects/math/div 32.axo` <code.krate> — `inlet_in >> 5`. */
  divide32: {
    float: (a) => a / 32,
    int: (a) => a >> 5,
    unary: true,
    help: "a ÷ 32.",
  },
  /** `objects/math/muls 2.axo` — `__SSAT(inlet_in,27) << 1`. See `saturatingMultiply`. */
  satMultiply2: saturatingMultiply(2),
  /** `objects/math/muls 4.axo` — `__SSAT(inlet_in,26) << 2`. */
  satMultiply4: saturatingMultiply(4),
  /** `objects/math/muls 8.axo` — `__SSAT(inlet_in,25) << 3`. */
  satMultiply8: saturatingMultiply(8),
  /** `objects/math/muls 16.axo` — `__SSAT(inlet_in,24) << 4`. */
  satMultiply16: saturatingMultiply(16),
  /** `objects/math/sat.axo` <code.krate> — `__SSAT(inlet_in,28)`, the plain clamp to
   *  frac32's nominal ±1.0. This is what SPENDS the ±16.0 of headroom a mixer used. */
  saturate: {
    float: (a) => sat1(a),
    int: (a) => axSsat(a, 28),
    unary: true,
    help: "Hard clamp to ±1.0. frac32 carries ±16.0 of headroom above full scale so a mixer can sum before clipping; this is where that headroom is spent.",
  },
  /**
   * `objects/math/STARc.axo` <code.krate> — `___SMMUL(param_amp, inlet_in) << 1`,
   * where `param_amp` is `frac32.u.map.gain` = `__USAT(v,27) << 4`. The `<<4` in the
   * pfunction and the `<<1` in the body are one law: a q31 coefficient times a frac32
   * gives a frac32 at `<<1`. **Here `b` IS the amp**, read 0…1.
   */
  attenuate: {
    float: (a, b) => a * b,
    int: (a, ampDial) => axSmmul(axParamGain(ampDial), a) << 1,
    unary: false,
    paramIsDial: true,
    // THREE LSB, and the number is derived rather than tuned: `pfun_unsigned_clamp`
    // tops out at 2^27 − 1, so after its `<<4` the coefficient is 16 raw units short
    // of q31 1.0 — a relative shortfall of 16/2^31 which, over the test's ±2.0 input
    // sweep, is 2 frac32 LSB. `___SMMUL` truncates, adding the third.
    ceilingSlackLsb: 3,
    help: "a × b as a 0…1 ATTENUATION (Axoloti's `*c`). Identical arithmetic to multiply; it exists as its own op because its source reads b through the `.gain` pfunction, which is the layer a port gets wrong.",
  },
  /**
   * `objects/math/gain.axo` <code.krate> —
   * `__SSAT(___SMMUL(param_amp, __SSAT(inlet_in,28)<<4) << 1, 28)`, with `param_amp`
   * = `frac32.u.map.gain16`. TWO saturations: the input is clamped to ±1.0 first,
   * then the product is clamped again. **b reaches ×16** because gain16's `<<4`
   * pushes a full-scale dial past q31 1.0.
   */
  gain16: {
    float: (a, b) => sat1(sat1(a) * b),
    int: (a, ampDial) => axSsat(axSmmul(axParamGain16(ampDial), axSsat(a, 28) << 4) << 1, 28),
    unary: false,
    paramIsDial: true,
    help: "a × b with b up to ×16, saturating (Axoloti's `math/gain`). The input is clamped to ±1.0 BEFORE the multiply and the product is clamped again after — two clips, not one.",
  },
});

/** Every `math/op` operation name, in the order the Inspector lists them. */
export const AX_MATH_OP_NAMES = Object.freeze(Object.keys(AX_MATH_OPS));

// ─── math/smooth — the one-pole every Axoloti patch uses ─────────────────────

/**
 * Pure function. The per-k-rate-tick smoothing COEFFICIENT of `math/smooth` and
 * `math/glide`, from their shared `<code.krate>`:
 *
 *     val = ___SMMLA(val - inlet_in, (-1<<26) + (param_time>>1), val)
 *
 * `param_time` is `frac32.u.map`, so `param_time = dial·2^21` and
 * `(-2^26 + dial·2^20) / 2^32 = -(64 − dial)/4096`. The minus and the `val - in`
 * argument order cancel, leaving the ordinary one-pole `val += (in − val)·c`.
 *
 * **THE DIAL IS BACKWARDS FROM ITS NAME.** It is called `time`, but a HIGHER dial
 * means a SMALLER coefficient and therefore a LONGER glide; at dial 64 the
 * coefficient is exactly 0 and the value FREEZES. That is their behaviour and we
 * keep it; the spec's help says so rather than the knob being quietly re-mapped.
 *
 * @param {number} dial - the `time` dial, 0…64
 * @returns {number} per-tick coefficient, 1/64 down to 0
 *
 * @example axSmoothCoefficient(0) // 0.015625   — 1/64, the fastest: τ ≈ 21 ms
 * @example axSmoothCoefficient(32) // 0.0078125 — τ ≈ 43 ms
 * @example axSmoothCoefficient(64) // 0         — frozen; the value never moves again
 */
export function axSmoothCoefficient(dial) {
  return (AX_DIAL_FULL_SCALE - dial) / 4096;
}

/**
 * Pure function. The time constant a `math/smooth` dial reading really buys, in
 * seconds — the number the Inspector's help quotes so the backwards knob is legible.
 * `τ = 1 / (c · 3000)`, because the coefficient is spent once per k-rate tick.
 *
 * @param {number} dial - the `time` dial, 0…64
 * @returns {number} seconds; Infinity at dial 64
 *
 * @example axSmoothTimeConstant(0).toFixed(4) // '0.0213'
 * @example axSmoothTimeConstant(32).toFixed(4) // '0.0427'
 * @example axSmoothTimeConstant(64) // Infinity
 */
export function axSmoothTimeConstant(dial) {
  return 1 / (axSmoothCoefficient(dial) * AX_CONTROL_RATE);
}

/**
 * Pure function. The EXACT integer tick of `objects/math/smooth.axo` <code.krate>,
 * for the reference sweep. `val` and `input` are raw int32 frac32.
 *
 * @param {number} val - int32 state
 * @param {number} input - int32 frac32 input
 * @param {number} timeDial - the `time` dial, 0…64
 * @returns {number} the new int32 state
 *
 * @example axIntSmoothTick(0, 1 << 27, 0) // 2097152  — one 1/64 step toward full scale
 * @example axIntSmoothTick(0, 0, 32) // 0
 */
export function axIntSmoothTick(val, input, timeDial) {
  const coef = (-(1 << 26) + (axParamUnsigned(timeDial) >> 1)) | 0;
  return axSmmla((val - input) | 0, coef, val);
}

// ─── math/window — the Hann window ───────────────────────────────────────────

/**
 * Pure function. `objects/math/window.axo` <code.krate>:
 * `HANNING2TINTERP(inlet_phase<<5, r); outlet_win = r>>4;`
 *
 * `hann_q31` (firmware/axoloti_math.h:132) reads `windowt`, built in
 * axoloti_math.c:49-52 as `32767·(0.5 − 0.5·cos(2πi/1024))` over 1024+1 entries with
 * q31 linear interpolation between them. The `<<5` promotes a frac32 0…1 phase to a
 * full uint32 phase; the `>>4` narrows the q31 result back to frac32.
 *
 * **DELIBERATE DEVIATION, NAMED:** we evaluate the cosine EXACTLY instead of
 * interpolating a 1024-point table. The table's own error against the cosine it was
 * built from is bounded by the second-order interpolation term, ≈ (π/1024)²/2 ≈
 * 4.7e-6 of full scale — inaudible, and it is THEIR quantisation rather than a
 * property of the sound. tests/port_ax1_test.js measures the real difference against
 * the reconstructed table rather than quoting this bound.
 *
 * @param {number} phase - frac32 phase, 0…1 (values outside wrap, as their uint32 does)
 * @returns {number} the window value, 0…1
 *
 * @example axHannWindow(0) // 0
 * @example axHannWindow(0.5) // 1
 * @example axHannWindow(0.25) // 0.49999999999999994 — cos(π/2) is not exactly 0 in binary64
 */
export function axHannWindow(phase) {
  return 0.5 - 0.5 * Math.cos(2 * Math.PI * (phase - Math.floor(phase)));
}

/** The Hann table's length (firmware/axoloti_math.h:39 `#define WINDOWSIZE 1024`). */
export const AX_WINDOW_SIZE = 1024;

/**
 * Query (reads nothing external, but allocates and is memoised by the caller).
 * Rebuild Axoloti's `windowt` exactly as axoloti_math.c:49-52 writes it, so the
 * reference sweep measures our exact cosine against THEIR table, not against a
 * second copy of our own formula.
 *
 * @returns {Int16Array} WINDOWSIZE+1 entries of `(int16_t)(32767·(0.5 − 0.5·cos(2πi/1024)))`
 *
 * @example axWindowTable()[0] // 0
 * @example axWindowTable()[512] // 32767  — the peak, at half a turn
 */
export function axWindowTable() {
  const table = new Int16Array(AX_WINDOW_SIZE + 1);
  for (let i = 0; i <= AX_WINDOW_SIZE; i++) {
    const f = (i * 2 * Math.PI) / AX_WINDOW_SIZE;
    table[i] = Math.trunc(32767 * (0.5 - 0.5 * Math.cos(f)));
  }
  return table;
}

// ─── math/divrem — integer divide with remainder ─────────────────────────────

/**
 * Pure function. `objects/math/divremc.axo` <code.krate>, transcribed verbatim:
 *
 *     if (inlet_a >= 0) r = ((unsigned int)inlet_a)/attr_denominator;
 *     else              r = -(((unsigned int)(attr_denominator-inlet_a))/attr_denominator);
 *     outlet_div = r;  outlet_rem = inlet_a - (r*attr_denominator);
 *
 * **THIS CONTAINS A REAL OFF-BY-ONE AND WE PORT IT** (manifest § R7-11: port the
 * behaviour, make the label honest). For a NEGATIVE `a` that the denominator divides
 * EXACTLY, their formula returns one too far — `divrem(−4, 2)` is `{div: −3, rem: 2}`
 * where floor division gives `{div: −2, rem: 0}`, and the remainder equals the
 * denominator rather than being below it. Every other case agrees with floor
 * division. It is stated in the spec's `help` so the readout cannot lie about it.
 *
 * @param {number} a - integer numerator
 * @param {number} denominator - integer, 1…128 (their spinner's range)
 * @returns {{div: number, rem: number}}
 *
 * @example axDivRem(7, 2) // {div: 3, rem: 1}
 * @example axDivRem(-5, 2) // {div: -3, rem: 1}  — agrees with floor division
 * @example axDivRem(-4, 2) // {div: -3, rem: 2}  — THEIR off-by-one at exact negative multiples
 */
export function axDivRem(a, denominator) {
  const r = a >= 0
    ? Math.trunc(a / denominator)
    : -Math.trunc((denominator - a) / denominator);
  return { div: r, rem: a - r * denominator };
}

// ─── math/shaper-k — the tiar 4-segment control shaper ───────────────────────

/**
 * Pure function. `objects/tiar/kfunc/u4u.axo` <code.krate> (Smashed Transistors) —
 * a unipolar control shaper defined by FIVE breakpoints over FOUR equal segments.
 * Their body indexes with `i = inlet_in >> 25` (0…3) and interpolates with the
 * remaining q25 fraction through `___SMMLA(p[i+1]-p[i], a, p[i]>>7) << 7`.
 *
 * The `>>7 … <<7` round trip is a fixed-point necessity — it makes room for the
 * accumulator — and it QUANTISES the segment's base to 2^7/2^27 ≈ 9.5e-7. We do not
 * reproduce that quantisation; it is arithmetic overhead, not shape.
 *
 * @param {number} input - frac32, clamped to 0…1 by their own guards
 * @param {number[]} points - the five breakpoints p0…p4, each 0…1
 * @returns {number} the shaped value
 *
 * @example axShaper4(0, [0, 0.25, 0.5, 0.75, 1]) // 0
 * @example axShaper4(1, [0, 0.25, 0.5, 0.75, 1]) // 1
 * @example axShaper4(0.125, [0, 1, 1, 1, 1]) // 0.5  — halfway up the first segment
 */
export function axShaper4(input, points) {
  if (input >= 1) return points[4];
  if (input <= 0) return points[0];
  const scaled = input * 4;
  const segment = Math.floor(scaled);
  const fraction = scaled - segment;
  return points[segment] + (points[segment + 1] - points[segment]) * fraction;
}

// ─── conv/convert — range mapping and the k→s ramp ───────────────────────────

/**
 * Pure function. `objects/conv/bipolar2unipolar.axo` <code.krate> —
 * `(inlet_i>>1) + (1<<26)`, i.e. halve and centre on 0.5. −1…1 becomes 0…1.
 *
 * @param {number} value - frac32, nominally −1…1
 * @returns {number} frac32, nominally 0…1
 *
 * @example axBipolarToUnipolar(-1) // 0
 * @example axBipolarToUnipolar(0) // 0.5
 * @example axBipolarToUnipolar(1) // 1
 */
export function axBipolarToUnipolar(value) {
  return value / 2 + 0.5;
}

/**
 * Pure function. `objects/conv/unipolar2bipolar.axo` <code.krate> —
 * `(inlet_i - (1<<26)) << 1`. The exact inverse of the above.
 *
 * @param {number} value - frac32, nominally 0…1
 * @returns {number} frac32, nominally −1…1
 *
 * @example axUnipolarToBipolar(0) // -1
 * @example axUnipolarToBipolar(0.5) // 0
 * @example axUnipolarToBipolar(1) // 1
 */
export function axUnipolarToBipolar(value) {
  return (value - 0.5) * 2;
}

/**
 * Pure function. `objects/conv/interp.axo` — the ONE k→s interpolation idiom in the
 * whole library (`gain/vca` carries the other copy). Its <code.krate> computes
 * `_step = (inlet_i - _prev)>>4` and starts the ramp at `_prev`; its <code.srate>
 * emits `_i` then advances.
 *
 * **THEIR RAMP IS ONE BUFFER (333 µs) LATE, AND THAT IS THE POINT** — it ramps FROM
 * the previous block's value TO this one, so the output reaches a new k-rate value
 * only at the end of the block it arrived in. Measured trace for `prev=0, v=1.0`:
 * samples 0…15 are 0.0000, 0.0625, …, 0.9375. Omit the ramp and every modulated gain
 * in a ported patch sounds crunchy; "fix" the lateness and it stops matching.
 *
 * @param {number} previous - the k-rate value from the PREVIOUS tick
 * @param {number} current - the k-rate value that just arrived
 * @returns {{start: number, step: number}} the ramp this 16-sample block runs
 *
 * @example axInterpRamp(0, 1) // {start: 0, step: 0.0625}
 * @example axInterpRamp(0.5, 0.5) // {start: 0.5, step: 0}
 * @example axInterpRamp(1, 0) // {start: 1, step: -0.0625}
 */
export function axInterpRamp(previous, current) {
  return { start: previous, step: (current - previous) / AX_KRATE_BLOCK };
}

// ─── logic/* — the boolean family ────────────────────────────────────────────

/**
 * THE LOGIC OP TABLE — `logic/op`'s modes, one per source object.
 *
 * Every entry takes and returns bool-as-frac32 (0 or 1.0, per `axBoolToFrac`), and
 * the STATEFUL ones take a mutable `s` because their whole content is edge detection.
 * Their state field names match the source's own locals so a wrong pulse can be
 * diffed against the original line.
 */
export const AX_LOGIC_OPS = Object.freeze({
  /** `objects/logic/and 2.axo` <code.krate> — `outlet_o = (inlet_i1)&&(inlet_i2)`.
   *  NOTE their test is C truthiness on the raw int32, i.e. NON-ZERO, not `> 0`;
   *  a negative frac32 is TRUE here while it is false to `logic/inv`. Ported as-is. */
  and: { stateful: false, run: (a, b) => (a !== 0 && b !== 0 ? 1 : 0), binary: true, help: "1.0 only when both inputs are NON-ZERO. Their test is C truthiness on the raw word, so a NEGATIVE input counts as true here — unlike Invert, whose test is `> 0`. That inconsistency is Axoloti's and is kept." },
  /** `objects/logic/inv.axo` <code.krate> — `outlet_o = (inlet_i>0)?0:1`. */
  invert: { stateful: false, run: (a) => (a > 0 ? 0 : 1), binary: false, help: "1.0 when the input is NOT greater than zero. A logical NOT with a `> 0` threshold." },
  /**
   * `objects/logic/change.axo` <code.krate> — one tick of 1.0 whenever the input
   * DIFFERS from the last value it latched:
   *
   *     if ((pval != inlet_in) & (!ptrig)) { trig=1; pval=inlet_in; ptrig=1; }
   *     else { ptrig=0; trig=0; }
   *
   * **THE `ptrig` INTERLOCK COSTS TWO THIRDS OF THE TRIGGERS ON A FAST INPUT, AND
   * THAT IS MEASURED, NOT REASONED.** After firing, `ptrig` must fall on a tick that
   * does NOT fire, and the value it latched blocks the tick after that — so an input
   * alternating 0,1,0,1,… produces `0,1,0,0,1,0,0,1,…`: one pulse every THREE ticks,
   * not every two. (An earlier version of this docblock said "every other tick",
   * reasoned from the interlock alone; the trace in tests/port_ax1_test.js is what
   * corrected it. The lesson is the project's own: an inference is not a finding
   * until it is measured on its own terms.) Ported deliberately.
   */
  change: {
    stateful: true,
    binary: false,
    run: (a, s) => {
      if (s.pval !== a && !s.ptrig) { s.pval = a; s.ptrig = true; return 1; }
      s.ptrig = false;
      return 0;
    },
    help: "One tick of 1.0 whenever the input differs from the value last latched. QUIRK, ported and MEASURED: an input that changes every single k-rate tick fires only every THIRD tick, because their interlock flag has to fall on a non-firing tick and the newly latched value blocks the tick after that.",
  },
  /** `objects/tiar/logic/rising.axo` <code.krate> — `outlet_trig = inlet_in && !_in;`
   *  then `_in = inlet_in`. A clean one-tick pulse on a rising edge, with no
   *  hysteresis at all — which is what distinguishes it from our Trigger node. */
  rising: {
    stateful: true,
    binary: false,
    run: (a, s) => {
      const now = a > 0;
      const fired = now && !s.previous;
      s.previous = now;
      return fired ? 1 : 0;
    },
    help: "One tick of 1.0 on a rising edge. NO Schmitt hysteresis — unlike PowerRP's own Trigger node, a signal wobbling around zero fires repeatedly here. That is the source's behaviour and is what a ported patch is tuned against.",
  },
});

/** Every `logic/op` mode name, in Inspector order. */
export const AX_LOGIC_OP_NAMES = Object.freeze(Object.keys(AX_LOGIC_OPS));

/**
 * Pure function (mutates `s`, which is the point — near-pure otherwise).
 * `objects/logic/counter.axo` <code.krate>, one k-rate tick. A cyclic up-counter with
 * an independent reset, both edge-triggered through their own `ntrig`/`rtrig` flags.
 *
 * @param {number} trig - the count input, edge-detected on `> 0`
 * @param {number} reset - the reset input, edge-detected on `> 0`
 * @param {number} maximum - wrap point; the count runs 0…maximum−1
 * @param {{count: number, ntrig: boolean, rtrig: boolean}} s - mutable state
 * @returns {{count: number, carry: number}} the count, and 1.0 on the tick it wrapped
 *
 * @example // three edges into a modulo-2 counter: 1, then 0 with a carry, then 1
 * @example // axCounterTick(1, 0, 2, s) // {count: 1, carry: 0}
 * @example // axCounterTick(1, 0, 2, {count: 1, ntrig: false, rtrig: false}) // {count: 0, carry: 1}
 */
export function axCounterTick(trig, reset, maximum, s) {
  let carry = 0;
  if (trig > 0 && !s.ntrig) {
    s.count += 1;
    if (s.count >= maximum) { s.count = 0; carry = 1; }
    s.ntrig = true;
  } else if (!(trig > 0)) {
    s.ntrig = false;
  }
  if (reset > 0 && !s.rtrig) { s.count = 0; s.rtrig = true; }
  else if (!(reset > 0)) { s.rtrig = false; }
  return { count: s.count, carry };
}

/**
 * Near-pure function (mutates `s`). `objects/logic/latch.axo` <code.krate> — copy the
 * input to the output on a rising edge of `trig`, hold otherwise.
 *
 * **HOW THIS DIFFERS FROM PowerRP's OWN Sample & Hold, which it otherwise duplicates:**
 * ours (synth/worklets/processors.js SampleHoldProcessor) arms on a SCHMITT pair
 * (0.1 / 0.5) so a noisy trigger cannot re-fire; this one arms on a bare `> 0`. A
 * patch authored against Axoloti's latch and run through a Schmitt one samples at
 * different moments on a slow or noisy gate, so this is a real second node rather
 * than a rename.
 *
 * @param {number} input - the value to capture
 * @param {number} trig - the gate, edge-detected on `> 0`
 * @param {{latch: number, ntrig: boolean}} s - mutable state
 * @returns {number} the held value
 *
 * @example // axLatchTick(0.7, 1, {latch: 0, ntrig: false}) // 0.7
 * @example // axLatchTick(0.2, 1, {latch: 0.7, ntrig: true}) // 0.7 — still high, no new edge
 */
export function axLatchTick(input, trig, s) {
  if (trig > 0 && !s.ntrig) { s.latch = input; s.ntrig = true; }
  if (!(trig > 0)) s.ntrig = false;
  return s.latch;
}

/** How many one-hot outputs `logic/decode` has — `objects/logic/decode/int 8.axo`
 *  declares o0…o7 plus a `chain`, and the chain's `-8` is this same number. */
export const AX_DECODE_WIDTH = 8;

/**
 * Pure function. `objects/logic/decode/int 8.axo` <code.krate> — one-hot decode of an
 * integer, plus the CHAIN outlet (`inlet_i1 - 8`) that lets decoders be cascaded to
 * cover 16, 24, … values without any of them knowing how many there are.
 *
 * @param {number} value - the integer to decode
 * @returns {{bits: number[], chain: number}} eight 0/1.0 flags, and value−8
 *
 * @example axDecode8(0).bits[0] // 1
 * @example axDecode8(3).bits[3] // 1
 * @example axDecode8(9).chain // 1  — feed this to the next decoder in the chain
 */
export function axDecode8(value) {
  const bits = [];
  for (let i = 0; i < AX_DECODE_WIDTH; i++) bits.push(value === i ? 1 : 0);
  return { bits, chain: value - AX_DECODE_WIDTH };
}

// ─── sel/* — the step tables ─────────────────────────────────────────────────

/** How many steps a `sel b 16` / `sel fb 16` / `sel fp 16` table holds, and the
 *  amount its `chain` outlet subtracts. */
export const AX_STEP_COUNT = 16;
/** How many parallel TRACKS `sel b 16 4t` and `sel 4l 16 8t s` reach. */
export const AX_STEP_TRACKS = 8;
/** The levels one `int2x16` step can take — 2 bits, so 0…3. */
export const AX_STEP_LEVELS = 4;

/**
 * Pure function. `objects/sel/sel b 16.axo` and its `pulse` sibling
 * (`sel b 16 pulse.axo`), which differ by exactly one clause:
 *
 *     outlet_o = param_b16 & (1<<inlet_in);                       // level
 *     outlet_o = (in_prev != inlet_in) && (param_b16 & (1<<in));  // pulse
 *
 * So `pulse` is not "a shorter gate" — it is a gate that only fires on the tick the
 * STEP INDEX CHANGED, which is why a sequencer holding an index emits one pulse per
 * step rather than a continuous high.
 *
 * @param {number} index - the step index; outside 0…15 the `def` input passes through
 * @param {number} mask - a 16-bit pattern, bit k = step k
 * @param {boolean} pulse - true for the pulse variant
 * @param {number} previousIndex - the index at the previous tick (pulse mode only)
 * @param {number} fallback - the `def` inlet, used when the index is out of range
 * @returns {number} 0 or 1.0
 *
 * @example axStepBool(0, 0b0000000000000101, false, -1, 0) // 1
 * @example axStepBool(1, 0b0000000000000101, false, -1, 0) // 0
 * @example axStepBool(2, 0b0000000000000101, true, 2, 0) // 0  — set, but the index did not change
 */
export function axStepBool(index, mask, pulse, previousIndex, fallback) {
  if (index < 0 || index >= AX_STEP_COUNT) return fallback;
  const set = (mask & (1 << index)) !== 0;
  if (!pulse) return set ? 1 : 0;
  return set && previousIndex !== index ? 1 : 0;
}

/**
 * Pure function. `objects/sel/sel fb 16.axo` / `sel fp 16.axo` <code.krate> — a
 * 16-way `switch` over the step index selecting one of sixteen stored values, with
 * the `def` inlet as the `default:` branch. `sel i 32` and `sel dial 4` are the same
 * switch at different widths; this is the one node that covers the family.
 *
 * @param {number} index - the step index
 * @param {number[]} values - the stored values, one per step
 * @param {number} fallback - the `def` inlet, returned when the index is out of range
 * @returns {number}
 *
 * @example axStepValue(2, [0.1, 0.2, 0.3], 0) // 0.3
 * @example axStepValue(9, [0.1, 0.2, 0.3], -1) // -1  — past the end, `def` wins
 */
export function axStepValue(index, values, fallback) {
  if (index < 0 || index >= values.length) return fallback;
  return values[index];
}

/**
 * Pure function. `objects/sel/sel 4l 16 8t s.axo` <code.krate> — sixteen steps at
 * FOUR LEVELS each (`int2x16`: 2 bits per step in one 32-bit word), across eight
 * selectable ROWS. `(param_t[row] >> (inlet_in*2)) & 3` is their whole body.
 *
 * Both `chain` outlets exist for the same cascading reason as `sel b 16`'s: `in−16`
 * extends the pattern past sixteen steps, `row−8` past eight rows.
 *
 * @param {number} index - the step index, 0…15
 * @param {number} row - which track word to read, 0…7
 * @param {number[]} words - eight `int2x16` words
 * @param {number} fallback - the `def` inlet
 * @returns {{level: number, chain: number, chainRow: number}} level is 0…3
 *
 * @example axStep4Level(0, 0, [0b11, 0, 0, 0, 0, 0, 0, 0], 0).level // 3
 * @example axStep4Level(1, 0, [0b1100, 0, 0, 0, 0, 0, 0, 0], 0).level // 3
 * @example axStep4Level(0, 9, [1, 0, 0, 0, 0, 0, 0, 0], -1).level // -1  — no such row
 */
export function axStep4Level(index, row, words, fallback) {
  const chain = index - AX_STEP_COUNT;
  const chainRow = row - AX_STEP_TRACKS;
  if (index < 0 || index >= AX_STEP_COUNT || row < 0 || row >= AX_STEP_TRACKS) {
    return { level: fallback, chain, chainRow };
  }
  return { level: (words[row] >>> (index * 2)) & 3, chain, chainRow };
}

// ─── audio/out — the stereo output with volume ───────────────────────────────

/**
 * Pure function. `objects/sss/audio/StOutVol.axo` <code.krate> (Remco van der Most,
 * after Taelman) — the stereo output every contrib patch ends in:
 *
 *     AudioOutputLeft[j] = __SSAT(___SMMUL(inlet_left[j]<<3, param_volume<<2), 28);
 *
 * `<<3` and `<<2` are the frac32×frac32 law again (`a·b/2^27`), then a HARD clamp to
 * ±1.0. Note it ASSIGNS rather than `+=`: unlike `audio/out left`, two of these in
 * one patch do not sum, the later one wins. Ours sums, like every other PowerRP
 * output (ADDENDUM 10) — the divergence is named in the spec's help because a
 * silently-dropped channel is exactly the failure this port exists to avoid.
 *
 * @param {number} sample - frac32 input sample
 * @param {number} volume - the `volume` dial as a 0…1 gain
 * @returns {number} the clamped output sample
 *
 * @example axStereoOutSample(0.5, 1) // 0.5
 * @example axStereoOutSample(4, 1) // 1     — hard clip, not a limiter
 * @example axStereoOutSample(0.8, 0.5) // 0.4
 */
export function axStereoOutSample(sample, volume) {
  return sat1(sample * volume);
}
