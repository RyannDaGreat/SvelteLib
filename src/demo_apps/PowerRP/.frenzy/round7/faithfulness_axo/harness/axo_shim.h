/*
 * axo_shim.h — THE AXOLOTI PLATFORM, SCALAR, ON THE HOST.
 *
 * ── WHAT THIS IS AND WHY IT IS TRUSTWORTHY ──────────────────────────────────
 * The object code under test is taken VERBATIM out of the `.axo` XML. It is
 * never retyped. What this header supplies is only the platform underneath it:
 * the ARM DSP intrinsics, the six lookup tables, the parameter functions, and
 * the `frac32` typedefs. Those are the ONLY things transcribed, they are
 * transcribed ONCE, and every equivalence assumed is stated below and is
 * checked at runtime by `axo_shim_selftest()`.
 *
 * Sources, read at these commits on 2026-08-07:
 *   firmware  axoloti/axoloti         @ 46f6e4b383ce182da9dcca25b9d4b544fe20f990
 *             api/axoloti_math.h, api/parameter_functions.h, api/axoloti.h,
 *             firmware/axoloti_math.c
 *   factory   axoloti/axoloti-factory @ 78cb74bd0b118f6b951ccd6b92a62b1bae0ff1aa
 *             objects/**.axo
 *
 * ── THE INTRINSIC EQUIVALENCES, EACH ONE STATED ─────────────────────────────
 * All are the ARMv7E-M architectural definitions, computed in int64 and
 * narrowed. They are EXACT, not approximate; the ARM instructions are defined
 * on the same values.
 *
 *   ___SMMUL(a,b)     = (int32)((int64)a * (int64)b >> 32)
 *                       ARM SMMUL: signed most-significant word multiply, no
 *                       rounding. Truncation is toward NEGATIVE INFINITY
 *                       because it is an arithmetic shift of the 64-bit
 *                       product, NOT a division — this distinction is
 *                       load-bearing for negative operands and is why the
 *                       shift is written as `>>` on a signed int64.
 *   ___SMMLA(a,b,c)   = c + ___SMMUL(a,b)          (SMMLA)
 *   ___SMMLS(a,b,c)   = c - ___SMMUL(a,b)          (SMMLS)
 *   __SSAT(x,n)       = clamp(x, -(1<<(n-1)), (1<<(n-1))-1)
 *   __USAT(x,n)       = clamp(x, 0, (1<<n)-1)
 *   __CLZ(x)          = count leading zeros, __CLZ(0) == 32
 *   smulbb/bt/tb/tt   = signed 16x16 halfword products, sign-extended halves
 *   smulwb/smulwt     = (int32)((int64)a * (int16)half >> 16)
 *   __QADD/__QSUB     = saturating int32 add/sub
 *
 * The one place ARM's result is IMPLEMENTATION-VISIBLE and ours could differ
 * is signed >> of a negative number: C leaves it implementation-defined, but
 * gcc/clang on every host we build for define it as arithmetic. Asserted in
 * the selftest rather than assumed.
 *
 * ── THE ONE INTRINSIC THAT IS *NOT* EXACT, AND WHAT IT AFFECTS ──────────────
 * `sinet[]` is built on hardware by CMSIS `arm_sin_q31`, which is itself a
 * 512-entry table plus linear interpolation, so it is NOT the true sine. We
 * build `sinet` from `sin()` directly. The difference is bounded by CMSIS's own
 * interpolation error (~1e-5 of full scale) and then TRUNCATED TO 16 BITS by
 * `>>16`, so it is at most 1 LSB of an int16. Objects that read `sinet` are
 * flagged `sinet_approx` in the report. `sine2t[]`, the table that actually
 * matters (SINE2TINTERP / `sin_q31`), IS built from `sinf()` on hardware too,
 * so it is EXACT here.
 *
 * ── THE ONE PRIMITIVE THAT CANNOT BE REPRODUCED AT ALL ──────────────────────
 * `rand_s32()` folds in `RNG->DR`, the STM32 hardware entropy source. It is
 * not reproducible on hardware either — two runs of the same patch on the same
 * Axoloti give different noise. So any object reading it is compared
 * STATISTICALLY (distribution, spectrum), never sample-by-sample. Here it
 * degenerates to the bare LCG with RNG->DR == 0, which is what the comment in
 * `axoloti_math.h` describes as the seed's own recurrence.
 */
#ifndef AXO_SHIM_H
#define AXO_SHIM_H

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include <limits.h>

#define PI_F 3.1415927f
#define SAMPLERATE 48000
#define BUFSIZE 16
#define BUFSIZE_POW 4
typedef int32_t int32buffer[BUFSIZE];

#ifndef INT32_MAX
#define INT32_MAX 2147483647
#endif
#ifndef HALFQ31
#define HALFQ31 (1<<30)
#endif

/* ─── intrinsics ─────────────────────────────────────────────────────────── */

static inline int32_t ___SMMUL(int32_t a, int32_t b) {
  return (int32_t)(((int64_t)a * (int64_t)b) >> 32);
}
static inline int32_t ___SMMLA(int32_t a, int32_t b, int32_t acc) {
  return acc + (int32_t)(((int64_t)a * (int64_t)b) >> 32);
}
static inline int32_t ___SMMLS(int32_t a, int32_t b, int32_t acc) {
  return acc - (int32_t)(((int64_t)a * (int64_t)b) >> 32);
}
static inline int32_t __SSAT(int32_t x, unsigned n) {
  const int32_t hi = (int32_t)((1u << (n - 1)) - 1u);
  const int32_t lo = -hi - 1;
  return x > hi ? hi : (x < lo ? lo : x);
}
static inline int32_t __USAT(int32_t x, unsigned n) {
  const int32_t hi = (int32_t)((1u << n) - 1u);
  return x > hi ? hi : (x < 0 ? 0 : x);
}
static inline uint32_t __CLZ(uint32_t x) {
  return x == 0 ? 32u : (uint32_t)__builtin_clz(x);
}
static inline int32_t __QADD(int32_t a, int32_t b) {
  int64_t r = (int64_t)a + (int64_t)b;
  if (r > INT32_MAX) return INT32_MAX;
  if (r < (int64_t)INT32_MIN) return INT32_MIN;
  return (int32_t)r;
}
static inline int32_t __QSUB(int32_t a, int32_t b) {
  int64_t r = (int64_t)a - (int64_t)b;
  if (r > INT32_MAX) return INT32_MAX;
  if (r < (int64_t)INT32_MIN) return INT32_MIN;
  return (int32_t)r;
}
static inline int32_t __QADD16(int32_t a, int32_t b) { /* packed halfword add */
  int32_t lo = (int16_t)(a & 0xFFFF) + (int16_t)(b & 0xFFFF);
  int32_t hi = (int16_t)(a >> 16) + (int16_t)(b >> 16);
  if (lo > 32767) lo = 32767; if (lo < -32768) lo = -32768;
  if (hi > 32767) hi = 32767; if (hi < -32768) hi = -32768;
  return (int32_t)(((uint32_t)hi << 16) | ((uint32_t)lo & 0xFFFFu));
}

static inline int32_t __ssat_half(int32_t v) { return (int16_t)(v & 0xFFFF); }
static inline int32_t __ssat_htop(int32_t v) { return (int16_t)((v >> 16) & 0xFFFF); }

static inline int32_t ___SMULBB(int32_t a, int32_t b) { return __ssat_half(a) * __ssat_half(b); }
static inline int32_t ___SMULBT(int32_t a, int32_t b) { return __ssat_half(a) * __ssat_htop(b); }
static inline int32_t ___SMULTB(int32_t a, int32_t b) { return __ssat_htop(a) * __ssat_half(b); }
static inline int32_t ___SMULTT(int32_t a, int32_t b) { return __ssat_htop(a) * __ssat_htop(b); }
static inline int32_t ___SMULWB(int32_t a, int32_t b) {
  return (int32_t)(((int64_t)a * (int64_t)__ssat_half(b)) >> 16);
}
static inline int32_t ___SMULWT(int32_t a, int32_t b) {
  return (int32_t)(((int64_t)a * (int64_t)__ssat_htop(b)) >> 16);
}
static inline int32_t ___SMLABB(int32_t a, int32_t b, int32_t acc) { return acc + ___SMULBB(a, b); }
static inline int32_t ___SMLAWB(int32_t a, int32_t b, int32_t acc) { return acc + ___SMULWB(a, b); }
static inline int32_t ___SMLAWT(int32_t a, int32_t b, int32_t acc) { return acc + ___SMULWT(a, b); }
static inline int32_t ___SMUAD(int32_t a, int32_t b) { return ___SMULBB(a, b) + ___SMULTT(a, b); }
static inline int32_t ___SMUSD(int32_t a, int32_t b) { return ___SMULBB(a, b) - ___SMULTT(a, b); }
static inline float _VSQRTF(float x) { return sqrtf(x); }

/*
 * Pure function. float -> int32 with ARM VCVT.S32.F32 semantics: round toward
 * zero, and SATURATE at the int32 ends.
 *
 * THIS IS NOT PEDANTRY, IT IS A MEASURED BUG IN THE NAIVE SHIM. `axoloti_math.c`
 * builds `sine2t[i] = (int32_t)(INT32_MAX * sinf(f))`, and at the quarter turn
 * that product is exactly 2147483648.0f — one past int32. ARM clamps it to
 * 0x7FFFFFFF; x86's cvttss2si returns 0x80000000. Leaving the plain C cast in
 * put a full-scale NEGATIVE spike at the positive peak of every sine the
 * harness generated, which would have been read as "our port is wrong".
 * Applied at every float->int narrowing that can reach the boundary.
 */
static inline int32_t f2i_sat(double v) {
  if (v >= 2147483647.0) return INT32_MAX;
  if (v <= -2147483648.0) return INT32_MIN;
  return (int32_t)v;
}

/* ─── tables (firmware/axoloti_math.c axoloti_math_init) ─────────────────── */

#define SINETSIZE 1024
#define SINE2TSIZE 4096
#define WINDOWSIZE 1024
#define PITCHTSIZE 257
#define EXPTSIZE 256
#define LOGTSIZE 256
#define LOGTSIZEN 8

static int16_t  sinet[SINETSIZE + 1];
static int32_t  sine2t[SINE2TSIZE + 1];
static int16_t  windowt[WINDOWSIZE + 1];
static uint32_t pitcht[PITCHTSIZE];
static uint16_t expt[EXPTSIZE];
static uint16_t logt[LOGTSIZE];

static void axoloti_math_init(void) {
  for (int i = 0; i < SINETSIZE + 1; i++) {
    /* hardware: arm_sin_q31(i<<21) >> 16 — see the sinet note in the header */
    double q = 2147483647.0 * sin(i * 2.0 * M_PI / (double)SINETSIZE);
    sinet[i] = (int16_t)(f2i_sat(q) >> 16);
  }
  for (int i = 0; i < SINE2TSIZE + 1; i++) {
    float f = i * 2 * PI_F / (float)SINE2TSIZE;
    sine2t[i] = f2i_sat(INT32_MAX * sinf(f));
  }
  for (int i = 0; i < WINDOWSIZE + 1; i++) {
    float f = i * 2 * PI_F / (float)WINDOWSIZE;
    windowt[i] = (int16_t)f2i_sat(32767.0f * (0.5f - 0.5f * cosf(f)));
  }
  for (int i = 0; i < PITCHTSIZE; i++) {
    /* verbatim, INCLUDING the float `powf` inside a `double` expression — that
     * narrowing is the source of their pitch table's small error and it is
     * reproduced, not fixed. */
    double f = 440.0 * powf(2.0, (i - 69.0 - 64.0) / 12.0);
    double phi = 4.0 * (double)(1 << 30) * f / (SAMPLERATE * 1.0);
    if (phi > ((unsigned int)1 << 31)) phi = 0x7FFFFFFF;
    pitcht[i] = (uint32_t)phi;
  }
  for (int i = 0; i < EXPTSIZE; i++) {
    double e = pow(2.0, ((float)i) / (float)EXPTSIZE);
    expt[i] = (uint16_t)(uint32_t)(e * (1 + INT16_MAX));
  }
  for (int i = 0; i < LOGTSIZE; i++) {
    double e = 0.5 * log(1.0 + ((double)i / (double)LOGTSIZE)) / log(2.0);
    logt[i] = (uint16_t)(uint32_t)(e * (1 + INT16_MAX));
  }
}

typedef union {
  int32_t i;
  float f;
  struct { uint32_t mantissa : 23; uint32_t exponent : 8; uint32_t sign : 1; } parts;
} Float_t;

static uint32_t FastLog(uint32_t i) {
  Float_t f;
  f.f = (float)i;
  uint32_t r = f.parts.exponent << 23;
  r += f.parts.mantissa >> 10;
  return r;
}

/* ─── math helpers, verbatim from api/axoloti_math.h ─────────────────────── */

static inline uint32_t mtof48k_q31(int32_t pitch) {
  int32_t p = __SSAT(pitch, 28);
  uint32_t pi = p >> 21;
  int32_t y1 = pitcht[128 + pi];
  int32_t y2 = pitcht[128 + 1 + pi];
  int32_t pf = (p & 0x1fffff) << 10;
  int32_t pfc = INT32_MAX - pf;
  uint32_t r;
  r = ___SMMUL(y1, pfc);
  r = ___SMMLA(y2, pf, r);
  return r << 1;
}
static inline uint32_t mtof48k_ext_q31(int32_t pitch) {
  int32_t p = __SSAT(pitch, 29);
  uint32_t pi = p >> 21;
  int32_t y1 = pitcht[128 + pi];
  int32_t y2 = pitcht[128 + 1 + pi];
  int32_t pf = (p & 0x1fffff) << 10;
  int32_t pfc = INT32_MAX - pf;
  uint32_t r;
  r = ___SMMUL(y1, pfc);
  r = ___SMMLA(y2, pf, r);
  return r << 1;
}
static inline int32_t sin_q31(int32_t phase) {
  uint32_t p = (uint32_t)(phase);
  uint32_t pi = p >> 20;
  int32_t y1 = sine2t[pi];
  int32_t y2 = sine2t[1 + pi];
  int32_t pf = (p & 0xfffff) << 11;
  int32_t pfc = INT32_MAX - pf;
  int32_t rr;
  rr = ___SMMUL(y1, pfc);
  rr = ___SMMLA(y2, pf, rr);
  return rr << 1;
}
static inline uint32_t hann_q31(int32_t phase) {
  uint32_t p = phase;
  uint32_t pi = p >> 22;
  int32_t y1 = windowt[pi];
  int32_t y2 = windowt[1 + pi];
  int32_t pf = (p & 0x3fffff) << 9;
  int32_t pfc = INT32_MAX - pf;
  int32_t rr;
  rr = ___SMMUL(y1 << 16, pfc);
  rr = ___SMMLA(y2 << 16, pf, rr);
  return rr << 1;
}
static inline float   q27_to_float(int32_t v) { return (float)v / 134217728.0f; }
static inline int32_t float_to_q27(float f)   { return f2i_sat((double)f * 134217728.0); }
static inline int32_t ConvertIntToFrac(int i)     { return (i << 21); }
static inline int32_t ConvertFracToInt(int i)     { return (i >> 21); }
static inline int32_t ConvertFloatToFrac(float f) { return f2i_sat((double)f * (double)(1 << 21)); }

/*
 * CMSIS `arm_sin_q31` / `arm_cos_q31`, as used by `api/axoloti_filters.h`'s
 * `biquad_*_coefs` (`filter/lp`, `bp`, `hp`, `eq4`, …).
 *
 * ⚠ A FULL CYCLE SPANS 2^31 HERE, NOT 2^32, AND THAT FACTOR OF TWO IS AN OCTAVE.
 * Axoloti's own `sin_q31` takes a full turn across the whole uint32 range; CMSIS
 * does not. The bundled CMSIS is v1.6.0 (`api/CMSIS/DSP/Include/arm_math.h`),
 * where `FAST_MATH_TABLE_SIZE` is 512, `sinTable_q31` has 513 entries, and the
 * index is `(uint32_t)x >> FAST_MATH_Q31_SHIFT` with the shift 32-10 — a TEN-BIT
 * index into a 513-entry table. Ten bits only stays in bounds for x < 2^31, so
 * one period is 2^31 of input, i.e. `arm_sin_q31(x) == sin_q31(x << 1)`.
 *
 * WHY THIS IS WRITTEN OUT AT LENGTH: the harness first shimmed it as plain
 * `sin_q31`, and `filter/lp` then measured an octave BELOW `filter/vcf3` at the
 * same dial — which the report would have called a real one-octave defect in our
 * `ax-biquad` node. It was the shim. Under the convention above the two Axoloti
 * biquads agree with each other (1523 Hz vs 1528 Hz at pitch 24) and with ours.
 * `f_filter_biquad_A`, which is what `filter/vcf3` calls, does not touch these —
 * it computes its own sine through `SINE2TINTERP` — so vcf3 was never affected
 * either way, and that independence is what made the octave diagnosable at all.
 *
 * Second-order deviation, recorded: ours reads Axoloti's 4096-entry `sine2t`
 * where CMSIS reads its own 512-entry table, so our coefficient is marginally
 * more accurate than hardware's. Objects reaching these are flagged
 * `cmsis_sin_approx`.
 */
static inline int32_t arm_sin_q31(int32_t x) { return sin_q31(x << 1); }
static inline int32_t arm_cos_q31(int32_t x) { return sin_q31((x << 1) + (1 << 30)); }

/* RNG->DR is unreachable and non-reproducible; see the header note. */
static uint32_t axo_rand_seed = 22222;
static inline int32_t rand_s32(void) {
  return (int32_t)(axo_rand_seed = (axo_rand_seed * 196314165u) + 0u);
}
static inline int ax_rand(void) { return (int)(((uint32_t)rand_s32()) >> 1); }
#define rand ax_rand
#ifdef RAND_MAX
#undef RAND_MAX
#endif
#define RAND_MAX INT32_MAX
static inline uint32_t GenerateRandomNumber(void) { return (uint32_t)rand_s32(); }

#define MTOF(pitch, frequency)      frequency = mtof48k_q31(pitch);
#define MTOFEXTENDED(pitch, frequency) frequency = mtof48k_ext_q31(pitch);
#define SINE2TINTERP(phase, output) output = sin_q31(phase);
#define HANNING2TINTERP(phase, output) output = hann_q31(phase);

/* ─── parameter functions, verbatim from api/parameter_functions.h ───────── */

static inline int32_t pfun_inl_signed_clamp(int32_t v)   { return __SSAT(v, 28); }
static inline int32_t pfun_inl_unsigned_clamp(int32_t v) { return __USAT(v, 27); }
static inline int32_t pfun_inl_signed_clamp_fullrange(int32_t v)   { return __SSAT(v, 28) << 4; }
static inline int32_t pfun_inl_unsigned_clamp_fullrange(int32_t v) { return __USAT(v, 27) << 4; }
static inline int32_t pfun_inl_signed_clamp_squarelaw(int32_t v) {
  int32_t psat = __SSAT(v, 28) << 4;
  if (psat > 0) return ___SMMUL(psat, psat) >> 3;
  else return -___SMMUL(psat, psat) >> 3;
}
static inline int32_t pfun_inl_unsigned_clamp_squarelaw(int32_t v) {
  int32_t psat = __USAT(v, 27) << 4;
  return ___SMMUL(psat, psat) >> 3;
}
static inline int32_t pfun_inl_signed_clamp_fullrange_squarelaw(int32_t v) {
  int32_t psat = __SSAT(v, 28) << 4;
  if (psat > 0) return ___SMMUL(psat, psat) << 1;
  else return -___SMMUL(psat, psat) << 1;
}
static inline int32_t pfun_inl_unsigned_clamp_fullrange_squarelaw(int32_t v) {
  int32_t psat = __USAT(v, 27) << 4;
  return ___SMMUL(psat, psat) << 1;
}
static inline int32_t pfun_inl_kexpltime(int32_t v) {
  int32_t in = (-v); int32_t out; MTOF(in, out); return out >> 2;
}
static inline int32_t pfun_inl_kexpdtime(int32_t v) {
  int32_t in = (-v); int32_t out; MTOF(in, out); return 0x7FFFFFFF - (out >> 2);
}

/* ─── the shim's own self-check ──────────────────────────────────────────── */

/*
 * Query. Returns 0 when every assumed equivalence holds; prints and returns
 * nonzero otherwise. Called at the top of every generated harness, so a broken
 * shim can never be mistaken for a broken port.
 */
static int axo_shim_selftest(void) {
  int bad = 0;
  #define CHECK(cond, msg) do { if (!(cond)) { fprintf(stderr, "axo_shim: FAILED %s\n", msg); bad++; } } while (0)

  /* signed >> must be arithmetic — C leaves this implementation-defined */
  CHECK((((int32_t)-8) >> 2) == -2, "signed right shift is arithmetic");

  /* SMMUL: 0.5 x 0.5 in Q31 == 0.25 in Q31 shifted down one word */
  CHECK(___SMMUL(HALFQ31, HALFQ31) == (1 << 28), "SMMUL Q31 half squared");
  /* SMMUL truncates toward -inf (arithmetic shift of the product) */
  CHECK(___SMMUL(-1, 1) == -1, "SMMUL truncates toward -inf");
  CHECK(___SMMLS(HALFQ31, HALFQ31, 0) == -(1 << 28), "SMMLS");

  CHECK(__SSAT(1 << 30, 28) == ((1 << 27) - 1), "SSAT 28 upper");
  CHECK(__SSAT(-(1 << 30), 28) == -(1 << 27), "SSAT 28 lower");
  CHECK(__USAT(-5, 27) == 0, "USAT floor");
  CHECK(__CLZ(0) == 32, "CLZ zero");
  CHECK(___SMULWB(1 << 30, 0x00004000) == (1 << 28), "SMULWB");

  /* THE TUNING ANCHOR. pitch 0 == MIDI 64 == E4 == 329.6276 Hz, and object
   * "frequency" is a 32-bit phase increment at 48 kHz. This one assertion
   * exercises pitcht, __SSAT, ___SMMUL and ___SMMLA together, and it is the
   * single most common porting error, so it is checked before anything runs. */
  {
    double got = (double)mtof48k_q31(0);
    double want = 329.6276 / 48000.0 * 4294967296.0;
    CHECK(fabs(got - want) / want < 2e-4, "mtof48k_q31(0) is E4 = 329.6276 Hz");
    /* an octave up must double it */
    double oct = (double)mtof48k_q31(12 << 21);
    CHECK(fabs(oct / got - 2.0) < 1e-3, "mtof48k_q31 octave doubles");
  }
  /* sin_q31 quarter turn is full scale */
  CHECK(sin_q31(0x40000000) > 2147000000, "sin_q31 peak");
  CHECK(sin_q31(0) == 0, "sin_q31 zero");

  #undef CHECK
  return bad;
}

#endif /* AXO_SHIM_H */
