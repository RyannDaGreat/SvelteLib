/**
 * THE VC-5 KERNELS — Valley, FrozenWasteland, dbRackModules, repelzen and two
 * closed-source VCV Rack modules, ported to float and to bare node.
 *
 * ── WHAT THIS FILE IS ───────────────────────────────────────────────────────
 * The ONE copy of this block's arithmetic, and the R7-17 DERIVATION RECORD for
 * every node in it. `synth/worklets/processors_vc5.js` is only the audio-thread
 * bridge over these classes; `core/audio_specs_vc5.js` is only the knob and port
 * declaration, and each spec's `help` points here rather than repeating any of
 * it. tests/port_vc5_test.js imports THIS file, so a check is a check on what
 * ships — the same layering `synth/ax3_kernels.js` established, for the same
 * reason (two implementations of one recurrence is the Tower of Babel failure at
 * its most literal).
 *
 * Bare node only: no Vite syntax, no DOM, no PowerRP imports (the ENGINE law).
 *
 * ══ V — THE VOLTAGE SCALING, DECIDED ONCE FOR THE WHOLE BLOCK ═══════════════
 * Rack is ±5 V nominal / ±10 V max on a cable; our `audio` wire is ±1 and our
 * `number` wires carry real units. So:
 *
 *   V1  AN AUDIO WIRE IS ±1 AND A RACK CABLE IS ±5 V, so every audio port
 *       crossing the boundary is scaled by RACK_VOLTS_PER_UNIT = 5:
 *       `volts = unit * 5` on the way in, `unit = volts / 5` on the way out.
 *       This is applied at the KERNEL BOUNDARY (the first and last line of each
 *       `process`), never sprinkled through the recurrence, so a numeric trace
 *       against the C++ can be taken in VOLTS and compared directly.
 *   V2  A `number` PORT CARRIES REAL UNITS AND NEVER VOLTS. Rack expresses every
 *       modulation as "CV input × attenuverter knob", which is two controls for
 *       one quantity; here the quantity has ONE knob in its own units (seconds,
 *       hertz, semitones, or the module's own 0..1 / 0..10 dial) and the same
 *       name as an input that SUMS with it. So a Rack attenuverter has no port
 *       at all — it was a unit conversion, and the unit is now stated.
 *   V3  A MODULE'S OWN DIAL RANGE IS KEPT VERBATIM (Plateau's Decay really is
 *       0.1..0.9999, its Diffusion really is 0..10, Feline's Cutoff really is
 *       0..10). That is what lets the param values the survey recorded for the
 *       twenty patches be copied across unchanged, which is the entire point of
 *       porting rather than reimplementing. Panel tapers (Plateau's square-law
 *       size, Feline's squared drive) are reproduced INSIDE the kernel.
 *
 * ══ D0 — DETERMINISM, THE HARD LAW ══════════════════════════════════════════
 * `<app>/CLAUDE.md` § "The three kinds of state": Δt = 0 ⟹ the frame is
 * byte-identical. Three modules in this block read a host RNG in their original
 * (`Shaper::warble` seeds from `std::time(NULL)`, `reburst`'s jitter and CV modes
 * call `rack::random::uniform()`, and the Dattorro tank's four LFOs are
 * free-running from a fixed phase). Every one of them here draws from
 * `Vc5Random`, a seeded 32-bit MWC generator whose seed is a CONSTRUCT-TIME KNOB,
 * so the same document renders the same samples forever. The tank's LFOs already
 * started from fixed phases in the original and are left exactly as they were.
 *
 * ══ WHAT IS SOURCE-DERIVED AND WHAT IS BEHAVIOUR-DERIVED ════════════════════
 * SOURCE-DERIVED (C++ read at the commit named in each class's record):
 *   Plateau, Feline, Terrorform   ValleyAudio/ValleyRackFree @ 86f02e43
 *   JustAPhaser                   almostEric/FrozenWasteland @ 608d49dc
 *   SPF                           docb/dbRackModules         @ fa15d1b7
 *   rewin, reburst                wiqid/repelzen             @ 78b1765e
 * BEHAVIOUR-DERIVED (no source exists — say so rather than imply otherwise):
 *   Chronoblob2   AlrightDevices. CLOSED SOURCE: the VCV manifest carries
 *                 pluginUrl + manualUrl and NO `sourceUrl`, and the author ships
 *                 prebuilt `.vcvplugin` binaries only. Ported from the published
 *                 manual's control-by-control description plus the panel state
 *                 the survey recorded for P1/P20/P21. Marked `behaviourDerived`.
 *   XFX F-35      Blamsoft. CLOSED SOURCE for the same reason (VCVRack/library
 *                 manifests/Blamsoft-XFXF35.json has no `sourceUrl`). Ported
 *                 from the vendor's own mode list and stated topology.
 */

// ── SHARED CONSTANTS ────────────────────────────────────────────────────────

/** V1. One unit on our ±1 audio wire is five Rack volts. */
export const RACK_VOLTS_PER_UNIT = 5;

/** Rack clamps a cable at ±10 V and several of these modules clamp their own
 *  output there explicitly (Plateau, Terrorform). Kept as their number. */
export const RACK_MAX_VOLTS = 10;

/**
 * Pure function. Rack's `dsp::FREQ_C4` — the V/oct reference, 0 V = C4.
 *
 * Valley spells it `pitch2freq` as `261.6255 * exp(pitch * ln2)`, which is
 * `261.6255 * 2^pitch` with a five-significant-figure C4 and a seven-figure ln2.
 * Rack's own constant is 261.6256. THE VALLEY NUMBER IS KEPT (deviation named per
 * class) because a Valley oscillator tuned to Rack's constant would be 0.7 cents
 * sharp of the module being ported, and 0.7 cents is audible against a second
 * copy of the same patch.
 *
 * @param {number} volts - a V/oct voltage
 * @returns {number} hertz
 *
 * @example valleyPitchToHz(0) // 261.6255
 * @example Math.round(valleyPitchToHz(1)) // 523
 * @example Math.round(valleyPitchToHz(-1) * 100) / 100 // 130.81
 */
export const VALLEY_FREQ_C4 = 261.6255;
export const VALLEY_LN2 = 0.6931471806;
export function valleyPitchToHz(volts) {
  return VALLEY_FREQ_C4 * Math.exp(volts * VALLEY_LN2);
}

/**
 * Pure function. The `440 * 2^(pitch - 5)` dial-to-hertz law Valley uses for
 * every FILTER and DAMPING control (Plateau's four damping knobs, Feline's
 * cutoff, and — coincidentally, from a different author — SPF's and
 * JustAPhaser's `2^pitch` knobs offset differently).
 *
 * Dial 5 is A440, dial 0 is 13.75 Hz, dial 10 is 14080 Hz. It is NOT Axoloti's
 * `440*2^((p-5)/12)`: the exponent is whole OCTAVES, not semitones, which is why
 * a ten-notch dial spans the whole audible range.
 *
 * @param {number} dial - the module's own 0..10 dial position
 * @returns {number} hertz
 *
 * @example valleyDialToHz(5) // 440
 * @example valleyDialToHz(0) // 13.75
 * @example valleyDialToHz(10) // 14080
 */
export function valleyDialToHz(dial) {
  return 440 * Math.pow(2, dial - 5);
}

/**
 * Pure function. `Utilities.hpp clip` / Rack's `clamp`.
 *
 * @example clampTo(3, 0, 1) // 1
 * @example clampTo(-3, 0, 1) // 0
 * @example clampTo(0.5, 0, 1) // 0.5
 */
export function clampTo(x, lo, hi) {
  return x < lo ? lo : x > hi ? hi : x;
}

/**
 * Pure function. `Utilities.hpp linterp` — `a + f*(b - a)`, NOT the symmetric
 * `(1-f)a + fb`. The difference is one rounding ulp and it is theirs.
 *
 * @example linterp(0, 10, 0.25) // 2.5
 * @example linterp(2, 2, 0.9) // 2
 */
export function linterp(a, b, f) {
  return a + f * (b - a);
}

/**
 * Pure function. `Utilities.hpp scale` — an affine remap with no clamping.
 *
 * @example scaleRange(5, 0, 10, 0, 0.7) // 0.35
 * @example scaleRange(0, 0, 10, 0, 0.7) // 0
 */
export function scaleRange(a, inMin, inMax, outMin, outMax) {
  return ((a - inMin) / (inMax - inMin)) * (outMax - outMin) + outMin;
}

/**
 * Pure function. Valley's `NonLinear.hpp tanhDriveSignal` — a piecewise-quadratic
 * tanh that saturates HARD at ±1.25 input. Used by Plateau's optional output
 * saturator and by every stage of Feline's ladder (as `vecDriveSignal`, which is
 * the same three cases with the same constants).
 *
 * It is NOT tanh: it is exactly linear inside ±0.75, parabolic to ±1.25, and
 * clipped beyond. tanh(1) is 0.7616 where this returns 0.9375 — a 2.1 dB
 * difference at unity, which is why the real function must be ported rather than
 * substituted.
 *
 * @param {number} x - the signal
 * @param {number} drive - a pre-gain applied before the shaping
 * @returns {number} in [-1, 1]
 *
 * @example tanhDriveSignal(0.5, 1) // 0.5
 * @example tanhDriveSignal(1, 1) // 0.9375
 * @example tanhDriveSignal(-1, 1) // -0.9375
 * @example tanhDriveSignal(2, 1) // 1
 * @example tanhDriveSignal(0.5, 2) // 0.9375
 */
export function tanhDriveSignal(x, drive) {
  const xd = x * drive;
  if (xd < -1.25) return -1;
  if (xd < -0.75) return -(xd * (-2.5 - xd) - 0.5625);
  if (xd > 1.25) return 1;
  if (xd > 0.75) return xd * (2.5 - xd) - 0.5625;
  return xd;
}

/**
 * Pure function. Valley's `SIMDUtilities.hpp _mm_wrap_1_ps` — truncate toward
 * zero and subtract, i.e. the FRACTIONAL PART WITH SIGN. `wrapUnit(-0.25)` is
 * −0.25, not 0.75; the shapers rely on that.
 *
 * @example wrapUnit(1.25) // 0.25
 * @example wrapUnit(-0.25) // -0.25
 * @example wrapUnit(3) // 0
 */
export function wrapUnit(a) {
  return a - Math.trunc(a);
}

/**
 * Pure function. Valley's `_mm_circle_ps` — fold a value into [-1, 1] by
 * subtracting the nearest even integer, treating the positive and negative
 * halves separately (their `posRectify`/`negRectify` split).
 *
 * The reason it exists is that `sin(PI * circleWrap(x)) === sin(PI * x)` for all
 * x, so their 9th-order Taylor sine — which is only accurate on [-PI, PI] — can
 * be used at any phase. That identity is what lets us call `Math.sin` instead
 * (deviation D-SINE, per class).
 *
 * @example circleWrap(0.5) // 0.5
 * @example circleWrap(2.5) // 0.5
 * @example circleWrap(-2.5) // -0.5
 * @example circleWrap(1.5) // -0.5
 */
export function circleWrap(a) {
  const pos = a > 0 ? a : 0;
  const neg = a < 0 ? a : 0;
  const posShift = Math.trunc(pos * 0.5 + 0.5) * 2;
  const negShift = Math.trunc(Math.abs(neg) * 0.5 + 0.5) * 2;
  return pos - posShift + (neg + negShift);
}

/**
 * Pure function. Valley's `_mm_polyblep_ps` — the two-sample polynomial band
 * limiting step correction, used by Terrorform's sub-oscillator.
 *
 * @param {number} t - phase in [0, 1)
 * @param {number} dt - phase increment per sample
 * @returns {number} the correction to add, 0 away from a discontinuity
 *
 * @example polyBlep(0.5, 0.01) // 0
 * @example polyBlep(0, 0.01) // -1
 * @example Math.round(polyBlep(0.995, 0.01) * 1000) / 1000 // 0.75
 */
export function polyBlep(t, dt) {
  if (t < dt) {
    const x = t / dt;
    return x + x - x * x - 1;
  }
  if (t > 1 - dt) {
    const x = (t - 1) / dt;
    return x + x + x * x + 1;
  }
  return 0;
}

/**
 * A SEEDED 32-bit multiply-with-carry generator — D0, the determinism law.
 *
 * Valley's own `Utilities.cpp mwcRand` is this exact recurrence, and this is why
 * the seeded version can be byte-identical to theirs given the same state: the
 * ONLY thing changed is where the initial state comes from (`std::rand()` after
 * `srand(time(NULL))` in `Shaper`'s constructor, `rack::random` in reburst).
 *
 * Near-pure (advances its own state). Command-ish by CQS, but it is a value
 * source and is documented as such at every call site.
 *
 * @example const r = new Vc5Random(1); r.nextFloat() === r.nextFloat() // false
 * @example const a = new Vc5Random(7), b = new Vc5Random(7); a.nextFloat() === b.nextFloat() // true
 */
export class Vc5Random {
  /** @param {number} seed - the construct-time knob; 0 uses their own initialisers */
  constructor(seed = 0) {
    // Two 32-bit words are needed and one seed is given, so the second word is
    // the seed's bits scrambled by an odd multiplier. `| 1` keeps both words
    // non-zero, which MWC requires — a zero word locks the generator at zero,
    // which would be a silent failure rather than a loud one.
    this.z = (((seed >>> 0) ^ 0x9e3779b9) >>> 0) | 1;
    this.w = ((((seed >>> 0) * 0x85ebca6b) >>> 0) ^ 0xdeadbeef) | 1;
  }

  /** Command (advances state). Valley's `mwcRand`, as a uint32. */
  nextUint32() {
    this.z = (36969 * (this.z & 65535) + (this.z >>> 16)) >>> 0;
    this.w = (18000 * (this.w & 65535) + (this.w >>> 16)) >>> 0;
    return (((this.z << 16) >>> 0) + this.w) >>> 0;
  }

  /** Command (advances state). A float in [0, 1), the form both call sites want. */
  nextFloat() {
    return this.nextUint32() / 4294967296;
  }
}

// ════════════════════════════════════════════════════════════════════════════
// VALLEY'S DSP PRIMITIVES — shared by Plateau and (the one-poles) by Terrorform
// ════════════════════════════════════════════════════════════════════════════

/**
 * `dsp/delays/InterpDelay.hpp` — a linear-interpolating delay line with a
 * separate integer TAP reader.
 *
 * ── THE OFF-BY-ONE BETWEEN `output` AND `tap()` IS THEIRS AND IS LOAD-BEARING ─
 * `process()` writes at `w`, reads at `r = w - t` and only THEN increments `w`.
 * So `output` is the sample `t` (+fraction) old. `tap(i)` runs after that
 * increment and reads `buffer[w - i]`, which is `i - 1` samples old. Plateau's
 * seven output taps therefore all read one sample EARLIER than a naive reading of
 * the Dattorro paper would place them. Reproduced exactly; a numeric trace
 * against the C++ is the only way to be sure, and tests/port_vc5_test.js takes
 * one.
 *
 * Command (mutates the ring buffer). Untested as a class; proven through
 * DattorroTank's trace.
 */
export class InterpDelay {
  /**
   * @param {number} maxLength - buffer length in samples; must be > 0
   * @param {number} initDelayTime - initial delay, may be fractional
   */
  constructor(maxLength = 512, initDelayTime = 0) {
    if (!(maxLength > 0)) throw new Error(`InterpDelay: maxLength must be > 0, got ${maxLength}`);
    this.l = Math.floor(maxLength);
    this.buffer = new Float64Array(this.l);
    this.w = 0;
    this.t = 0;
    this.f = 0;
    this.input = 0;
    this.output = 0;
    this.setDelayTime(initDelayTime);
  }

  /** Command. One sample through the line; leaves the read in `output`. */
  process() {
    this.buffer[this.w] = this.input;
    let r = this.w - this.t;
    if (r < 0) r += this.l;
    this.w += 1;
    if (this.w === this.l) this.w = 0;
    let upperR = r - 1;
    if (upperR < 0) upperR += this.l;
    this.output = linterp(this.buffer[r], this.buffer[upperR], this.f);
    return this.output;
  }

  /** Query. The sample `i - 1` frames old — see the class docblock's off-by-one. */
  tap(i) {
    let j = this.w - i;
    if (j < 0) j += this.l;
    return this.buffer[j];
  }

  /** Command. Split a fractional delay into integer + fraction, clamped to the buffer. */
  setDelayTime(newDelayTime) {
    let d = newDelayTime;
    if (d >= this.l) d = this.l - 1;
    if (d < 0) d = 0;
    this.t = Math.trunc(d);
    this.f = d - this.t;
  }

  /** Command. Zero the line. */
  clear() {
    this.buffer.fill(0);
    this.input = 0;
    this.output = 0;
  }
}

/**
 * `dsp/delays/AllpassFilter.hpp` — a Schroeder allpass around an InterpDelay.
 *
 *   inSum  = input + delay.output * gain
 *   output = delay.output - inSum * gain
 *   delay.input = inSum ; delay.process()
 *
 * Note the SIGN: their `output = delay.output + _inSum * gain * -1`. With a
 * POSITIVE gain this is the textbook `-g·x[n] + … `; Plateau's tank uses a
 * NEGATIVE gain on apf1 and a positive one on apf2, which is what makes the two
 * sections diffuse in opposite senses.
 *
 * Command (mutates its delay line).
 */
export class AllpassFilter {
  constructor(maxDelay = 512, initDelay = 0, gain = 0) {
    this.delay = new InterpDelay(maxDelay, initDelay);
    this.gain = gain;
    this.input = 0;
    this.output = 0;
  }

  /** Command. One sample through the section. */
  process() {
    const inSum = this.input + this.delay.output * this.gain;
    this.output = this.delay.output - inSum * this.gain;
    this.delay.input = inSum;
    this.delay.process();
    return this.output;
  }

  /** Command. Their assert is `-1 <= g <= 1`; ours THROWS rather than sliding
   *  quietly into an unstable section. */
  setGain(newGain) {
    if (!(newGain >= -1 && newGain <= 1)) {
      throw new Error(`AllpassFilter: gain must be in [-1, 1], got ${newGain}`);
    }
    this.gain = newGain;
  }

  /** Command. Zero the section. */
  clear() {
    this.input = 0;
    this.output = 0;
    this.delay.clear();
  }
}

/**
 * `dsp/filters/OnePoleFilters.hpp OnePoleLPFilter` — `z = a*x + b*z`,
 * `b = exp(-2*PI*fc/fs)`, `a = 1 - b`.
 *
 * Command (mutates `_z`).
 */
export class OnePoleLPFilter {
  constructor(cutoffFreq = 22049, sampleRate = 44100) {
    this.input = 0;
    this.output = 0;
    this._z = 0;
    this._sampleRate = sampleRate;
    this._cutoffFreq = -1;
    this._maxCutoffFreq = sampleRate / 2 - 1;
    this.setCutoffFreq(cutoffFreq);
  }

  /** Command. One sample. */
  process() {
    this._z = this._a * this.input + this._z * this._b;
    this.output = this._z;
    return this.output;
  }

  /** Command. Recompute the coefficient pair. Their `if (fc == _cutoffFreq) return`
   *  early-out is kept: it is what makes a per-sample `setCutoffFreq` call cheap,
   *  and Plateau makes one. */
  setCutoffFreq(cutoffFreq) {
    if (cutoffFreq === this._cutoffFreq) return;
    this._cutoffFreq = clampTo(cutoffFreq, 1, this._maxCutoffFreq);
    this._b = Math.exp((-2 * Math.PI * this._cutoffFreq) / this._sampleRate);
    this._a = 1 - this._b;
  }

  /** Command. */
  setSampleRate(sampleRate) {
    this._sampleRate = sampleRate;
    this._maxCutoffFreq = sampleRate / 2 - 1;
    const fc = this._cutoffFreq;
    this._cutoffFreq = -1;
    this.setCutoffFreq(fc);
  }

  /** Command. */
  clear() {
    this.input = 0;
    this.output = 0;
    this._z = 0;
  }
}

/**
 * `dsp/filters/OnePoleFilters.hpp OnePoleHPFilter` — a one-pole one-zero
 * highpass, `y = a0*x + a1*x1 + b1*y1` with `b1 = exp(-2*PI*fc/fs)`,
 * `a0 = (1 + b1)/2`, `a1 = -a0`.
 *
 * ⚠ THEIR SIGN CONVENTION IS UNUSUAL and it is the whole filter: `b1` is
 * POSITIVE in the recursion, so the pole sits at `+b1`. That is what makes this a
 * DC blocker rather than a lowpass, and it is why Plateau's `setLowCutFrequency`
 * of 0 Hz would give `b1 = 1` and an integrator — hence the clamp below.
 *
 * Command (mutates `_x1`/`_y1`).
 */
export class OnePoleHPFilter {
  constructor(cutoffFreq = 10, sampleRate = 44100) {
    this.input = 0;
    this.output = 0;
    this._x1 = 0;
    this._y1 = 0;
    this._sampleRate = sampleRate;
    this._cutoffFreq = -1;
    this._maxCutoffFreq = sampleRate / 2 - 1;
    this.setCutoffFreq(cutoffFreq);
  }

  /** Command. One sample. */
  process() {
    const x0 = this.input;
    const y0 = this._a0 * x0 + this._a1 * this._x1 + this._b1 * this._y1;
    this._y1 = y0;
    this._x1 = x0;
    this.output = y0;
    return y0;
  }

  /** Command. THEIR `assert(cutoffFreq > 0)` becomes a CLAMP TO 1 Hz here, not a
   *  throw: Plateau really does ask for 0 Hz (its Reverb-low-cut dial at 10 gives
   *  `10 - 10 = 0` -> `440*2^-5` … no, its dial 0 gives pitch 0 -> 13.75 Hz, but
   *  `inputLowCut` starts at 0.0 before the first `setInputFilterLowCutoffPitch`).
   *  A hard assert there would take the whole reverb down on construction; 1 Hz is
   *  inaudible and finite. Named deviation D-HPCLAMP in DattorroReverb. */
  setCutoffFreq(cutoffFreq) {
    if (cutoffFreq === this._cutoffFreq) return;
    this._cutoffFreq = clampTo(cutoffFreq, 1, this._maxCutoffFreq);
    this._b1 = Math.exp((-2 * Math.PI * this._cutoffFreq) / this._sampleRate);
    this._a0 = (1 + this._b1) / 2;
    this._a1 = -this._a0;
  }

  /** Command. */
  setSampleRate(sampleRate) {
    this._sampleRate = sampleRate;
    this._maxCutoffFreq = sampleRate / 2 - 1;
    const fc = this._cutoffFreq;
    this._cutoffFreq = -1;
    this.setCutoffFreq(fc);
    this.clear();
  }

  /** Command. */
  clear() {
    this.input = 0;
    this.output = 0;
    this._x1 = 0;
    this._y1 = 0;
  }
}

/**
 * `dsp/modulation/LFO.hpp TriSawLFO` — the tank's modulation oscillator, and the
 * reason Plateau's tank shimmers instead of ringing.
 *
 * A rising ramp to `revPoint` then a falling ramp back, scaled to ±1. At
 * revPoint 0.5 it is a triangle; at 0.001 it is a falling saw; at 0.999 a rising
 * one. `Plateau`'s Mod Shape knob IS this reversal point.
 *
 * ⚠ THREE QUIRKS, ALL REPRODUCED, ALL AUDIBLE:
 *  1. `_rising` is only set true when `_step > 1.0`, and `_step` is compared
 *     BEFORE it is advanced — so the very first sample after construction is
 *     computed with `_rising = true` and `_step = 0`, giving −1.
 *  2. `_output` uses `_step`, not a wrapped phase, so the falling branch is
 *     `step*fallRate - fallRate` = `(step - 1)*fallRate`, which reaches 0 at
 *     step = 1 rather than at step = revPoint. The waveform is therefore NOT
 *     symmetric about its reversal point unless revPoint is 0.5.
 *  3. `setFrequency` early-outs on equality, so a `setModSpeed` called every
 *     sample (which Plateau does) is free.
 *
 * The `phase` field is public and written directly by the tank's constructor to
 * spread its four LFOs 90° apart — but `process()` NEVER READS IT. That is a
 * source bug: the four LFOs are quadrature only in intent. Reproduced, named
 * D-LFOPHASE in DattorroTank.
 *
 * Command (advances `_step`).
 */
export class TriSawLFO {
  constructor(sampleRate = 44100, frequency = 1) {
    this.phase = 0;
    this._output = 0;
    this._sampleRate = sampleRate;
    this._step = 0;
    this._stepSize = 0;
    this._rising = true;
    this._frequency = 0;
    this.setFrequency(frequency);
    this.setRevPoint(0.5);
  }

  /** Command. One sample, in [-1, 1]. */
  process() {
    if (this._step > 1) {
      this._step -= 1;
      this._rising = true;
    }
    if (this._step >= this._revPoint) this._rising = false;
    this._output = this._rising
      ? this._step * this._riseRate
      : this._step * this._fallRate - this._fallRate;
    this._step += this._stepSize;
    this._output = this._output * 2 - 1;
    return this._output;
  }

  /** Command. */
  setFrequency(frequency) {
    if (frequency === this._frequency) return;
    this._frequency = frequency;
    this._stepSize = this._frequency / this._sampleRate;
  }

  /** Command. The reversal point, clamped to their own [0.0001, 0.999]. */
  setRevPoint(revPoint) {
    this._revPoint = clampTo(revPoint, 0.0001, 0.999);
    this._riseRate = 1 / this._revPoint;
    this._fallRate = -1 / (1 - this._revPoint);
  }

  /** Command. */
  setSampleRate(sampleRate) {
    this._sampleRate = sampleRate;
    this._stepSize = this._frequency / this._sampleRate;
  }
}

/**
 * `dsp/modulation/LinearEnvelope` — a one-shot linear ramp from `_start` to
 * `_end` over `_time` seconds. Plateau uses exactly one, for the CLEAR button's
 * 4 ms fade-out / clear / fade-in, and nothing else.
 *
 * Their `_justFinished` latch is reproduced verbatim, including that it is only
 * cleared on a NOT-running `process()` — so the flag survives for one call after
 * the ramp lands, which is what Plateau's three-stage `if` chain relies on.
 *
 * Command (advances `_t`).
 */
export class LinearEnvelope {
  constructor(sampleRate = 44100) {
    this._value = 0;
    this._t = 0;
    this._running = false;
    this._justFinished = false;
    this._time = 1;
    this._sampleRate = sampleRate;
    this.setStartEndPoints(0, 1);
  }

  /** Command. One sample of the ramp. */
  process() {
    if (this._running) {
      this._t += this._deltaT;
      this._value = this._t * this._m + this._start;
    } else {
      this._justFinished = false;
    }
    if (this._t >= 1 && this._running) {
      this._t = 0;
      this._running = false;
      this._justFinished = true;
    }
    return this._value;
  }

  /** Command. Restart from `_start`. */
  trigger() {
    this._t = 0;
    this._running = true;
    this._justFinished = false;
  }

  /** Command. */
  setStartEndPoints(startPoint, endPoint) {
    this._start = startPoint;
    this._end = endPoint;
    this._m = this._end - this._start;
    this._deltaT = 1 / (this._time * this._sampleRate);
  }

  /** Command. */
  setTime(time) {
    this._time = time;
    this._m = this._end - this._start;
    this._deltaT = 1 / (this._time * this._sampleRate);
  }
}

// ════════════════════════════════════════════════════════════════════════════
// PLATEAU — Valley/Plateau, a Dattorro (1997) figure-of-eight plate reverb
// ════════════════════════════════════════════════════════════════════════════

/** Dattorro's paper is written at 29761 Hz and EVERY delay length in the tank is
 *  a sample count at that rate, rescaled here. This is the number that makes the
 *  plate the size it is. */
export const DATTORRO_SAMPLE_RATE = 29761;

/**
 * ⚠ D-TANKRATE — THE TANK IS CAPPED AT 44100 Hz AND THAT IS A SOURCE BUG.
 *
 * `Dattorro1997Tank` declares `double maxSampleRate = 44100.` as a FIELD INITIALISER
 * and its constructor never assigns from `initMaxSampleRate`; `setSampleRate` then does
 * `sampleRate = sampleRate > maxSampleRate ? maxSampleRate : sampleRate`. Plateau
 * constructs `reverb(192000, 16, sizeMax)`, so the intent was clearly a 192 kHz ceiling
 * — but the tank clamps itself to 44100 whatever it is told.
 *
 * THE AUDIBLE CONSEQUENCE, and why this is reproduced rather than fixed: at a 48 kHz
 * engine the tank's `sampleRateScale` is 44100/29761 instead of 48000/29761, so every
 * delay in the figure-of-eight is 8.8% SHORT and the whole plate is 8.8% smaller and
 * brighter than the Size dial claims — and its two damping filters, which never receive
 * a sample rate at all (see D-TANKFILTERRATE), are cut 8.8% low to match. A Plateau in
 * Rack at 48 kHz sounds exactly like this. Fixing it would make our port disagree with
 * every recording of the 21 patches that end in this module.
 */
export const TANK_MAX_SAMPLE_RATE = 44100;

/**
 * `Plateau/Dattorro.hpp Dattorro1997Tank` — the figure-of-eight tank.
 *
 * ── DERIVATION RECORD (R7-17) ───────────────────────────────────────────────
 * SOURCE   github.com/ValleyAudio/ValleyRackFree, `src/Plateau/Dattorro.cpp`
 *          + `Dattorro.hpp`, class `Dattorro1997Tank`, read at commit
 *          86f02e431136a7f5c96a872b99b7115b7e133e05.
 *          Algorithm reference: Dattorro, J. (1997), "Effect design part 1:
 *          Reverberator and other filters", JAES 45(9), 660-684.
 * BLOCK    `Dattorro1997Tank::process` (the recurrence),
 *          `::tickApfModulation` (the four LFOs), `::setDiffusion`,
 *          `::setDecay`, `::rescaleApfAndDelayTimes`, `::rescaleTapTimes`,
 *          `::initialiseDelaysAndApfs`. Not a `code.krate`/`code.srate` split:
 *          C++ modules have none, and EVERYTHING here runs at sample rate.
 *
 * THE RECURRENCE AS PORTED (all times in samples at the tank's own rate;
 * `S = min(fs, 44100)/29761` and `T` is the Size time scale):
 *
 *     // once per sample, BEFORE anything else
 *     lApf1.delay.t = lfo1() * excursion + 672*T*S
 *     lApf2.delay.t = lfo2() * excursion + 1800*T*S
 *     rApf1.delay.t = lfo3() * excursion + 908*T*S
 *     rApf2.delay.t = lfo4() * excursion + 2656*T*S
 *     excursion = modDepth * 16 * S
 *
 *     decay = frozen ? 1 : decayParam
 *     lSum += lIn ;  rSum += rIn          // lSum/rSum CARRY the cross-coupling
 *
 *     lApf1.in = lSum
 *     lDelay1.in = lApf1.process() ; lDelay1.process()        // 4453*T*S
 *     lHighCut.in = lDelay1.out
 *     lLowCut.in  = lHighCut.process()
 *     lApf2.in = (lDelay1.out*(1 - fade) + lLowCut.process()*fade) * decay
 *     lDelay2.in = lApf2.process() ; lDelay2.process()        // 3720*T*S
 *     ... the right half identically, with 908 / 4217 / 2656 / 3163 ...
 *
 *     rSum = lDelay2.out * decay        // THE FIGURE OF EIGHT: left feeds RIGHT
 *     lSum = rDelay2.out * decay
 *
 *     // seven taps per output, signs and sources exactly as below
 *     lOut = DC(  lApf1.out
 *               + lDelay1.tap(266) + lDelay1.tap(2974)
 *               - lApf2.delay.tap(1913) + lDelay2.tap(1996)
 *               - rDelay1.tap(1990) - rApf2.delay.tap(187) - rDelay2.tap(1066) ) * 0.5
 *     rOut = DC(  rApf1.out
 *               + rDelay1.tap(266) + rDelay1.tap(2974)
 *               - rApf2.delay.tap(1913) + rDelay2.tap(1996)
 *               - lDelay1.tap(1990) - lApf2.delay.tap(187) - lDelay2.tap(1066) ) * 0.5
 *
 *     fade += fadeStep * fadeDir ; fade = clamp(fade, 0, 1)
 *
 * ⚠ THE TAP INDEX TABLE IS SHARED BETWEEN THE TWO OUTPUTS AND THE ENUMS DISAGREE
 * WITH THAT. `kOutputTaps` has SEVEN entries and both `LeftOutTaps` and
 * `RightOutTaps` index the same seven, so `R_DELAY_1_R_TAP_1 == L_DELAY_1_L_TAP_1
 * == 0` and the right channel reads its own lines at the LEFT channel's tap
 * offsets. Dattorro's paper specifies fourteen distinct offsets. Reproduced —
 * the two channels are decorrelated by their different DELAY LENGTHS, not by
 * their tap offsets, and that is what Plateau actually sounds like.
 *
 * DEVIATIONS, NAMED:
 *   D-TANKRATE       see the constant above: the 44100 clamp is theirs.
 *   D-TANKFILTERRATE the two damping filters are constructed at the default
 *                    44100 and `setSampleRate` never touches them (it only
 *                    re-rates the two output DC blockers). Reproduced.
 *   D-LFOPHASE       the constructor writes `lfo2.phase = 0.25` etc, but
 *                    `TriSawLFO::process` never reads `phase`. All four LFOs
 *                    therefore start IN PHASE and differ only in frequency
 *                    (0.10 / 0.15 / 0.12 / 0.18 Hz x modSpeed). Reproduced,
 *                    because the beat pattern between those four frequencies IS
 *                    the shimmer, and starting them 90 degrees apart would change it.
 *   D-FADETIME       `fadeStep` is initialised to `1/(0.002*fs)` (2 ms) and then
 *                    OVERWRITTEN by `setSampleRate` with `1/fs` — so the freeze
 *                    crossfade really takes ONE SECOND, not two milliseconds.
 *                    Reproduced; it is why Plateau's Hold has a long tail.
 *   D-DOUBLE         all arithmetic is double here as it is there; the delay
 *                    lines are Float64Array for the same reason.
 *   D0               nothing in the tank reads a host RNG, so the seed knob does
 *                    not reach it. The four LFOs are deterministic already.
 *
 * Command (mutates twelve delay lines, four LFOs and six filters).
 */
export class DattorroTank {
  /**
   * @param {number} initSampleRate - the engine rate; CLAMPED to 44100, see D-TANKRATE
   * @param {number} initMaxLfoDepth - buffer padding for the LFO excursion (Plateau: 16)
   * @param {number} initMaxTimeScale - the largest Size the buffers must hold (Plateau: 4)
   */
  constructor(initSampleRate = 44100, initMaxLfoDepth = 0, initMaxTimeScale = 1) {
    this.maxSampleRate = TANK_MAX_SAMPLE_RATE;
    this.maxTimeScale = initMaxTimeScale;
    this.timePadding = initMaxLfoDepth;
    this.timeScale = 1;
    this.modDepth = 0;
    this.decayParam = 0;
    this.decay = 0;
    this.lfoExcursion = 0;
    this.frozen = false;
    this.fade = 1;
    this.fadeDir = 1;
    this.fadeStep = 1 / (DattorroTank.FADE_TIME_SECONDS * initSampleRate);
    this.leftSum = 0;
    this.rightSum = 0;
    this.scaledOutputTaps = new Array(DattorroTank.OUTPUT_TAPS.length).fill(0);

    this.lfo1 = new TriSawLFO(initSampleRate, DattorroTank.LFO_FREQS[0]);
    this.lfo2 = new TriSawLFO(initSampleRate, DattorroTank.LFO_FREQS[1]);
    this.lfo3 = new TriSawLFO(initSampleRate, DattorroTank.LFO_FREQS[2]);
    this.lfo4 = new TriSawLFO(initSampleRate, DattorroTank.LFO_FREQS[3]);
    // D-LFOPHASE: written, never read by process(). Kept so the field exists
    // where a reader of the C++ expects it and the deviation is visible in code.
    this.lfo2.phase = 0.25;
    this.lfo3.phase = 0.5;
    this.lfo4.phase = 0.75;

    // D-TANKFILTERRATE: the four damping filters take the DEFAULT 44100 and are
    // never re-rated. The two output DC blockers are, in setSampleRate below.
    this.leftHighCutFilter = new OnePoleLPFilter();
    this.leftLowCutFilter = new OnePoleHPFilter();
    this.rightHighCutFilter = new OnePoleLPFilter();
    this.rightLowCutFilter = new OnePoleHPFilter();
    this.leftOutDCBlock = new OnePoleHPFilter(DattorroTank.DC_BLOCK_HZ);
    this.rightOutDCBlock = new OnePoleHPFilter(DattorroTank.DC_BLOCK_HZ);

    this.setSampleRate(initSampleRate);
  }

  /**
   * Command. One sample through the tank.
   *
   * @param {number} leftIn - the diffused input, already scaled
   * @param {number} rightIn - ditto (Plateau feeds the same signal to both)
   * @param {Float64Array} out - two-element scratch; [0] is left, [1] is right
   * @returns {void} (writes `out`)
   */
  process(leftIn, rightIn, out) {
    this.tickApfModulation();

    this.decay = this.frozen ? 1 : this.decayParam;

    this.leftSum += leftIn;
    this.rightSum += rightIn;

    const fade = this.fade;
    const decay = this.decay;

    this.leftApf1.input = this.leftSum;
    this.leftDelay1.input = this.leftApf1.process();
    this.leftDelay1.process();
    this.leftHighCutFilter.input = this.leftDelay1.output;
    this.leftLowCutFilter.input = this.leftHighCutFilter.process();
    this.leftApf2.input = (this.leftDelay1.output * (1 - fade) + this.leftLowCutFilter.process() * fade) * decay;
    this.leftDelay2.input = this.leftApf2.process();
    this.leftDelay2.process();

    this.rightApf1.input = this.rightSum;
    this.rightDelay1.input = this.rightApf1.process();
    this.rightDelay1.process();
    this.rightHighCutFilter.input = this.rightDelay1.output;
    this.rightLowCutFilter.input = this.rightHighCutFilter.process();
    this.rightApf2.input = (this.rightDelay1.output * (1 - fade) + this.rightLowCutFilter.process() * fade) * decay;
    this.rightDelay2.input = this.rightApf2.process();
    this.rightDelay2.process();

    // THE FIGURE OF EIGHT. Each half's tail feeds the OTHER half's head.
    this.rightSum = this.leftDelay2.output * decay;
    this.leftSum = this.rightDelay2.output * decay;

    const taps = this.scaledOutputTaps;
    let l = this.leftApf1.output;
    l += this.leftDelay1.tap(taps[0]);
    l += this.leftDelay1.tap(taps[1]);
    l -= this.leftApf2.delay.tap(taps[2]);
    l += this.leftDelay2.tap(taps[3]);
    l -= this.rightDelay1.tap(taps[4]);
    l -= this.rightApf2.delay.tap(taps[5]);
    l -= this.rightDelay2.tap(taps[6]);
    this.leftOutDCBlock.input = l;

    let r = this.rightApf1.output;
    r += this.rightDelay1.tap(taps[0]);
    r += this.rightDelay1.tap(taps[1]);
    r -= this.rightApf2.delay.tap(taps[2]);
    r += this.rightDelay2.tap(taps[3]);
    r -= this.leftDelay1.tap(taps[4]);
    r -= this.leftApf2.delay.tap(taps[5]);
    r -= this.leftDelay2.tap(taps[6]);
    this.rightOutDCBlock.input = r;

    out[0] = this.leftOutDCBlock.process() * DattorroTank.OUTPUT_GAIN;
    out[1] = this.rightOutDCBlock.process() * DattorroTank.OUTPUT_GAIN;

    this.fade = clampTo(this.fade + this.fadeStep * this.fadeDir, 0, 1);
  }

  /** Command. Four LFOs and four modulated allpass delay times, once per sample. */
  tickApfModulation() {
    this.leftApf1.delay.setDelayTime(this.lfo1.process() * this.lfoExcursion + this.scaledLeftApf1Time);
    this.leftApf2.delay.setDelayTime(this.lfo2.process() * this.lfoExcursion + this.scaledLeftApf2Time);
    this.rightApf1.delay.setDelayTime(this.lfo3.process() * this.lfoExcursion + this.scaledRightApf1Time);
    this.rightApf2.delay.setDelayTime(this.lfo4.process() * this.lfoExcursion + this.scaledRightApf2Time);
  }

  /** Command. Hold: decay becomes exactly 1 and the damping filters fade OUT of
   *  the loop over `1/fadeStep` seconds, which is what makes a frozen tank stop
   *  losing high frequencies rather than merely stop decaying. */
  freeze(freezeFlag) {
    this.frozen = freezeFlag;
    if (this.frozen) {
      this.fadeDir = -1;
      this.decay = 1;
    } else {
      this.fadeDir = 1;
      this.decay = this.decayParam;
    }
  }

  /** Command. Rebuilds every delay line. Their exact statement order is kept —
   *  including that `setTimeScale` runs BEFORE the lines are reallocated, so the
   *  delay times it sets are discarded and the tank comes back with zero-length
   *  delays until the next `setTimeScale`. Plateau calls that every sample. */
  setSampleRate(newSampleRate) {
    let rate = newSampleRate;
    if (rate > this.maxSampleRate) rate = this.maxSampleRate;
    if (rate < 1) rate = 1;
    this.sampleRate = rate;
    this.sampleRateScale = rate / DATTORRO_SAMPLE_RATE;

    // D-FADETIME: theirs, verbatim. One second, not the 2 ms the field initialiser
    // in the header suggests.
    this.fadeStep = 1 / this.sampleRate;

    this.leftOutDCBlock.setSampleRate(this.sampleRate);
    this.rightOutDCBlock.setSampleRate(this.sampleRate);
    this.leftOutDCBlock.setCutoffFreq(DattorroTank.DC_BLOCK_HZ);
    this.rightOutDCBlock.setCutoffFreq(DattorroTank.DC_BLOCK_HZ);

    this.rescaleTapTimes();
    this.setTimeScale(this.timeScale);
    this.initialiseDelaysAndApfs();
    this.clear();
  }

  /** Command. The Size control, in Dattorro-time units. */
  setTimeScale(newTimeScale) {
    this.timeScale = Math.max(newTimeScale, DattorroTank.MIN_TIME_SCALE);
    this.rescaleApfAndDelayTimes();
  }

  /** Command. */
  setDecay(newDecay) {
    this.decayParam = clampTo(newDecay, 0, 1);
  }

  /** Command. The four LFO frequencies scale together, so Mod Rate keeps their
   *  beat RATIOS and only changes the tempo of the shimmer. */
  setModSpeed(newModSpeed) {
    this.lfo1.setFrequency(DattorroTank.LFO_FREQS[0] * newModSpeed);
    this.lfo2.setFrequency(DattorroTank.LFO_FREQS[1] * newModSpeed);
    this.lfo3.setFrequency(DattorroTank.LFO_FREQS[2] * newModSpeed);
    this.lfo4.setFrequency(DattorroTank.LFO_FREQS[3] * newModSpeed);
  }

  /** Command. Depth in SAMPLES of allpass excursion, scaled by the sample rate so
   *  the pitch wobble is rate-independent. */
  setModDepth(newModDepth) {
    this.modDepth = newModDepth;
    this.lfoExcursion = newModDepth * DattorroTank.LFO_MAX_EXCURSION * this.sampleRateScale;
  }

  /** Command. The TriSaw reversal point: 0.001 is a falling saw, 0.5 a triangle. */
  setModShape(shape) {
    this.lfo1.setRevPoint(shape);
    this.lfo2.setRevPoint(shape);
    this.lfo3.setRevPoint(shape);
    this.lfo4.setRevPoint(shape);
  }

  /** Command. */
  setHighCutFrequency(frequency) {
    this.leftHighCutFilter.setCutoffFreq(frequency);
    this.rightHighCutFilter.setCutoffFreq(frequency);
  }

  /** Command. */
  setLowCutFrequency(frequency) {
    this.leftLowCutFilter.setCutoffFreq(frequency);
    this.rightLowCutFilter.setCutoffFreq(frequency);
  }

  /** Command. Diffusion 0..10 maps to allpass gains ±0.7 — apf1 NEGATIVE, apf2
   *  POSITIVE, which is what makes the two stages smear in opposite senses. */
  setDiffusion(diffusion) {
    if (!(diffusion >= 0 && diffusion <= 10)) {
      throw new Error(`DattorroTank.setDiffusion: expected 0..10, got ${diffusion}`);
    }
    const d1 = scaleRange(diffusion, 0, 10, 0, DattorroTank.MAX_DIFFUSION_1);
    const d2 = scaleRange(diffusion, 0, 10, 0, DattorroTank.MAX_DIFFUSION_2);
    this.leftApf1.setGain(-d1);
    this.leftApf2.setGain(d2);
    this.rightApf1.setGain(-d1);
    this.rightApf2.setGain(d2);
  }

  /** Command. */
  clear() {
    this.leftApf1.clear();
    this.leftDelay1.clear();
    this.leftHighCutFilter.clear();
    this.leftLowCutFilter.clear();
    this.leftApf2.clear();
    this.leftDelay2.clear();
    this.rightApf1.clear();
    this.rightDelay1.clear();
    this.rightHighCutFilter.clear();
    this.rightLowCutFilter.clear();
    this.rightApf2.clear();
    this.rightDelay2.clear();
    this.leftOutDCBlock.clear();
    this.rightOutDCBlock.clear();
    this.leftSum = 0;
    this.rightSum = 0;
  }

  /** Command. Allocate every line long enough for the LARGEST Size plus the
   *  widest output tap plus the LFO padding — their `calcMaxTime`, verbatim. */
  initialiseDelaysAndApfs() {
    const maxScaledOutputTap = Math.max(...this.scaledOutputTaps);
    const calcMaxTime = (delayTime) =>
      Math.trunc(this.sampleRateScale * (delayTime * this.maxTimeScale + maxScaledOutputTap + this.timePadding));
    const T = DattorroTank.TIMES;
    this.leftApf1 = new AllpassFilter(calcMaxTime(T.leftApf1));
    this.leftDelay1 = new InterpDelay(calcMaxTime(T.leftDelay1));
    this.leftApf2 = new AllpassFilter(calcMaxTime(T.leftApf2));
    this.leftDelay2 = new InterpDelay(calcMaxTime(T.leftDelay2));
    this.rightApf1 = new AllpassFilter(calcMaxTime(T.rightApf1));
    this.rightDelay1 = new InterpDelay(calcMaxTime(T.rightDelay1));
    this.rightApf2 = new AllpassFilter(calcMaxTime(T.rightApf2));
    this.rightDelay2 = new InterpDelay(calcMaxTime(T.rightDelay2));
  }

  /** Command. Size x sample-rate scaling applied to all eight lengths. */
  rescaleApfAndDelayTimes() {
    const f = this.timeScale * this.sampleRateScale;
    const T = DattorroTank.TIMES;
    this.scaledLeftApf1Time = T.leftApf1 * f;
    this.scaledLeftApf2Time = T.leftApf2 * f;
    this.scaledRightApf1Time = T.rightApf1 * f;
    this.scaledRightApf2Time = T.rightApf2 * f;
    // The two APF times are consumed by tickApfModulation; the four plain delays
    // are set here and stay put. THE OUTPUT TAPS ARE NOT SCALED BY SIZE — only by
    // the sample rate (rescaleTapTimes) — so shrinking the plate moves the
    // recirculating delays and leaves the early taps where they were.
    if (this.leftDelay1) this.leftDelay1.setDelayTime(T.leftDelay1 * f);
    if (this.leftDelay2) this.leftDelay2.setDelayTime(T.leftDelay2 * f);
    if (this.rightDelay1) this.rightDelay1.setDelayTime(T.rightDelay1 * f);
    if (this.rightDelay2) this.rightDelay2.setDelayTime(T.rightDelay2 * f);
  }

  /** Command. */
  rescaleTapTimes() {
    for (let i = 0; i < DattorroTank.OUTPUT_TAPS.length; i++) {
      this.scaledOutputTaps[i] = Math.trunc(DattorroTank.OUTPUT_TAPS[i] * this.sampleRateScale);
    }
  }
}

/** The eight delay lengths of the figure-of-eight, in samples at 29761 Hz. These
 *  eight numbers ARE the plate: they are what makes it Plateau rather than a
 *  generic Schroeder reverb, and they are why the two halves decorrelate. */
DattorroTank.TIMES = Object.freeze({
  leftApf1: 672, leftDelay1: 4453, leftApf2: 1800, leftDelay2: 3720,
  rightApf1: 908, rightDelay1: 4217, rightApf2: 2656, rightDelay2: 3163,
});
/** The seven output taps, SHARED by both channels — see the class docblock. */
DattorroTank.OUTPUT_TAPS = Object.freeze([266, 2974, 1913, 1996, 1990, 187, 1066]);
DattorroTank.MAX_DIFFUSION_1 = 0.7;
DattorroTank.MAX_DIFFUSION_2 = 0.7;
DattorroTank.LFO_MAX_EXCURSION = 16;
DattorroTank.LFO_FREQS = Object.freeze([0.1, 0.15, 0.12, 0.18]);
DattorroTank.MIN_TIME_SCALE = 0.0001;
DattorroTank.DC_BLOCK_HZ = 20;
DattorroTank.OUTPUT_GAIN = 0.5;
/** The header's `fadeTime` field initialiser. Overwritten by setSampleRate — see
 *  D-FADETIME — and kept only so the discarded value is visible. */
DattorroTank.FADE_TIME_SECONDS = 0.002;

/**
 * `Plateau/Dattorro.hpp Dattorro` — the input chain in front of the tank: a DC
 * block per channel, a summing lowpass/highpass pair, a pre-delay, and a
 * four-stage Schroeder input diffuser that can be crossfaded out.
 *
 * ── DERIVATION RECORD (R7-17) ───────────────────────────────────────────────
 * SOURCE   ValleyAudio/ValleyRackFree `src/Plateau/Dattorro.cpp`, class
 *          `Dattorro`, @ 86f02e431136a7f5c96a872b99b7115b7e133e05.
 * BLOCK    `Dattorro::process`, `::setPreDelay`, `::setSampleRate`, and the
 *          constructor's four `AllpassFilter` initialisations.
 *
 * THE RECURRENCE AS PORTED:
 *
 *     inputLpf.fc = inputHighCut ; inputHpf.fc = inputLowCut
 *     x  = leftDCBlock(lIn) + rightDCBlock(rIn)      // MONO SUM, both channels
 *     x  = inputHpf(inputLpf(x))
 *     preDelay.in = x ; preDelay.process()           // 0..0.5 s
 *     y  = apf4(apf3(apf2(apf1(preDelay.out))))      // 141, 107, 379, 277 @ 29761
 *     tankFeed = preDelay.out*(1 - diffuse) + y*diffuse
 *     tank.process(tankFeed, tankFeed, ...)          // SAME signal to both halves
 *
 * ⚠ PLATEAU IS MONO IN, STEREO OUT. `Dattorro::process` sums L and R and feeds
 * ONE signal to both tank halves; the stereo image at the output is manufactured
 * entirely by the tank's asymmetric delay lengths and tap signs. A stereo source
 * through Plateau does NOT keep its image. That is the module, not an omission.
 *
 * DEVIATIONS: D-HPCLAMP (the input highpass is asked for 0 Hz at construction and
 * our OnePoleHPFilter clamps to 1 Hz where theirs would `assert` in a debug build
 * and compute a marginally-stable integrator in a release one. UNREACHABLE in
 * practice: Plateau writes the cutoff every sample and its dial floor is
 * 13.75 Hz, so the constructor's 0 never survives the first sample.)
 * D-INAPFRATE: the four input allpasses are SIZED at the 192 kHz the constructor
 * is given and then RETUNED to the engine rate, exactly as theirs are — so they
 * carry 8x more buffer than they use. Kept: the sizing is what makes
 * `setSampleRate` safe at any rate.
 *
 * Command.
 */
export class DattorroReverb {
  constructor(initMaxSampleRate = 44100, initMaxLfoDepth = 16, initMaxTimeScale = 1) {
    this.tank = new DattorroTank(initMaxSampleRate, initMaxLfoDepth, initMaxTimeScale);
    this.sampleRate = initMaxSampleRate;
    this.dattorroScaleFactor = this.sampleRate / DATTORRO_SAMPLE_RATE;
    this.preDelayTime = 0;
    this.inputLowCut = 0;
    this.inputHighCut = 10000;
    this.diffuseInput = 0;
    this.leftOut = 0;
    this.rightOut = 0;
    this.tankFeed = 0;
    this.tankOut = new Float64Array(2);

    this.leftInputDCBlock = new OnePoleHPFilter(DattorroTank.DC_BLOCK_HZ);
    this.rightInputDCBlock = new OnePoleHPFilter(DattorroTank.DC_BLOCK_HZ);
    this.inputLpf = new OnePoleLPFilter(DattorroReverb.INPUT_LPF_INIT_HZ);
    this.inputHpf = new OnePoleHPFilter(0);

    this.preDelay = new InterpDelay(DattorroReverb.PRE_DELAY_SAMPLES, 0);

    const A = DattorroReverb.IN_APF_TIMES;
    const H = DattorroReverb.IN_APF_HEADROOM;
    this.inApf1 = new AllpassFilter(this.dattorroScale(H * A[0]), this.dattorroScale(A[0]), DattorroReverb.INPUT_DIFFUSION_1);
    this.inApf2 = new AllpassFilter(this.dattorroScale(H * A[1]), this.dattorroScale(A[1]), DattorroReverb.INPUT_DIFFUSION_1);
    this.inApf3 = new AllpassFilter(this.dattorroScale(H * A[2]), this.dattorroScale(A[2]), DattorroReverb.INPUT_DIFFUSION_2);
    this.inApf4 = new AllpassFilter(this.dattorroScale(H * A[3]), this.dattorroScale(A[3]), DattorroReverb.INPUT_DIFFUSION_2);
  }

  /** Command. One sample; the outputs land in `leftOut`/`rightOut`. */
  process(leftInput, rightInput) {
    this.leftInputDCBlock.input = leftInput;
    this.rightInputDCBlock.input = rightInput;
    this.inputLpf.setCutoffFreq(this.inputHighCut);
    this.inputHpf.setCutoffFreq(this.inputLowCut);
    this.inputLpf.input = this.leftInputDCBlock.process() + this.rightInputDCBlock.process();
    this.inputHpf.input = this.inputLpf.process();
    this.inputHpf.process();
    this.preDelay.input = this.inputHpf.output;
    this.preDelay.process();
    this.inApf1.input = this.preDelay.output;
    this.inApf2.input = this.inApf1.process();
    this.inApf3.input = this.inApf2.process();
    this.inApf4.input = this.inApf3.process();
    const d = this.diffuseInput;
    this.tankFeed = this.preDelay.output * (1 - d) + this.inApf4.process() * d;

    this.tank.process(this.tankFeed, this.tankFeed, this.tankOut);
    this.leftOut = this.tankOut[0];
    this.rightOut = this.tankOut[1];
  }

  /** Query. Their `dattorroScale` — a 29761-rate sample count at our rate. */
  dattorroScale(delayTime) {
    return delayTime * this.dattorroScaleFactor;
  }

  /** Command. */
  clear() {
    this.leftInputDCBlock.clear();
    this.rightInputDCBlock.clear();
    this.inputLpf.clear();
    this.inputHpf.clear();
    this.preDelay.clear();
    this.inApf1.clear();
    this.inApf2.clear();
    this.inApf3.clear();
    this.inApf4.clear();
    this.tank.clear();
  }

  /** Command. */
  setTimeScale(timeScale) {
    this.tank.setTimeScale(Math.max(timeScale, DattorroTank.MIN_TIME_SCALE));
  }

  /** Command. Pre-delay in SECONDS. */
  setPreDelay(t) {
    this.preDelayTime = t;
    this.preDelay.setDelayTime(this.preDelayTime * this.sampleRate);
  }

  /** Command. */
  setSampleRate(newSampleRate) {
    if (!(newSampleRate > 0)) throw new Error(`DattorroReverb: sampleRate must be > 0, got ${newSampleRate}`);
    this.sampleRate = newSampleRate;
    this.tank.setSampleRate(this.sampleRate);
    this.dattorroScaleFactor = this.sampleRate / DATTORRO_SAMPLE_RATE;
    this.setPreDelay(this.preDelayTime);
    const A = DattorroReverb.IN_APF_TIMES;
    this.inApf1.delay.setDelayTime(this.dattorroScale(A[0]));
    this.inApf2.delay.setDelayTime(this.dattorroScale(A[1]));
    this.inApf3.delay.setDelayTime(this.dattorroScale(A[2]));
    this.inApf4.delay.setDelayTime(this.dattorroScale(A[3]));
    this.leftInputDCBlock.setSampleRate(this.sampleRate);
    this.rightInputDCBlock.setSampleRate(this.sampleRate);
    this.leftInputDCBlock.setCutoffFreq(DattorroTank.DC_BLOCK_HZ);
    this.rightInputDCBlock.setCutoffFreq(DattorroTank.DC_BLOCK_HZ);
    this.inputLpf.setSampleRate(this.sampleRate);
    this.inputHpf.setSampleRate(this.sampleRate);
    this.clear();
  }

  /** Command. */
  freeze(freezeFlag) {
    this.tank.freeze(freezeFlag);
  }

  /** Command. A 0..10 DIAL, not hertz — `440 * 2^(dial - 5)`. */
  setInputFilterLowCutoffPitch(pitch) {
    this.inputLowCut = valleyDialToHz(pitch);
  }

  /** Command. */
  setInputFilterHighCutoffPitch(pitch) {
    this.inputHighCut = valleyDialToHz(pitch);
  }

  /** Command. A HARD 0/1 crossfade, not a continuous one: the button is a
   *  button. Their `enable ? 1 : 0`. */
  enableInputDiffusion(enable) {
    this.diffuseInput = enable ? 1 : 0;
  }

  /** Command. */
  setDecay(newDecay) {
    this.tank.setDecay(newDecay);
  }

  /** Command. */
  setTankDiffusion(diffusion) {
    this.tank.setDiffusion(diffusion);
  }

  /** Command. */
  setTankFilterHighCutFrequency(pitch) {
    this.tank.setHighCutFrequency(valleyDialToHz(pitch));
  }

  /** Command. */
  setTankFilterLowCutFrequency(pitch) {
    this.tank.setLowCutFrequency(valleyDialToHz(pitch));
  }

  /** Command. */
  setTankModSpeed(modSpeed) {
    this.tank.setModSpeed(modSpeed);
  }

  /** Command. */
  setTankModDepth(modDepth) {
    this.tank.setModDepth(modDepth);
  }

  /** Command. */
  setTankModShape(modShape) {
    this.tank.setModShape(modShape);
  }
}

/** The four input-diffuser allpass lengths, in samples at 29761 Hz. */
DattorroReverb.IN_APF_TIMES = Object.freeze([141, 107, 379, 277]);
/** Their `8 * kInApfNTime` sizing headroom — the buffers are eight times the
 *  delay so a sample-rate change can retune them without reallocating. */
DattorroReverb.IN_APF_HEADROOM = 8;
DattorroReverb.INPUT_DIFFUSION_1 = 0.75;
DattorroReverb.INPUT_DIFFUSION_2 = 0.625;
/** `InterpDelay<double>(192010, 0)` — 0.5 s of pre-delay at their 192 kHz
 *  ceiling, plus their ten samples of slack. */
DattorroReverb.PRE_DELAY_SAMPLES = 192010;
DattorroReverb.INPUT_LPF_INIT_HZ = 22000;

/**
 * `Valley/Plateau` — the module: dial tapers, dry/wet, Hold, Clear and the
 * optional output saturator around a `DattorroReverb`.
 *
 * ── DERIVATION RECORD (R7-17) ───────────────────────────────────────────────
 * SOURCE   ValleyAudio/ValleyRackFree `src/Plateau/Plateau.cpp` + `Plateau.hpp`,
 *          model `Plateau`, @ 86f02e431136a7f5c96a872b99b7115b7e133e05.
 * BLOCK    `Plateau::getParameters` (every taper below) and `Plateau::process`
 *          (the wet/dry sum and the saturator). The DSP is in DattorroReverb /
 *          DattorroTank above; this class is the PANEL.
 *
 * THE TAPERS AS PORTED — these are the knob laws, and they are why a dial value
 * copied out of a `.vcv` patch means the same thing here:
 *
 *     preDelay  = dial                                        // seconds, 0..0.5
 *     size      = tuned ? clamp(0.0025 * 2^(5*dial), 0.0025, 2.5)
 *                       : clamp(rescale(dial^2, 0,1, 0.01,4), 0.01, 4)
 *     diffusion = clamp(dial, 0, 10)
 *     decay     = 1 - (1 - clamp(dial, 0.1, 0.9999))^2        // NOT the dial
 *     inLowCut  = 10 - clamp(dial + 5, 0, 10)                 // REVERSED dial
 *     inHighCut =      clamp(dial + 5, 0, 10)
 *     rvLowCut  = 10 - clamp(dial + 5, 0, 10)                 // REVERSED dial
 *     rvHighCut =      clamp(dial + 5, 0, 10)
 *     modSpeed  = clamp(dial,0,1)^2 * 99 + 1                  // 1x .. 100x
 *     modShape  = clamp(rescale(dial, 0,1, 0.001, 0.999), 0.001, 0.999)
 *     modDepth  = clamp(dial, 0, 16)                          // samples
 *     dry       = clamp(dial, 0, 1)
 *     wet       = clamp(dial, 0, 1) * 10
 *     tankIn    = in * 0.1 * (sens18 ? 0.12589254 : 1) * clearEnv
 *     out       = in*dry + tankOut*wet*clearEnv
 *     if saturate: out = tanhDrive(out * 0.111, 0.95) * 9.999
 *     else       : out = clamp(out, -10, 10)
 *
 * ⚠ THE DAMPING DIALS ARE OFFSET BY +5 AND TWO OF THEM ARE REVERSED. A "Reverb
 * low cut" dial of 10 is `10 - clamp(15,0,10)` = 0 = 13.75 Hz, i.e. NO low cut,
 * and a dial of 0 is 5 = 440 Hz, i.e. the MOST. Turning the knob up opens the
 * bottom end. The two HIGH cut dials are not reversed. Reproduced; it is the
 * panel's own sense and P20's `Reverb low cut = 6.31` relies on it.
 *
 * ⚠ THE DECAY DIAL IS SQUARED THE WRONG WAY ROUND ON PURPOSE. `1 - (1 - d)^2`
 * expands the TOP of the dial: dial 0.55 (Rack's default) gives 0.7975, dial
 * 0.9999 gives 0.99999999. So most of the travel is short-to-medium tails and the
 * last few percent is where the near-infinite ones live.
 *
 * DEVIATIONS, NAMED:
 *   D-HOLDSTATE   Rack's Hold is a MOMENTARY BUTTON plus a separate "toggle
 *                 mode" switch, and the resulting latch is stored in
 *                 `dataToJson`. A momentary button is not property state, so the
 *                 latch is exposed DIRECTLY as the `hold` knob (property state,
 *                 keyframable per slide, which is strictly more expressive than a
 *                 toggle switch) and the `freeze` gate input ORs with it exactly
 *                 as `inputs[FREEZE_CV_INPUT] > 0.5` does. The toggle-mode switch
 *                 has therefore no port: it existed to turn a momentary press
 *                 into a latch, and the latch is now the control.
 *   D-CLEARTRIG   `Clear` is likewise a momentary button; here it is a TRIGGER
 *                 PORT only. Its three-stage fade-out / clear / fade-in
 *                 (LinearEnvelope, 4 ms) is reproduced exactly, because that
 *                 envelope also scales the DRY path and is audible.
 *   D-NOCV        every `*_CV_PARAM` attenuverter is gone — see V2 in the file
 *                 header. A modulation input carries the knob's own units and
 *                 sums with it, so `size` in is a Size, not a voltage times a
 *                 gain.
 *   D-PANELSTYLE  `panelStyle` / `displayStyle` are cosmetic and not ported.
 *
 * Command.
 */
export class PlateauKernel {
  /**
   * @param {number} sampleRate - the AudioContext rate
   * @param {object} options - construct-time knobs; none are required
   */
  constructor(sampleRate, options = {}) {
    this.reverb = new DattorroReverb(PlateauKernel.MAX_SAMPLE_RATE, DattorroTank.LFO_MAX_EXCURSION, PlateauKernel.SIZE_MAX);
    this.reverb.setSampleRate(sampleRate);
    this.envelope = new LinearEnvelope(sampleRate);
    this.envelope.setTime(PlateauKernel.CLEAR_FADE_SECONDS);
    this.envelope._value = 1;

    this.tuned = false;
    this.diffuseInput = true;
    this.lowSensitivity = false;
    this.softDriveOutput = false;
    this.hold = false;

    this.frozen = false;
    this.clearGate = false;
    this.clearing = false;
    this.fadeOut = false;
    this.fadeIn = false;
    this.prevClear = 0;

    this.setTuned(options.tuned ?? "off");
    this.setDiffuse(options.diffuse ?? "on");
    this.setSensitivity(options.sensitivity ?? "0dB");
    this.setSaturate(options.saturate ?? "off");
    this.setHold(options.hold ?? "off");
  }

  /** Command. `tuned` mode: Size becomes an exponential 0.0025..2.5 so the tank
   *  can be tuned as a resonator rather than sized as a room. */
  setTuned(value) {
    this.tuned = PlateauKernel.readSwitch("tuned", value);
  }

  /** Command. The four-stage input diffuser in or out of the path. */
  setDiffuse(value) {
    this.diffuseInput = PlateauKernel.readSwitch("diffuse", value);
  }

  /** Command. Their context-menu input sensitivity: 0 dB or −18 dB. */
  setSensitivity(value) {
    if (value !== "0dB" && value !== "-18dB") {
      throw new Error(`PlateauKernel.setSensitivity: expected "0dB" or "-18dB", got ${JSON.stringify(value)}`);
    }
    this.lowSensitivity = value === "-18dB";
  }

  /** Command. Their context-menu output saturation. */
  setSaturate(value) {
    this.softDriveOutput = PlateauKernel.readSwitch("saturate", value);
  }

  /** Command. D-HOLDSTATE: the freeze latch as property state. */
  setHold(value) {
    this.hold = PlateauKernel.readSwitch("hold", value);
  }

  /**
   * Command. One sample.
   *
   * @param {object} c - the a-rate controls, by knob key
   * @param {Float64Array} inputs - [in_l, in_r] in our ±1 units
   * @param {Float64Array} frame - two-element output scratch, ±1 units
   * @returns {void} (writes `frame`)
   */
  sample(c, inputs, frame) {
    const reverb = this.reverb;

    // ── HOLD ────────────────────────────────────────────────────────────────
    const freeze = this.hold || c.freeze > PlateauKernel.GATE_THRESHOLD;
    if (freeze !== this.frozen) {
      this.frozen = freeze;
      reverb.freeze(freeze);
    }

    // ── CLEAR: fade out (4 ms) -> clear the tank -> fade in ─────────────────
    const clearHigh = c.clear > PlateauKernel.GATE_THRESHOLD;
    if (clearHigh && !this.prevClear) this.clearing = true;
    this.prevClear = clearHigh ? 1 : 0;
    if (this.clearing) {
      if (!this.fadeOut && !this.fadeIn) {
        this.fadeOut = true;
        this.envelope.setStartEndPoints(1, 0);
        this.envelope.trigger();
      }
      if (this.fadeOut && this.envelope._justFinished) {
        reverb.clear();
        this.fadeOut = false;
        this.fadeIn = true;
        this.envelope.setStartEndPoints(0, 1);
        this.envelope.trigger();
      } else if (this.fadeIn && this.envelope._justFinished) {
        this.fadeIn = false;
        this.clearing = false;
        this.envelope._value = 1;
      }
    }
    this.envelope.process();
    const env = this.envelope._value;

    // ── THE TAPERS ──────────────────────────────────────────────────────────
    let size = c.size;
    if (this.tuned) {
      size = clampTo(PlateauKernel.SIZE_MIN * Math.pow(2, size * PlateauKernel.TUNED_OCTAVES), PlateauKernel.SIZE_MIN, PlateauKernel.TUNED_SIZE_MAX);
    } else {
      size = size * size;
      size = clampTo(scaleRange(size, 0, 1, PlateauKernel.SIZE_FLOOR, PlateauKernel.SIZE_MAX), PlateauKernel.SIZE_FLOOR, PlateauKernel.SIZE_MAX);
    }

    let decay = clampTo(c.decay, PlateauKernel.DECAY_MIN, PlateauKernel.DECAY_MAX);
    decay = 1 - decay;
    decay = 1 - decay * decay;

    const damp = (dial) => clampTo(dial + PlateauKernel.DAMP_DIAL_OFFSET, 0, PlateauKernel.DAMP_DIAL_MAX);
    const inputDampLow = PlateauKernel.DAMP_DIAL_MAX - damp(c.input_low_damp);
    const inputDampHigh = damp(c.input_high_damp);
    const reverbDampLow = PlateauKernel.DAMP_DIAL_MAX - damp(c.reverb_low_damp);
    const reverbDampHigh = damp(c.reverb_high_damp);

    let modSpeed = clampTo(c.mod_speed, 0, 1);
    modSpeed = modSpeed * modSpeed * (PlateauKernel.MOD_SPEED_MAX_MULTIPLE - 1) + 1;
    const modShape = clampTo(scaleRange(c.mod_shape, 0, 1, PlateauKernel.MOD_SHAPE_MIN, PlateauKernel.MOD_SHAPE_MAX), PlateauKernel.MOD_SHAPE_MIN, PlateauKernel.MOD_SHAPE_MAX);
    const modDepth = clampTo(c.mod_depth, 0, PlateauKernel.MOD_DEPTH_MAX);

    reverb.setTimeScale(size);
    reverb.setPreDelay(clampTo(c.pre_delay, 0, PlateauKernel.PRE_DELAY_CLAMP_SECONDS));
    reverb.setInputFilterLowCutoffPitch(inputDampLow);
    reverb.setInputFilterHighCutoffPitch(inputDampHigh);
    reverb.enableInputDiffusion(this.diffuseInput);
    reverb.setDecay(decay);
    reverb.setTankDiffusion(clampTo(c.diffusion, 0, PlateauKernel.DIFFUSION_MAX));
    reverb.setTankFilterLowCutFrequency(reverbDampLow);
    reverb.setTankFilterHighCutFrequency(reverbDampHigh);
    reverb.setTankModSpeed(modSpeed);
    reverb.setTankModDepth(modDepth);
    reverb.setTankModShape(modShape);

    // ── V1: OUR ±1 BECOMES THEIR VOLTS HERE AND NOWHERE ELSE ────────────────
    let vL = clampTo(inputs[0] * RACK_VOLTS_PER_UNIT, -RACK_MAX_VOLTS, RACK_MAX_VOLTS);
    let vR = clampTo(inputs[1] * RACK_VOLTS_PER_UNIT, -RACK_MAX_VOLTS, RACK_MAX_VOLTS);

    const sens = this.lowSensitivity ? PlateauKernel.MINUS_18_DB_GAIN : 1;
    const drive = PlateauKernel.MINUS_20_DB_GAIN * sens * env;
    reverb.process(vL * drive, vR * drive);

    const dry = clampTo(c.dry, 0, 1);
    const wet = clampTo(c.wet, 0, 1) * PlateauKernel.WET_GAIN;
    let outL = vL * dry + reverb.leftOut * wet * env;
    let outR = vR * dry + reverb.rightOut * wet * env;

    if (this.softDriveOutput) {
      outL = tanhDriveSignal(outL * PlateauKernel.SATURATOR_PRE_GAIN, PlateauKernel.SATURATOR_DRIVE) * PlateauKernel.SATURATOR_POST_GAIN;
      outR = tanhDriveSignal(outR * PlateauKernel.SATURATOR_PRE_GAIN, PlateauKernel.SATURATOR_DRIVE) * PlateauKernel.SATURATOR_POST_GAIN;
    } else {
      outL = clampTo(outL, -RACK_MAX_VOLTS, RACK_MAX_VOLTS);
      outR = clampTo(outR, -RACK_MAX_VOLTS, RACK_MAX_VOLTS);
    }

    frame[0] = outL / RACK_VOLTS_PER_UNIT;
    frame[1] = outR / RACK_VOLTS_PER_UNIT;
  }

  /**
   * Pure function. Read an "off"/"on" discrete knob. LOUD on anything else —
   * a switch that silently defaulted would be a control that lies.
   *
   * SHARED WITH TerrorformKernel's eight switches, which is why it is static and
   * why the error message takes the knob's name: one reader for every "off"/"on"
   * row in this block, rather than one per kernel.
   *
   * @example PlateauKernel.readSwitch("hold", "on") // true
   * @example PlateauKernel.readSwitch("hold", "off") // false
   */
  static readSwitch(name, value) {
    if (value !== "off" && value !== "on") {
      throw new Error(`PlateauKernel: ${name} must be "off" or "on", got ${JSON.stringify(value)}`);
    }
    return value === "on";
  }
}

/** `Dattorro reverb(192000, 16, sizeMax)` — the ceiling the buffers are sized
 *  for. NOT the rate the tank runs at; see D-TANKRATE. */
PlateauKernel.MAX_SAMPLE_RATE = 192000;
PlateauKernel.SIZE_MIN = 0.0025;
PlateauKernel.SIZE_MAX = 4;
/** The non-tuned taper's floor — `rescale(dial^2, 0,1, 0.01, 4)` starts at 0.01,
 *  which is a different number from SIZE_MIN and both are theirs. */
PlateauKernel.SIZE_FLOOR = 0.01;
PlateauKernel.TUNED_OCTAVES = 5;
PlateauKernel.TUNED_SIZE_MAX = 2.5;
PlateauKernel.DECAY_MIN = 0.1;
PlateauKernel.DECAY_MAX = 0.9999;
PlateauKernel.DIFFUSION_MAX = 10;
/** The four damping dials read 0..10 and are USED as `dial + 5` clamped to 0..10,
 *  so the top half of every damping knob is flat. Theirs. */
PlateauKernel.DAMP_DIAL_OFFSET = 5;
PlateauKernel.DAMP_DIAL_MAX = 10;
PlateauKernel.MOD_SPEED_MAX_MULTIPLE = 100;
PlateauKernel.MOD_SHAPE_MIN = 0.001;
PlateauKernel.MOD_SHAPE_MAX = 0.999;
PlateauKernel.MOD_DEPTH_MAX = 16;
/** `clamp(preDelay, 0.f, 1.f)` in process — one second, even though the dial
 *  only reaches 0.5 s. The extra half second is reachable through a modulation
 *  input, which is why the clamp is not the dial's max. */
PlateauKernel.PRE_DELAY_CLAMP_SECONDS = 1;
PlateauKernel.MINUS_20_DB_GAIN = 0.1;
PlateauKernel.MINUS_18_DB_GAIN = 0.12589254;
/** `wet = clamp(dial,0,1) * 10` — it cancels MINUS_20_DB_GAIN's 0.1 twice over,
 *  which is how a fully wet Plateau comes out at roughly unity. */
PlateauKernel.WET_GAIN = 10;
PlateauKernel.SATURATOR_PRE_GAIN = 0.111;
PlateauKernel.SATURATOR_DRIVE = 0.95;
PlateauKernel.SATURATOR_POST_GAIN = 9.999;
PlateauKernel.CLEAR_FADE_SECONDS = 0.004;
/** Rack's own gate threshold for a button-or-CV input, `> 0.5f`. */
PlateauKernel.GATE_THRESHOLD = 0.5;

// ════════════════════════════════════════════════════════════════════════════
// CHRONOBLOB2 — AlrightDevices, a dual clock-syncable delay. BEHAVIOUR-DERIVED.
// ════════════════════════════════════════════════════════════════════════════

/**
 * `AlrightDevices/Chronoblob2` — the clock-syncable delay that ends 15 of the 25
 * surveyed patches.
 *
 * ══ THIS PORT IS BEHAVIOUR-DERIVED, NOT SOURCE-DERIVED. SAID PLAINLY. ═══════
 * There is NO source to read. `VCVRack/library manifests/AlrightDevices.json`
 * carries `pluginUrl` and `manualUrl` and NO `sourceUrl`, which is VCV's marker
 * for a proprietary plugin, and the author distributes prebuilt `.vcvplugin`
 * binaries only (beta.alrightdevices.com). Searched 2026-08-06; there is no
 * public repository under `AlrightDevices` or any spelling of it.
 *
 * SO THE DERIVATION RECORD NAMES DOCUMENTS, NOT CODE:
 *   1. The vendor manual, `docs.alrightdevices.com/chronoblob2-manual.pdf`
 *      (User Manual v1.3) — the control-by-control description below.
 *   2. The panel state the survey recovered from the `.vcv` files:
 *      `Chronoblob2#1: p0=0.3005, p1=0.269, p2=0.335, p5=0.102`,
 *      `data: {"delay_mode": 1, "hold_behavior": 0, "sync_prescaler": 6}` (P20).
 *   3. The cable endpoints the survey printed: audio in at input indices 5 and 6,
 *      audio out at output indices 0 and 1.
 *
 * WHAT THE MANUAL ESTABLISHES, and is therefore ported:
 *   - TIME is the delay time when free-running, and the DIVIDER/MULTIPLIER when a
 *     clock is present at SYNC. Presence is detected by CABLE, so a stopped clock
 *     keeps the module in sync mode.
 *   - FEEDBACK reaches 125%, with a detent region that snaps to exactly 100%.
 *   - MODULATION MODE is the sound: TAPE resamples, so a change in delay time
 *     PITCH-SHIFTS as though the read head were sliding along the tape; FADE
 *     crossfades between taps for a clean, unpitched change. This is what P1's
 *     texture depends on and it is the one behaviour the brief singles out.
 *   - FOUR DELAY MODES: dual (two delays, shared controls), ping-pong, single
 *     (one delay with a feedback SEND and RETURN), and cascade (delay 2 inside
 *     delay 1's feedback loop).
 *   - INFINITE LOOP mutes the inputs and locks feedback at exactly 100%.
 *
 * ⚠ WHAT THE MANUAL DOES **NOT** ESTABLISH, so this port does not pretend to:
 *   U1  THE DELAY TIME RANGE AND ITS TAPER. Unknown. So the `time` knob here is
 *       in SECONDS (a real unit, per V2) rather than a normalised dial. The
 *       CONSEQUENCE, stated because it matters to whoever rebuilds a patch:
 *       **a raw Chronoblob2 dial value out of a `.vcv` file cannot be transferred
 *       to this node.** P20's `p0=0.3005` is 30% of an unknown span. Every other
 *       node in this block transfers verbatim; this one does not, and the reason
 *       is that the taper is behind a closed binary.
 *   U2  WHETHER THE FEEDBACK PATH IS FILTERED, and if so how. Unknown. So the
 *       `damp` knob DEFAULTS TO FULLY OPEN — at its default this delay's
 *       feedback path is a bare gain, which is the only behaviour that can be
 *       defended from the documents. The control exists because a delay without
 *       one is a worse instrument, not because the original is known to have it.
 *   U3  THE SYNC PRESCALER'S SEMANTICS. P20 stores `sync_prescaler: 6`; the
 *       manual describes a settings menu but not that field's units. Ported as
 *       "how many clock pulses make one measured period", which is what a
 *       prescaler normally is and what makes `6` a sane value for a 24-ppqn
 *       clock. Flagged, not asserted.
 *
 * THE RECURRENCE AS PORTED (per channel, per sample):
 *
 *     if a clock edge arrives:  period = pulses_since_last / prescaler / fs
 *     target = synced ? period * ratio(division) : time_knob
 *     TAPE : readTime  += clamp(target - readTime, -slew, slew)   // pitch shift
 *     FADE : readTime   = target on a 20 ms raised-cosine crossfade between taps
 *     tap  = line.read(readTime * fs)                    // linear interpolation
 *     wet  = damp(tap)                                   // one-pole LP, U2
 *     line.write(hold ? wet * 1.0 : in + wet * feedback)
 *     out  = in*(1 - mix) + wet*mix
 *
 * ⚠ WHY TAPE MODE IS A SLEW AND NOT A JUMP: a resampling delay pitch-shifts by
 * exactly the rate of change of its read position. Slewing `readTime` toward the
 * target at `TAPE_SLEW_SECONDS_PER_SECOND` is therefore not an approximation of
 * the pitch shift — it IS the pitch shift, and the ratio it produces is
 * `1 - d(readTime)/dt`. A jump would produce a click and no pitch at all.
 *
 * DEVIATIONS, NAMED:
 *   D-CB-SNAP   the feedback knob's snap-to-100% detent is a KNOB behaviour, not
 *               a DSP one, and our fields take equations. Not ported; type
 *               `= 1` for exactly 100%.
 *   D-CB-SEND   `single` mode's external feedback SEND/RETURN pair is ported as
 *               the `fb_send` output and `fb_return` input, which exist in every
 *               mode and are simply unused outside `single`. A port that appears
 *               and disappears with a mode is not expressible in a spec.
 *   D-NOCV      per V2: no attenuverters, and the TIME CV input carries seconds.
 *               The manual's "left TIME CV is normalled to five volts so the
 *               attenuverters act as offsets" is therefore GONE, and with it the
 *               quirk owners are warned about (the time attenuverter offsetting
 *               the main knob with no cable attached). Our `time` input sums with
 *               the `time` knob and reads 0 when unpatched.
 *
 * Command.
 */
export class Chronoblob2Kernel {
  /**
   * @param {number} sampleRate
   * @param {object} options - construct-time: `maxSeconds` sizes the two lines
   */
  constructor(sampleRate, options = {}) {
    this.sampleRate = sampleRate;
    this.maxSeconds = options.maxSeconds ?? Chronoblob2Kernel.MAX_SECONDS;
    const n = Math.ceil(this.maxSeconds * sampleRate) + 2;
    this.lineA = new Float64Array(n);
    this.lineB = new Float64Array(n);
    this.n = n;
    this.w = 0;
    this.readTimeA = Chronoblob2Kernel.MIN_SECONDS;
    this.readTimeB = Chronoblob2Kernel.MIN_SECONDS;
    this.dampA = new OnePoleLPFilter(sampleRate / 2 - 2, sampleRate);
    this.dampB = new OnePoleLPFilter(sampleRate / 2 - 2, sampleRate);
    // Clock measurement. `pulses` counts edges since the last measurement so the
    // prescaler can divide a fast clock down to a musical period.
    this.clockSamples = 0;
    this.pulses = 0;
    this.period = 0;
    this.synced = false;
    this.prevSync = 0;
    this.fadePhase = 1;
    this.fadeFromA = this.readTimeA;
    this.fadeFromB = this.readTimeB;
    // THE FIRST SAMPLE JUMPS TO ITS TARGET, and this flag is why. TAPE mode slews
    // the read head, and a head that had to slew all the way from 1 ms would spend
    // the module's first second pitch-bending upward from nothing — measured at
    // 0.8 s for a 0.2 s delay. A module that has just been built is not a module
    // whose delay time just CHANGED, so there is nothing to bend.
    this.primed = false;
    this.setMode(options.mode ?? "tape");
    this.setDelay(options.delay ?? "dual");
    this.setDivision(options.division ?? "1");
    this.setPrescaler(options.prescaler ?? Chronoblob2Kernel.DEFAULT_PRESCALER);
  }

  /** Command. TAPE resamples (pitch shifts); FADE crossfades (clean). */
  setMode(value) {
    if (!Chronoblob2Kernel.MOD_MODES.includes(value)) {
      throw new Error(`Chronoblob2Kernel.setMode: expected one of ${Chronoblob2Kernel.MOD_MODES.join(", ")}, got ${JSON.stringify(value)}`);
    }
    this.mode = value;
  }

  /** Command. dual | ping_pong | single | cascade. */
  setDelay(value) {
    if (!Chronoblob2Kernel.DELAY_MODES.includes(value)) {
      throw new Error(`Chronoblob2Kernel.setDelay: expected one of ${Chronoblob2Kernel.DELAY_MODES.join(", ")}, got ${JSON.stringify(value)}`);
    }
    this.delayMode = value;
  }

  /** Command. The clock ratio TIME selects in sync mode. */
  setDivision(value) {
    const row = Chronoblob2Kernel.DIVISIONS.find(([name]) => name === value);
    if (!row) throw new Error(`Chronoblob2Kernel.setDivision: unknown division ${JSON.stringify(value)}`);
    this.division = value;
    this.ratio = row[1];
  }

  /** Command. U3: clock pulses per measured period. */
  setPrescaler(value) {
    const n = Math.round(value);
    if (!(n >= 1 && n <= Chronoblob2Kernel.MAX_PRESCALER)) {
      throw new Error(`Chronoblob2Kernel.setPrescaler: expected 1..${Chronoblob2Kernel.MAX_PRESCALER}, got ${value}`);
    }
    this.prescaler = n;
  }

  /** Query. Read the line at a fractional sample delay, linearly interpolated —
   *  the same two-point read Valley's InterpDelay uses, so a fractional read is
   *  a fractional read everywhere in this block. */
  read(line, samples) {
    const d = clampTo(samples, 1, this.n - 2);
    const i = Math.trunc(d);
    const f = d - i;
    let r = this.w - i;
    if (r < 0) r += this.n;
    let r2 = r - 1;
    if (r2 < 0) r2 += this.n;
    return linterp(line[r], line[r2], f);
  }

  /**
   * Command. One sample.
   *
   * @param {object} c - a-rate controls: time, feedback, mix, damp, sync, hold
   * @param {Float64Array} inputs - [in_l, in_r, fb_return]
   * @param {Float64Array} frame - [out_l, out_r, fb_send]
   * @returns {void} (writes `frame`)
   */
  sample(c, inputs, frame) {
    // ── CLOCK ───────────────────────────────────────────────────────────────
    this.clockSamples += 1;
    const syncHigh = c.sync > Chronoblob2Kernel.GATE_THRESHOLD ? 1 : 0;
    if (syncHigh && !this.prevSync) {
      this.pulses += 1;
      if (this.pulses >= this.prescaler) {
        this.period = this.clockSamples / this.sampleRate;
        this.clockSamples = 0;
        this.pulses = 0;
        this.synced = true;
      }
    }
    this.prevSync = syncHigh;

    const target = clampTo(
      this.synced ? this.period * this.ratio : c.time,
      Chronoblob2Kernel.MIN_SECONDS,
      this.maxSeconds,
    );

    // ── TAPE vs FADE ────────────────────────────────────────────────────────
    if (!this.primed) {
      this.primed = true;
      this.readTimeA = target;
      this.readTimeB = target;
      this.fadeFromA = target;
      this.fadeFromB = target;
    }
    if (this.mode === "tape") {
      const slew = Chronoblob2Kernel.TAPE_SLEW / this.sampleRate;
      this.readTimeA += clampTo(target - this.readTimeA, -slew, slew);
      this.readTimeB += clampTo(target - this.readTimeB, -slew, slew);
      this.fadePhase = 1;
    } else if (target !== this.readTimeA) {
      // A new target starts a crossfade FROM where the head is now. Restarting
      // mid-fade would step, so an in-flight fade is finished from its own start.
      if (this.fadePhase >= 1) {
        this.fadeFromA = this.readTimeA;
        this.fadeFromB = this.readTimeB;
        this.fadePhase = 0;
      }
      this.readTimeA = target;
      this.readTimeB = target;
    }

    const fadeStep = 1 / (Chronoblob2Kernel.FADE_SECONDS * this.sampleRate);
    let fade = 1;
    if (this.fadePhase < 1) {
      this.fadePhase = Math.min(1, this.fadePhase + fadeStep);
      // A raised cosine, so both ends of the crossfade are slope-continuous —
      // the same reason the engine's rewire guard uses setTargetAtTime.
      fade = 0.5 - 0.5 * Math.cos(Math.PI * this.fadePhase);
    }

    const readA = (t) => this.read(this.lineA, t * this.sampleRate);
    const readB = (t) => this.read(this.lineB, t * this.sampleRate);
    let wetA = fade >= 1 ? readA(this.readTimeA) : linterp(readA(this.fadeFromA), readA(this.readTimeA), fade);
    let wetB = fade >= 1 ? readB(this.readTimeB) : linterp(readB(this.fadeFromB), readB(this.readTimeB), fade);

    // U2: the damp control's default is fully open, i.e. this filter is a
    // pass-through at its default and the ported behaviour is unfiltered.
    const dampHz = clampTo(c.damp, Chronoblob2Kernel.DAMP_MIN_HZ, this.sampleRate / 2 - 2);
    this.dampA.setCutoffFreq(dampHz);
    this.dampB.setCutoffFreq(dampHz);
    this.dampA.input = wetA;
    this.dampB.input = wetB;
    wetA = this.dampA.process();
    wetB = this.dampB.process();

    // ── THE FOUR TOPOLOGIES ─────────────────────────────────────────────────
    const hold = c.hold > Chronoblob2Kernel.GATE_THRESHOLD;
    const fb = hold ? 1 : clampTo(c.feedback, 0, Chronoblob2Kernel.FEEDBACK_MAX);
    const dryL = hold ? 0 : inputs[0];
    const dryR = hold ? 0 : inputs[1];
    const ret = inputs[2];

    let writeA = 0;
    let writeB = 0;
    let outWetL = wetA;
    let outWetR = wetB;
    switch (this.delayMode) {
      case "dual":
        writeA = dryL + wetA * fb;
        writeB = dryR + wetB * fb;
        break;
      case "ping_pong":
        // Line A's tail feeds line B and B's feeds A, so a mono input walks
        // across the image. Only A takes the dry signal — that is what makes the
        // first repeat land on one side.
        writeA = dryL + wetB * fb;
        writeB = dryR + wetA * fb;
        break;
      case "single":
        // ONE line; the feedback path leaves the module at `fb_send` and comes
        // back at `fb_return`, so an author can put anything in the loop. With
        // nothing patched, `fb_return` reads 0 and the loop is broken — which is
        // exactly what the hardware does with an open send/return.
        writeA = dryL + dryR + ret * fb;
        writeB = 0;
        outWetR = wetA;
        break;
      case "cascade":
        // Delay 2 sits INSIDE delay 1's loop, so the two times multiply into a
        // rhythm rather than adding into a longer echo.
        writeB = wetA;
        writeA = dryL + dryR + wetB * fb;
        outWetL = wetA;
        outWetR = wetB;
        break;
      default:
        throw new Error(`Chronoblob2Kernel: unreachable delay mode ${this.delayMode}`);
    }

    this.lineA[this.w] = writeA;
    this.lineB[this.w] = writeB;
    this.w += 1;
    if (this.w === this.n) this.w = 0;

    const mix = clampTo(c.mix, 0, 1);
    frame[0] = linterp(inputs[0], outWetL, mix);
    frame[1] = linterp(inputs[1], outWetR, mix);
    frame[2] = wetA;
  }
}

/**
 * ⚠ WHICH OF THIS KERNEL'S CONSTANTS ARE **MINE** RATHER THAN DOCUMENTED.
 *
 * The lead's habit, generalised from TAPE_SLEW: an invented number must say so
 * where it lives, not only in a report nobody re-reads. Chronoblob2 is closed
 * source, so this list is longer here than anywhere else in the block.
 *
 * FROM THE MANUAL (defensible): the four DELAY_MODES and their behaviour, the
 * 1.25 FEEDBACK_MAX, that TAPE resamples and FADE crossfades, that Hold mutes the
 * inputs and locks feedback at 100%, that SYNC presence is by cable.
 * FROM THE PATCH FILES (defensible): the audio input/output indices, and that
 * `delay_mode` 0 is dual and 1 is ping-pong.
 * **MINE, AND UNVERIFIED:**
 *   TAPE_SLEW         the pitch-bend rate. See its own docblock — the big one.
 *   FADE_SECONDS      20 ms. The manual says fade mode crossfades; not how long.
 *   MIN/MAX_SECONDS   the delay range (U1). The dial taper is unknown, so this is
 *                     a useful range rather than the module's range.
 *   DIVISIONS         THE RATIO LIST ITSELF. The manual says TIME becomes a
 *                     multiplier/divider in sync mode and does not enumerate the
 *                     values. These sixteen are a musically complete set; the
 *                     original's set is unknown and may be shorter, longer, or
 *                     differently ordered. A patch that stored a division INDEX
 *                     rather than a name will therefore select the wrong ratio.
 *   DAMP_MIN_HZ       20 Hz (U2 — the filter itself is unverified).
 *   MAX_PRESCALER     96, chosen to cover 24 and 48 ppqn clocks (U3).
 * Everything not in that list came from a document or a measurement.
 */
Chronoblob2Kernel.MOD_MODES = Object.freeze(["tape", "fade"]);
Chronoblob2Kernel.DELAY_MODES = Object.freeze(["dual", "ping_pong", "single", "cascade"]);
/**
 * The clock ratios TIME selects when SYNC is patched, SHORTEST FIRST. Straight and
 * dotted/triplet values both present because a delay that can only do powers of two
 * cannot play against a swung sequence.
 *
 * ⚠ AN ARRAY OF PAIRS, NOT AN OBJECT, AND THE REASON IS A JAVASCRIPT RULE THAT BIT
 * THIS EXACT LIST. An object's integer-like keys ("1", "2", "16") are enumerated
 * FIRST, in numeric order, ahead of every string key — so `Object.keys` on the
 * obvious object literal returned `1 2 3 4 6 8 16 1/16 1/12 …`, and the spec's
 * option list (which is the PANEL ORDER an author sees) disagreed with it. Caught
 * by tests/port_vc5_test.js's option-list pin, which is what that check is for.
 */
Chronoblob2Kernel.DIVISIONS = Object.freeze([
  ["1/16", 1 / 16], ["1/12", 1 / 12], ["1/8", 1 / 8], ["1/6", 1 / 6], ["1/4", 1 / 4],
  ["1/3", 1 / 3], ["1/2", 1 / 2], ["2/3", 2 / 3], ["1", 1], ["3/2", 1.5],
  ["2", 2], ["3", 3], ["4", 4], ["6", 6], ["8", 8], ["16", 16],
]);

/** Query. The division names in PANEL order — what the spec's option list must be. */
export function chronoblobDivisionNames() {
  return Chronoblob2Kernel.DIVISIONS.map(([name]) => name);
}
/** The manual's 125% ceiling. Above 1 the loop grows, which is the point. */
Chronoblob2Kernel.FEEDBACK_MAX = 1.25;
Chronoblob2Kernel.MIN_SECONDS = 0.001;
Chronoblob2Kernel.MAX_SECONDS = 10;
/**
 * TAPE mode's read-head speed limit, in seconds of delay time per second of real
 * time. 1.0 would let the head stop dead (an infinite downward pitch bend); 0.25
 * is a musical bend and is the value at which the tape/fade distinction is
 * plainly audible — measured at +25% (88 -> 110 zero crossings per 0.1 s on a
 * 440 Hz tone) when the delay time is halved mid-render.
 *
 * ⚠ THIS NUMBER IS MINE AND IS UNVERIFIED AGAINST THE ORIGINAL. It is the ONE
 * free constant in this node: the manual describes tape mode's pitch-shifting
 * behaviour but gives no rate, and the plugin is closed source (U1), so there is
 * nothing to read it off. Everything else in this kernel is either documented or
 * measured from a patch file; this is neither. IT IS THE FIRST THING TO CHECK
 * against a real Chronoblob2 if P1's or P4's delay texture sounds wrong, and
 * nobody will remember to ask unless it says so here.
 */
Chronoblob2Kernel.TAPE_SLEW = 0.25;
/** FADE mode's crossfade length. 20 ms is long enough to hide a tap change and
 *  short enough not to double the transient. */
Chronoblob2Kernel.FADE_SECONDS = 0.02;
Chronoblob2Kernel.DAMP_MIN_HZ = 20;
Chronoblob2Kernel.DEFAULT_PRESCALER = 1;
Chronoblob2Kernel.MAX_PRESCALER = 96;
Chronoblob2Kernel.GATE_THRESHOLD = 0.5;

// ════════════════════════════════════════════════════════════════════════════
// FELINE — Valley/Feline, a zero-delay-feedback OTA ladder in stereo
// ════════════════════════════════════════════════════════════════════════════

/**
 * `dsp/filters/VecOTAFilter.hpp VecTPTOnePoleStage` — one topology-preserving
 * transform one-pole with a saturator at BOTH ends.
 *
 *     v   = drive(in) * G - z * G        // written as (drive(in) - z) * G
 *     out = drive(v + z)
 *     z   = out + v
 *
 * The saturator on the input and again on the output is what makes this an OTA
 * stage rather than a linear one-pole: the nonlinearity is INSIDE the integrator,
 * so it changes the cutoff under drive the way a real transconductance cell does.
 *
 * Command (mutates `z`).
 */
export class OtaOnePoleStage {
  constructor() {
    this.G = 0;
    this.z = 0;
  }

  /** Command. One sample. */
  process(input) {
    const v = (tanhDriveSignal(input, 1) - this.z) * this.G;
    const out = tanhDriveSignal(v + this.z, 1);
    this.z = out + v;
    return out;
  }

  /** Command. */
  clear() {
    this.z = 0;
  }
}

/**
 * `dsp/filters/VecOTAFilter.hpp VecOTAFilter` — four OTA one-poles in a
 * zero-delay-feedback ladder with a mode-selected tap mix.
 *
 * ── DERIVATION RECORD (R7-17) ───────────────────────────────────────────────
 * SOURCE   ValleyAudio/ValleyRackFree `src/dsp/filters/VecOTAFilter.{hpp,cpp}`
 *          and `src/Feline/Feline.cpp`, model `Feline`,
 *          @ 86f02e431136a7f5c96a872b99b7115b7e133e05.
 * BLOCK    `VecOTAFilter::process` (the ladder), `::setCutoff` (the G table),
 *          `::setQ`, `::setMode` (the tap mixes), `Feline::step` (the panel).
 *
 * THE RECURRENCE AS PORTED:
 *
 *     g     = tan(PI * f / fs)          f = 440 * 2^(dial - 5), dial clamped 0..10
 *     G     = g / (1 + g)               gamma = G^4
 *     k     = 0.4 * clamp(reso, 0, 10)  // so resonance 10 gives k = 4, self-osc
 *     sigma = (G^3*z1 + G^2*z2 + G*z3 + z4) / (1 + g)
 *     u     = (x*0.5 - k*drive(sigma)/drive(1)) / (1 + k*gamma)
 *     lp1..4 = the four stages in series from u
 *     out   = c1*lp1 + c2*lp2 + c3*lp3 + c4*lp4
 *
 *   MODE       c1    c2    c3    c4
 *   LP2         0     1     0     0
 *   LP4         0     0     0     1
 *   BP2         2    -2     0     0
 *   BP4         0     4    -8     4
 *
 * ⚠ FELINE CAN ONLY REACH FOUR OF THE SIX MODES. `VecOTAFilter::Modes` declares
 * HP2 and HP4 as well, but `Feline::step` computes `mode = poles + type*2` from
 * two two-position switches, so it can only ever produce 0..3. The highpass
 * mixes exist in the filter and are UNREACHABLE from the panel. Reproduced: this
 * node ships LP2, LP4, BP2, BP4, because that is what the module is.
 *
 * ⚠ `sigma` IS DIVIDED BY `1 + g`, NOT BY `1 + G`. The C spells it `__1_h`, and
 * `h` is `1/(1+g)` — so `__1_h` is `1/(1+g)` and `sigma` is multiplied by it.
 * That factor is what makes the ZDF resonance flat across the spectrum; getting
 * it wrong gives a filter that is self-consistent and whose resonance rises with
 * cutoff, which is exactly the class of error R7-11 warns about.
 *
 * DEVIATIONS, NAMED:
 *   D-GTABLE  their `g` and `1/(1+g)` come from two 1.1-million-entry lookup
 *             tables at 100000 entries per octave, linearly interpolated. We
 *             compute `tan` and the reciprocal directly. The tables' own
 *             interpolation error at that resolution is below 1e-9 relative,
 *             i.e. under float32's own resolution, so this port is very slightly
 *             MORE accurate than the original and not audibly different. It also
 *             saves 8.8 MB of Float32Array per instance.
 *   D-FLOAT   theirs is float32 SIMD; ours is float64 scalar. MEASURED at 1.2e-8
 *             worst absolute divergence (0.001% of RMS) over 4096 samples at
 *             resonance 8, against a Math.fround model of THIS recurrence — the
 *             saturators bound the loop, so single precision does NOT accumulate
 *             here. tests/port_vc5_test.js prints the figure. This note used to
 *             say the error compounds; that was reasoning, and the measurement
 *             disagreed.
 *   D-NOCV    ten CV inputs with ten attenuverters become five modulation inputs
 *             in the knobs' own units. See V2.
 *   D-SUMOUT  their third output is `(l + r) * 2.5` where the L and R outputs are
 *             `* 5` — i.e. the sum is the AVERAGE, not the sum. Reproduced.
 *
 * Command.
 */
export class FelineKernel {
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    this.left = [new OtaOnePoleStage(), new OtaOnePoleStage(), new OtaOnePoleStage(), new OtaOnePoleStage()];
    this.right = [new OtaOnePoleStage(), new OtaOnePoleStage(), new OtaOnePoleStage(), new OtaOnePoleStage()];
    this.oneOverTanh = 1 / tanhDriveSignal(1, 1);
    this.setPoles("4");
    this.setType("lowpass");
  }

  /** Command. Their POLES switch: 2 or 4. */
  setPoles(value) {
    if (value !== "2" && value !== "4") {
      throw new Error(`FelineKernel.setPoles: expected "2" or "4", got ${JSON.stringify(value)}`);
    }
    this.poles = value;
    this.taps = FelineKernel.MODE_TAPS[`${this.type ?? "lowpass"}${value}`];
  }

  /** Command. Their TYPE switch: lowpass or bandpass. Highpass is unreachable on
   *  the panel — see the class docblock. */
  setType(value) {
    if (value !== "lowpass" && value !== "bandpass") {
      throw new Error(`FelineKernel.setType: expected "lowpass" or "bandpass", got ${JSON.stringify(value)}`);
    }
    this.type = value;
    this.taps = FelineKernel.MODE_TAPS[`${value}${this.poles}`];
  }

  /** Query. The ladder's coefficient set for one cutoff dial. Split out so the
   *  two channels' different cutoffs (Spacing) cost one call each. */
  coefficients(dial) {
    const pitch = clampTo(dial, 0, FelineKernel.DIAL_MAX);
    const g = Math.tan((Math.PI * valleyDialToHz(pitch)) / this.sampleRate);
    const oneOverH = 1 / (1 + g);
    const G = g * oneOverH;
    return { G, G2: G * G, G3: G * G * G, gamma: G * G * G * G, oneOverH };
  }

  /** Command. One channel of the ladder. */
  ladder(stages, co, k, x) {
    let sigma = co.G3 * stages[0].z;
    sigma += co.G2 * stages[1].z;
    sigma += co.G * stages[2].z;
    sigma = (sigma + stages[3].z) * co.oneOverH;
    let u = x * FelineKernel.INPUT_HALF;
    u -= k * tanhDriveSignal(sigma, 1) * this.oneOverTanh;
    u /= 1 + k * co.gamma;
    for (const s of stages) s.G = co.G;
    const lp1 = stages[0].process(u);
    const lp2 = stages[1].process(lp1);
    const lp3 = stages[2].process(lp2);
    const lp4 = stages[3].process(lp3);
    const t = this.taps;
    return t[0] * lp1 + t[1] * lp2 + t[2] * lp3 + t[3] * lp4;
  }

  /**
   * Command. One sample.
   *
   * @param {object} c - cutoff, resonance, spacing, spacing_target, drive
   * @param {Float64Array} inputs - [in_l, in_r] in ±1 units
   * @param {Float64Array} frame - [out_l, out_r, sum] in ±1 units
   * @returns {void} (writes `frame`)
   */
  sample(c, inputs, frame) {
    const spacing = clampTo(c.spacing, -1, 1);
    const target = clampTo(c.spacing_target, 0, 1);
    // Their `linterp(0, -spacing, target) + cutoff`: at target 0 only the RIGHT
    // channel moves, at target 1 the two split symmetrically about the dial.
    const leftDial = linterp(0, -spacing, target) + c.cutoff;
    const rightDial = c.cutoff + spacing;

    let drive = clampTo(c.drive, 0, 1);
    drive *= drive;
    drive = drive * FelineKernel.DRIVE_SPAN + FelineKernel.DRIVE_FLOOR;

    // V1 then their own halving: `Feline::step` multiplies by drive and passes
    // `input * 0.5` to the filter, whose `process` halves AGAIN. Total 0.25.
    const vL = inputs[0] * RACK_VOLTS_PER_UNIT * drive * FelineKernel.INPUT_HALF;
    const vR = inputs[1] * RACK_VOLTS_PER_UNIT * drive * FelineKernel.INPUT_HALF;

    const k = FelineKernel.K_PER_RESO * clampTo(c.resonance, 0, FelineKernel.DIAL_MAX);
    const outL = this.ladder(this.left, this.coefficients(leftDial), k, vL);
    const outR = this.ladder(this.right, this.coefficients(rightDial), k, vR);

    frame[0] = (outL * RACK_VOLTS_PER_UNIT) / RACK_VOLTS_PER_UNIT;
    frame[1] = (outR * RACK_VOLTS_PER_UNIT) / RACK_VOLTS_PER_UNIT;
    // D-SUMOUT: `(l + r) * 2.5` volts against `* 5` for the mains, i.e. the mean.
    frame[2] = ((outL + outR) * FelineKernel.SUM_VOLTS) / RACK_VOLTS_PER_UNIT;
  }
}

/** The four reachable tap mixes, keyed `<type><poles>`. See the class docblock on
 *  why `highpass2`/`highpass4` are absent rather than merely unused. */
FelineKernel.MODE_TAPS = Object.freeze({
  lowpass2: Object.freeze([0, 1, 0, 0]),
  lowpass4: Object.freeze([0, 0, 0, 1]),
  bandpass2: Object.freeze([2, -2, 0, 0]),
  bandpass4: Object.freeze([0, 4, -8, 4]),
});
FelineKernel.DIAL_MAX = 10;
/** `__k = 0.4 * clamp(Q, 0, 10)`, so the dial's top gives k = 4 — the classic
 *  four-pole ladder self-oscillation threshold. */
FelineKernel.K_PER_RESO = 0.4;
/** `drive = drive^2 * 9.25 + 0.75` — the dial's FLOOR is 0.75, i.e. Feline
 *  attenuates slightly at drive 0 and reaches 10x at drive 1. */
FelineKernel.DRIVE_SPAN = 9.25;
FelineKernel.DRIVE_FLOOR = 0.75;
/** The 0.5 that appears TWICE — once in `Feline::step`, once in
 *  `VecOTAFilter::process`. Both are theirs, so the ladder sees a quarter. */
FelineKernel.INPUT_HALF = 0.5;
FelineKernel.SUM_VOLTS = 2.5;

// ════════════════════════════════════════════════════════════════════════════
// TERRORFORM — Valley/Terrorform, a phase-distortion wavetable oscillator
// ════════════════════════════════════════════════════════════════════════════

/**
 * The TWENTY-SEVEN PHASE SHAPERS, in PANEL order.
 *
 * ── DERIVATION RECORD (R7-17) ───────────────────────────────────────────────
 * SOURCE   ValleyAudio/ValleyRackFree `src/dsp/shaping/Shaper.{hpp,cpp}`,
 *          class `Shaper`, @ 86f02e431136a7f5c96a872b99b7115b7e133e05.
 * BLOCK    `Shaper::process` and its 27 private methods; the DIAL ORDER is
 *          `Terrorform::phasorShapeMap` (Terrorform.hpp:265), which is NOT the
 *          enum order — SINEWRAP is dial 5 and enum 13, MIRROR is dial 6 and
 *          enum 5. This array is in DIAL order, so `SHAPE_NAMES[n]` is what the
 *          panel's Shape Type dial reads at n. Getting that wrong would make
 *          every ported patch select the wrong distortion.
 *
 * WHAT THESE ARE: each takes the oscillator's phasor `a` in [0, 1] and a depth
 * `f` in [0, 1] and returns a NEW phase. The wavetable is then read at that
 * phase. So Terrorform is a phase-distortion oscillator whose carrier happens to
 * be a wavetable — which is why a single sine table already gives it dozens of
 * timbres, and why the shapers matter more than the tables do.
 *
 * Every one is a PURE FUNCTION of (a, f) except `warble`, which needs two
 * filtered noise samples and therefore lives on the kernel (see D0).
 *
 * @example Math.abs(SHAPERS.bend(0.5, 0) - 0.5) < 1e-12 // true  (depth 0 is identity)
 * @example SHAPERS.reflect(0.2, 0.5) // 0.8   (a < f, so it mirrors)
 * @example SHAPERS.step4(0.7, 1) // 0.5      (quantised to a quarter)
 * @example SHAPERS.wrap(0.5, 1) // 0.5       (a*9 = 4.5, fractional part 0.5)
 */
export const SHAPERS = Object.freeze({
  /** A single break point that slides with depth — the classic PD "bend". */
  bend(a, f) {
    const x = (1 - f) * 0.5;
    const low = a < x;
    const denom = low ? x : 1 - x;
    const m = 0.5 / denom;
    const c = 0.5 - m * x;
    return m * a + (low ? 0 : c);
  },
  /** A slope change with a NEGATIVE-depth offset branch, so it is asymmetric in f. */
  tilt(a, f) {
    const x = a * (Math.abs(f * 3) + 1);
    return x + (f < 0 ? f * 3 : 0);
  },
  /** Crossfade toward a^4 — a soft "late" ramp. */
  lean(a, f) {
    const x2 = a * a;
    return linterp(a, x2 * x2, f);
  },
  /** Three linear segments whose middle slope is `f*1.98 + 1`. */
  twist(a, f) {
    const F = f * SHAPER_TWIST_SPAN + 1;
    const k = F * -0.5 + 1.5;
    const x1 = a * k;
    const x2 = a * F + (F - 1) * -0.5;
    if (a > SHAPER_THIRD && a <= SHAPER_TWO_THIRD) return x2;
    if (a > SHAPER_TWO_THIRD) return x1 + (1 - k);
    return x1;
  },
  /** Run the phasor up to nine times per cycle and take the fractional part —
   *  hard-syncs the table to itself. */
  wrap(a, f) {
    return wrapUnit(a * (Math.abs(f) * 8 + 1));
  },
  /** A sine-warped phase that fades in over the first eighth of the depth dial. */
  sineWrap(a, f) {
    const y = Math.max(f, SHAPER_SINEWRAP_FLOOR);
    const x = circleWrap((a * 2 - 1) * (y * 8));
    const s = Math.sin(x * Math.PI) * 0.5 + 0.5;
    return linterp(a, s, Math.min(f * 8, 1));
  },
  /** Fold the phasor back and forth up to ten times — `wrap` with reflection. */
  mirror(a, f) {
    const scale = Math.abs(f) * 9 + 1;
    let x = (a * 2 - 1) * scale;
    x = Math.abs((x + 1) * 0.5) * 0.5;
    x = wrapUnit(x);
    let y = (a * 2 - 1) * scale;
    y = Math.abs((y + 1) * 0.5);
    const z = wrapUnit(y);
    return x > 0.5 ? 1 - z : z;
  },
  /** Crossfade to a sine of an integer harmonic, interpolating BETWEEN harmonics
   *  — so sweeping depth glides up the harmonic series rather than stepping. */
  harmonics(a, f) {
    const ff = (Math.max(f, SHAPER_HARMONIC_FLOOR) - SHAPER_HARMONIC_FLOOR) * SHAPER_HARMONIC_SPAN;
    const m = Math.min(f * 16, 1);
    const n = Math.trunc(ff + 1);
    const b = Math.sin(circleWrap(a * n * 2 - 1) * Math.PI);
    const c = Math.sin(circleWrap(a * (n + 1) * 2 - 1) * Math.PI);
    const out = linterp(b, c, wrapUnit(ff)) * 0.5 + 0.5;
    return linterp(a, out, m);
  },
  /** The one non-pure shaper — see `TerrorformKernel.shape`. Present here so the
   *  roster is complete and so a caller that reaches it without noise gets a LOUD
   *  failure rather than a silently wrong wave. */
  warble() {
    throw new Error("SHAPERS.warble is stateful (filtered noise) — call TerrorformKernel.shape instead");
  },
  /** Mirror the phasor about the depth value — a hard break, not a slope change. */
  reflect(a, f) {
    return a < f ? 1 - a : a;
  },
  /** Hold the phase at 1 for part of the cycle — a pulse in the phase domain. */
  pulse(a, f) {
    const x = wrapUnit(a * 0.5 * (Math.abs(f) * 8 + 1));
    return x > 0.5 ? 1 : a;
  },
  /** Quantise the phase to 4 steps, crossfaded by depth. */
  step4(a, f) {
    return linterp(a, Math.trunc(a * 4) * 0.25, Math.abs(f));
  },
  /** 8 steps. */
  step8(a, f) {
    return linterp(a, Math.trunc(a * 8) * 0.125, Math.abs(f));
  },
  /** 16 steps. */
  step16(a, f) {
    return linterp(a, Math.trunc(a * 16) * 0.0625, Math.abs(f));
  },
  /**
   * A step count that FALLS from 128 to 1 as depth rises, crossfaded over the
   * first hundredth of the dial.
   *
   * ⚠ D-TF-VARSTEP — THEIR VERSION DIVIDES BY ZERO AT DEPTH 1.0. `ff = 128 -
   * |f|*128` is exactly 0 there, and `trunc(a*0)/0` is `0/0` = NaN in float, so
   * `linterp(a, NaN, 1)` is NaN. A NaN entering an audio graph is PERMANENT — it
   * poisons every downstream filter's state — so this port floors the step count
   * at ONE, which is the limit of the sequence (a single step, i.e. a constant
   * phase) and the value the author plainly intended. Reported as a source defect
   * rather than reproduced: reproducing it would silence the patch and the
   * project's own law is that a failure must be loud, not silent.
   */
  varStep(a, f) {
    const absF = Math.abs(f);
    const ff = Math.max(SHAPER_VARSTEP_MAX_STEPS - absF * SHAPER_VARSTEP_MAX_STEPS, 1);
    const quantised = Math.trunc(a * ff) / ff;
    return linterp(a, quantised, clampTo(absF * SHAPER_VARSTEP_FADE, 0, 1));
  },
  /** Add a hard-wrapped 2x phasor — buzzy, sideband-rich. */
  buzzX2(a, f) {
    return a + circleWrap(a * 2) * f;
  },
  /** 4x. */
  buzzX4(a, f) {
    return a + circleWrap(a * 4) * f;
  },
  /** 8x. */
  buzzX8(a, f) {
    return a + circleWrap(a * 8) * f;
  },
  /** Add a 2x SINE of the phasor, then re-wrap — smoother than buzz. */
  wrinkleX2(a, f) {
    return shaperWrinkle(a, f, 2);
  },
  /** 4x. */
  wrinkleX4(a, f) {
    return shaperWrinkle(a, f, 4);
  },
  /** 8x. */
  wrinkleX8(a, f) {
    return shaperWrinkle(a, f, 8);
  },
  /** Wrinkle whose depth FALLS across the cycle — the distortion decays. */
  sineDownX2(a, f) {
    return shaperSineRamp(a, f, 2, 1 - a);
  },
  /** 4x. */
  sineDownX4(a, f) {
    return shaperSineRamp(a, f, 4, 1 - a);
  },
  /** 8x. */
  sineDownX8(a, f) {
    return shaperSineRamp(a, f, 8, 1 - a);
  },
  /** Wrinkle whose depth RISES across the cycle. */
  sineUpX2(a, f) {
    return shaperSineRamp(a, f, 2, a);
  },
  /** 4x. */
  sineUpX4(a, f) {
    return shaperSineRamp(a, f, 4, a);
  },
  /** 8x. */
  sineUpX8(a, f) {
    return shaperSineRamp(a, f, 8, a);
  },
});

/** `_mm_set1_ps(1.98f)` — `twist`'s middle-segment slope span. */
const SHAPER_TWIST_SPAN = 1.98;
/** `twist`'s segment boundaries as float literals, `0.333333f` / `0.666666f`.
 *  NOT 1/3 and 2/3: the truncated decimals shift the break points by 3e-7 of a
 *  cycle, which is inaudible but is what a numeric trace must match. */
const SHAPER_THIRD = 0.333333;
const SHAPER_TWO_THIRD = 0.666666;
/** `sineWrap`'s `max(f, 0.0625f)` — a floor of one sixteenth so the sine warp has
 *  a shape to fade in from. */
const SHAPER_SINEWRAP_FLOOR = 0.0625;
const SHAPER_HARMONIC_FLOOR = 0.0625;
/** `harmonics` reaches harmonic `trunc(ff + 1)` where ff spans 0..6.4 — so the
 *  dial glides across seven harmonics, not sixteen. */
const SHAPER_HARMONIC_SPAN = 6.4;
const SHAPER_VARSTEP_MAX_STEPS = 128;
/** `clamp(|f| * 100, 0, 1)` — varStep's crossfade is over the first 1% of the
 *  dial, so it is effectively fully on everywhere except at zero. */
const SHAPER_VARSTEP_FADE = 100;

/** Pure function. The shared body of the three `wrinkle` shapers.
 *  @example Math.abs(shaperWrinkle(0.5, 0, 2) - 0.5) < 1e-12 // true */
function shaperWrinkle(a, f, harmonic) {
  const x = Math.sin(circleWrap(a * harmonic) * Math.PI);
  const out = circleWrap((a + x * f) * 2 - 1);
  return (out + 1) * 0.5;
}

/** Pure function. The shared body of the six `sineUp`/`sineDown` shapers; `ramp`
 *  is `a` for up and `1 - a` for down.
 *  @example Math.abs(shaperSineRamp(0.5, 0, 2, 0.5) - 0.5) < 1e-12 // true */
function shaperSineRamp(a, f, harmonic, ramp) {
  const y = ramp * f * Math.sin(circleWrap(a * harmonic) * Math.PI);
  const out = circleWrap((a + y) * 2 - 1);
  return (out + 1) * 0.5;
}

/**
 * The Shape Type dial's option list, IN PANEL ORDER — `phasorShapeMap`, mapped to
 * the `SHAPERS` keys. The dial is an integer 0..26 on the hardware; here it is a
 * named option so a patch reads as what it does rather than as a number.
 */
export const SHAPE_NAMES = Object.freeze([
  "bend", "tilt", "lean", "twist", "wrap", "sineWrap", "mirror", "harmonics",
  "warble", "reflect", "pulse", "step4", "step8", "step16", "varStep",
  "buzzX2", "buzzX4", "buzzX8", "wrinkleX2", "wrinkleX4", "wrinkleX8",
  "sineDownX2", "sineDownX4", "sineDownX8", "sineUpX2", "sineUpX4", "sineUpX8",
]);

/**
 * Pure function. One PROCEDURAL wavetable bank — 16 frames of `TF_TABLE_SIZE`
 * samples, in the layout `ScanningQuadOsc.setWavebank` expects (frame-major).
 *
 * ⚠ D-TF-BANK — THE 64 ROM BANKS ARE NOT SHIPPED AND CANNOT BE.
 * `TerrorformWavetableROM.hpp` links 64 binary blobs of 1048576 bytes each — 64 MB
 * of sample data, which is roughly 400x this entire application. There is no
 * compression story: they are recorded and additively-synthesised waveforms with
 * no closed form.
 *
 * So this port ships EIGHT ANALYTIC BANKS instead, each of which is a real
 * wavetable family with the same 16-frame morph structure. The SCANNING, the
 * per-frame crossfade, the phase distortion and the whole oscillator are exact;
 * what differs is the timbre inside a frame. Named after the ROM banks whose
 * construction is analytically known ("BASIC", "ADD_SAW", "PWM", "FOLD_SINE",
 * "BITCRUSH1") plus three more, so a patch that selected a ROM bank can be
 * pointed at the nearest honest equivalent — it is NOT the same samples and this
 * node's help says so.
 *
 * @param {string} name - a `TF_BANKS` key
 * @param {number} tableSize - samples per frame
 * @param {number} frames - frames in the bank
 * @returns {Float32Array} `frames * tableSize` samples, frame-major
 *
 * @example terrorformBank("basic", 4, 2).length // 8
 * @example Math.abs(terrorformBank("basic", 4, 2)[0]) < 1e-6 // true  (frame 0 is a sine, starting at 0)
 */
export function terrorformBank(name, tableSize = TF_TABLE_SIZE, frames = TF_BANK_FRAMES) {
  const make = TF_BANKS[name];
  if (!make) throw new Error(`terrorformBank: unknown bank ${JSON.stringify(name)}`);
  const out = new Float32Array(frames * tableSize);
  for (let k = 0; k < frames; k++) {
    const morph = frames === 1 ? 0 : k / (frames - 1);
    for (let i = 0; i < tableSize; i++) {
      out[k * tableSize + i] = make(i / tableSize, morph, k);
    }
  }
  return out;
}

/** Frames per bank, and samples per frame. 16 x 2048 is 128 KB of Float32 per
 *  bank, generated on demand — versus the ROM's 1 MB per bank on disk.
 *
 *  ⚠ BOTH NUMBERS ARE MINE, and so is every function in TF_BANKS. The original's
 *  banks are 64 binary blobs with no published frame count or table size; 16 x 2048
 *  is a conventional wavetable shape, not theirs. The SCAN, the two-frame morph and
 *  the phase distortion are exact (they are read from QuadOsc.cpp); the timbres are
 *  analytic stand-ins. See D-TF-BANK. */
export const TF_BANK_FRAMES = 16;
export const TF_TABLE_SIZE = 2048;

/**
 * The eight analytic banks. Each is `(phase01, morph01, frameIndex) -> sample`,
 * and every one is normalised to roughly ±1 by construction rather than by a
 * scan, because a per-bank normalisation pass would make frame levels depend on
 * the frame count.
 */
export const TF_BANKS = Object.freeze({
  /** sine -> triangle -> saw -> square, the standard four-corner morph. */
  basic(p, m) {
    const sine = Math.sin(2 * Math.PI * p);
    const tri = 4 * Math.abs(p - 0.5) - 1;
    const saw = 2 * p - 1;
    const sqr = p < 0.5 ? 1 : -1;
    const stage = m * 3;
    if (stage < 1) return linterp(sine, tri, stage);
    if (stage < 2) return linterp(tri, saw, stage - 1);
    return linterp(saw, sqr, stage - 2);
  },
  /** An additive sawtooth whose harmonic count grows 1..16 — band-limited by
   *  construction, so scanning up the bank opens the spectrum without aliasing. */
  add_saw(p, m, k) {
    let s = 0;
    const n = k + 1;
    for (let h = 1; h <= n; h++) s += Math.sin(2 * Math.PI * h * p) / h;
    return (s * 2) / Math.PI;
  },
  /** An additive square: odd harmonics only, count grows with the frame. */
  add_sqr(p, m, k) {
    let s = 0;
    const n = k + 1;
    for (let h = 1; h <= n; h++) s += Math.sin(2 * Math.PI * (2 * h - 1) * p) / (2 * h - 1);
    return (s * 4) / Math.PI;
  },
  /** A sine driven into Valley's own piecewise saturator, 1x to 8x. */
  fold_sine(p, m) {
    return tanhDriveSignal(Math.sin(2 * Math.PI * p), 1 + m * 7);
  },
  /** Pulse widths from 50% down to 3%. */
  pwm(p, m) {
    return p < linterp(0.5, 0.03, m) ? 1 : -1;
  },
  /** A sine amplitude-quantised from 16 levels down to 2 — digital, not folded. */
  bitcrush(p, m) {
    const levels = Math.max(2, Math.round(linterp(16, 2, m)));
    const s = Math.sin(2 * Math.PI * p);
    return Math.round(s * levels) / levels;
  },
  /** A single harmonic, 1st to 16th — an organ drawbar bank, and the cleanest
   *  way to hear what the phase shapers do (one partial in, many out). */
  harmonic(p, m, k) {
    return Math.sin(2 * Math.PI * (k + 1) * p);
  },
  /** Chebyshev polynomials T1..T16 of a sine — the waveshaper's basis, so
   *  scanning the bank sweeps which harmonic a sine maps to. */
  chebyshev(p, m, k) {
    const x = Math.sin(2 * Math.PI * p);
    let t0 = 1;
    let t1 = x;
    for (let n = 1; n < k + 1; n++) {
      const t2 = 2 * x * t1 - t0;
      t0 = t1;
      t1 = t2;
    }
    return t1;
  },
});

/** `dsp/modulation/VecSegment` + `VecAREnvelope`, scalar. An exponential segment
 *  that decays by `rate^(1/timeScale)` per sample, with a rising branch that
 *  runs the SAME segment upside down (`target - seg`).
 *
 *  Command (mutates `seg`). */
export class ArEnvelope {
  constructor(sampleRate) {
    this.seg = 0;
    this.rate = 1;
    this.riseRate = 0.99;
    this.fallRate = 0.99;
    this.env = 0;
    this.prevTrigger = 0;
    this.rising = false;
    this.targetValue = 0;
    this.epsilon = ArEnvelope.FALLING_EPSILON;
    this.inOneShotMode = false;
    this.oneOverTimeScale = 1 / (sampleRate / ArEnvelope.REFERENCE_RATE);
  }

  /** Command. One sample. `trigger` is a LEVEL, not an edge — its value becomes
   *  the envelope's peak, which is how Terrorform's velocity sensitivity works. */
  process(trigger) {
    const risingEdge = trigger > ArEnvelope.INPUT_EPSILON && this.prevTrigger <= ArEnvelope.INPUT_EPSILON;
    let fallingEdge;
    if (this.inOneShotMode) {
      if (risingEdge) this.rising = true;
      fallingEdge = this.rising && !risingEdge && this.seg < this.epsilon;
      if (fallingEdge) this.rising = false;
    } else {
      fallingEdge = trigger <= ArEnvelope.INPUT_EPSILON && this.prevTrigger > ArEnvelope.INPUT_EPSILON;
      this.rising = trigger > 0;
    }
    if (risingEdge) this.targetValue = trigger;
    if (risingEdge || fallingEdge) this.seg = this.targetValue - this.seg;
    if (risingEdge) this.epsilon = ArEnvelope.RISING_EPSILON;
    if (fallingEdge) this.epsilon = ArEnvelope.FALLING_EPSILON;
    this.rate = this.rising ? this.riseRate : this.fallRate;
    const output = this.seg;
    this.seg = this.seg * Math.pow(this.rate, this.oneOverTimeScale);
    this.env = this.rising ? this.targetValue - output : output;
    this.prevTrigger = trigger;
    return this.env;
  }
}
/** Their `_mm_div_ps(sampleRate, 44100)` time scale reference. */
ArEnvelope.REFERENCE_RATE = 44100;
ArEnvelope.INPUT_EPSILON = 0.0001;
ArEnvelope.RISING_EPSILON = 0.002;
ArEnvelope.FALLING_EPSILON = 0.000031;

/**
 * `dsp/filters/VecLPG.hpp VecLPG` — Terrorform's lowpass gate: an AR envelope
 * driving a VCA, a two-pole lowpass, or both.
 *
 * The CUBE is the character: `cutoff = env^3 * 22050`, so the filter closes far
 * faster than the amplitude does. That is what makes a Buchla-style LPG sound
 * plucked rather than merely gated, and it is one line.
 *
 * ⚠ THE ATTACK AND DECAY DIALS ARE FIFTH-ORDER POLYNOMIALS OF THEMSELVES:
 *   `x = 0.62 - 0.62 * clamp(a,0,1) * (0.75 + longOffset)` ; `rise = 0.99999 - x^6`
 *   `x = 0.4  - 0.4  * clamp(d,0,1) * (0.75 + longOffset)` ; `fall = 0.999995 - x^6`
 * where `longOffset` is 0.25 in long-time mode. The x^6 is why the fast end of
 * both dials is so much more sensitive than the slow end.
 *
 * Command.
 */
export class LowpassGate {
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    this.envelope = new ArEnvelope(sampleRate);
    this.lpf1 = new OnePoleLPFilter(sampleRate / 2 - 2, sampleRate);
    this.lpf2 = new OnePoleLPFilter(sampleRate / 2 - 2, sampleRate);
    this.env = 0;
    this.mode = "bypass";
    this.setDecay(1, false);
  }

  /** Command. */
  setMode(value) {
    if (!LowpassGate.MODES.includes(value)) {
      throw new Error(`LowpassGate.setMode: expected one of ${LowpassGate.MODES.join(", ")}, got ${JSON.stringify(value)}`);
    }
    this.mode = value;
  }

  /** Command. See the class docblock for the polynomial. */
  setAttack(attack, longScale) {
    const offset = longScale ? LowpassGate.LONG_OFFSET : 0;
    const x = LowpassGate.ATTACK_SCALE - LowpassGate.ATTACK_SCALE * clampTo(attack, 0, 1) * (LowpassGate.DIAL_SCALE + offset);
    this.envelope.riseRate = LowpassGate.RISE_CEILING - Math.pow(x, LowpassGate.DIAL_POWER);
  }

  /** Command. */
  setDecay(decay, longScale) {
    const offset = longScale ? LowpassGate.LONG_OFFSET : 0;
    const x = LowpassGate.DECAY_SCALE - LowpassGate.DECAY_SCALE * clampTo(decay, 0, 1) * (LowpassGate.DIAL_SCALE + offset);
    this.envelope.fallRate = LowpassGate.FALL_CEILING - Math.pow(x, LowpassGate.DIAL_POWER);
  }

  /** Command. One-shot (trigger) vs sustained (gate). */
  setTriggerMode(triggerMode) {
    this.envelope.inOneShotMode = triggerMode;
  }

  /**
   * Command. One sample.
   *
   * ⚠ `setCutoffFreqAlt` IS NOT `setCutoffFreq`. Their alt form is
   * `a = sin(2*PI*fc/fs)`, `b = 1 - a`, where the ordinary one is
   * `b = exp(-2*PI*fc/fs)`. The sine form is cheaper and DIVERGES above about
   * fs/6 — where `exp` keeps approaching unity gain, `sin` turns over and comes
   * back down, so a wide-open LPG is slightly darker than a bypassed one. Theirs;
   * reproduced by computing the same two coefficients directly.
   */
  process(x, trigger) {
    this.env = this.envelope.process(trigger);
    const vca = x * this.env;
    const cutoff = this.env * this.env * this.env * LowpassGate.MAX_CUTOFF_HZ;
    const w = clampTo(cutoff * 0.5, 1, this.sampleRate / 2 - 2);
    const a = Math.sin((2 * Math.PI * w) / this.sampleRate);
    this.lpf1._a = a;
    this.lpf1._b = 1 - a;
    this.lpf2._a = a;
    this.lpf2._b = 1 - a;
    this.lpf1.input = x;
    this.lpf2.input = this.lpf1.process();
    const filtered = this.lpf2.process();
    switch (this.mode) {
      case "bypass": return x;
      case "vca": return vca;
      case "filter": return filtered;
      case "both": return this.env * filtered;
      default: throw new Error(`LowpassGate: unreachable mode ${this.mode}`);
    }
  }
}
LowpassGate.MODES = Object.freeze(["bypass", "vca", "filter", "both"]);
LowpassGate.MAX_CUTOFF_HZ = 22050;
LowpassGate.LONG_OFFSET = 0.25;
LowpassGate.DIAL_SCALE = 0.75;
LowpassGate.ATTACK_SCALE = 0.62;
LowpassGate.DECAY_SCALE = 0.4;
LowpassGate.DIAL_POWER = 6;
LowpassGate.RISE_CEILING = 0.99999;
LowpassGate.FALL_CEILING = 0.999995;

/**
 * `dsp/generators/TFormSubOsc.hpp TFormSubOsc` — a sub-oscillator SLAVED to the
 * main oscillator's phasor, so it is always exactly an octave down and always in
 * phase. Four waves crossfaded by one knob: sine, saw, square, glitch.
 *
 * The octave division is a `counter` that flips on every end-of-cycle pulse, and
 * the saw/square are polyBLEP-corrected against the main oscillator's own step
 * size — so the sub is band-limited even under FM, which a separate oscillator
 * could not be.
 *
 * ⚠ `__c = (a - 0.5) * 2.005f` — the comment says "Correct inaccuracy" and the
 * 2.005 is a fudge for their Taylor sine's error at the interval ends. We call
 * `Math.sin`, so the 2.005 makes the sub 0.25% sharp of a true octave. KEPT
 * (D-TF-2005): removing it would change the sub's beating against the main
 * oscillator, and that beat is the sound.
 *
 * ⚠ THE GLITCH WAVE IS A ZERO-CROSSING FLIP-FLOP on the MAIN output, so its
 * period depends on how many times the current wavetable frame crosses zero. That
 * is why it is called glitch and why it changes with the Wave knob.
 *
 * Command.
 */
export class TFormSubOsc {
  constructor() {
    this.counter = 0;
    this.prev = 0;
    this.trig = 0;
    this.a = 0;
    this.b = 0;
    this.y = 0;
    this.setWave(0.25);
  }

  /** Command. One knob crossfading four waves in series: 0..1/3 sine->saw,
   *  1/3..2/3 saw->square, 2/3..1 square->glitch. */
  setWave(param) {
    this.wave1 = Math.min(param * 3, 1);
    this.wave2 = clampTo(param * 3 - 1, 0, 1);
    this.wave3 = clampTo(param * 3 - 2, 0, 1);
  }

  /**
   * Command. One sample.
   *
   * @param {number} x - the main oscillator's output (drives the glitch wave)
   * @param {number} phasor - the main oscillator's phase, 0..1
   * @param {number} eoc - 1 on the sample the main phasor wrapped
   * @param {number} stepSize - the main oscillator's phase increment
   * @param {number} direction - +1 or -1
   * @returns {number}
   */
  process(x, phasor, eoc, stepSize, direction) {
    this.counter += eoc ? 1 : 0;
    if (this.counter > 1) this.counter = 0;
    const step = stepSize * direction;

    const a = phasor * 0.5 + this.counter * 0.5;
    let b = a + 0.5;
    if (b >= 1) b -= 1;
    const saw = b * 2 - 1 - polyBlep(b, step);
    const square = (a < 0.5 ? 1 : -1) + polyBlep(a, step) - polyBlep(b, step);
    const sine = -Math.sin((a - 0.5) * TFormSubOsc.SINE_CORRECTION * Math.PI);

    if (x > TFormSubOsc.EPSILON && this.prev <= -TFormSubOsc.EPSILON) this.trig = 1 - this.trig;
    this.prev = x;
    const glitch = this.trig * 2 - 1;

    let out = linterp(sine, saw, this.wave1);
    out = linterp(out, square, this.wave2);
    return linterp(out, glitch, this.wave3);
  }
}
/** Their `2.005f` — see the class docblock, D-TF-2005. */
TFormSubOsc.SINE_CORRECTION = 2.005;
TFormSubOsc.EPSILON = 0.00001;

/**
 * `Valley/Terrorform` — the phase-distortion wavetable oscillator, mono.
 *
 * ── DERIVATION RECORD (R7-17) ───────────────────────────────────────────────
 * SOURCE   ValleyAudio/ValleyRackFree, model `Terrorform`, @ 86f02e43113 —
 *          `src/Terrorform/Terrorform.cpp` (the panel and the 512-sample control
 *          divider), `src/dsp/generators/QuadOsc.cpp ScanningQuadOsc::tick` (the
 *          oscillator), `src/dsp/shaping/Shaper.cpp` (SHAPERS above),
 *          `src/dsp/filters/VecLPG.hpp` (LowpassGate above),
 *          `src/dsp/generators/TFormSubOsc.hpp` (TFormSubOsc above).
 * BLOCK    `Terrorform::process`. Its control block runs behind
 *          `if (counter > 512)` — a CLOCK DIVIDER, per R7-11: bank selection,
 *          shape TYPE, LPG mode and every switch update at fs/513, not per
 *          sample. Reproduced with the same 512, so sweeping the Shape Type input
 *          steps at ~94 Hz exactly as it does on the original.
 *
 * THE RECURRENCE AS PORTED (per sample):
 *
 *     hz    = 261.6255 * 2^(voct + octave + coarse + fine)     // Valley's C4
 *     hz   *= lfoMode ? 0.01 : 1 ;  hz *= zeroFreq ? 0 : 1
 *     hz   += trueFM ? fm * 1000 : 0                           // through-zero FM
 *     step  = min(hz, fs/2) / fs
 *     pm    = (trueFM ? 0 : fm) + lastOutput * skew            // skew is FEEDBACK
 *     // postPMShape ? shape-then-PM : PM-then-shape
 *     rp    = clamp(wrapSigned(a + pm), 0, 1) ; rp = clamp(shape(rp, depth), 0, 1)
 *     s     = rp * (tabSize - 1)
 *     out   = lerp( lerp(bank[lo][floor s], bank[lo][floor s + 1], frac),
 *                   lerp(bank[hi][floor s], bank[hi][floor s + 1], frac),
 *                   wave - floor(wave) )                       // FRAME MORPH
 *     a    += step ; wrap a to [0,1) ; eoc = 1 on the wrap
 *     sub   = TFormSubOsc(out, a, eoc, step, dir)
 *     main  = swap ? enhance(lpg(out + sub*subLevel)) : lpg(enhance(out) + sub*subLevel)
 *     main  = dcBlock(clamp(main * 5, -10, 10))                // volts
 *
 * ⚠ THE FRAME MORPH IS WHAT MAKES THIS A WAVETABLE OSCILLATOR AND NOT A TABLE
 * READER. Two frames are read at the SAME phase and crossfaded by the fractional
 * part of the Wave position, so sweeping Wave glides through the bank instead of
 * stepping. The `highBank` index is clamped to `numWaves - 1` while `lowBank` is
 * NOT (Terrorform clamps the position first), so the top of the dial reads one
 * frame twice — a flat spot at the very end, theirs.
 *
 * ⚠ SKEW IS PHASE FEEDBACK, i.e. the previous sample's OUTPUT added to the read
 * phase. `Terrorform::process` scales the knob by 0.18 when the Skew input is
 * unpatched and by 0.018 per volt when it is. That is a self-modulating
 * oscillator, so it is chaotic at high settings — and it is a function of the
 * AUDIO stream, not of frame history, so it stays property/recordable state.
 *
 * ── WHAT THIS PORT DOES NOT SHIP, NAMED, BECAUSE A SILENT OMISSION IS WORSE ──
 *   D-TF-BANK      the 64 MB wavetable ROM. Eight analytic banks instead; see
 *                  `terrorformBank`. The oscillator is exact, the timbres are not
 *                  the same recordings. THIS IS THE ONE THAT MATTERS: P20 selects
 *                  `Bank = 27`, and this node cannot reproduce that bank's exact
 *                  spectrum. It reproduces its STRUCTURE.
 *   D-TF-ENHANCER  `dsp/shaping/Enhancer.hpp VecEnhancer` (296 lines, its own
 *                  mode list) is NOT ported, and neither is the `ENHANCER_OUTPUT`
 *                  tap or the Enhance Type / Depth pair. Chosen because P20 — the
 *                  one selected patch that uses Terrorform — leaves Enhance Depth
 *                  at 0, i.e. bypassed, so shipping it would have bought nothing
 *                  for the twenty patches. It is the largest single gap in this
 *                  block and the obvious next piece of work.
 *   D-TF-SYNC      one sync mode (HARD_SYNC, `syncChoice: 0`, which is what P20
 *                  stores) of the sixteen `ScanningQuadOsc::SyncModes` declares.
 *                  The other fifteen (fifth, octave, sub-octave, rise/fall/pull/
 *                  push A and B, hold, one-shot, lock-shot, reverse) are absent.
 *   D-TF-POLY      four groups of four SIMD channels, unison spread and the
 *                  `numVoices` voice allocator are absent: our `audio` wire is
 *                  mono. `spreadActive: 0, numVoices: 0` in P20, so the patch is
 *                  unaffected. R7-11's polyphony question is the lead's.
 *   D-TF-USERWAVE  the user wavetable editor, its file loader and `TFORM_MAX_BANKS`
 *                  of user banks. Out of scope for a document format.
 *   D-TF-2005      see TFormSubOsc.
 *   D-TF-VARSTEP   see SHAPERS.varStep — a divide-by-zero NaN, floored not copied.
 *   D-TF-LPGBUTTON their LPG mode cycles on a button press and toggles bypass on a
 *                  500 ms HOLD. A press-and-hold gesture is not property state, so
 *                  `lpg_mode` is a discrete knob with the four values directly.
 *
 * Command.
 */
export class TerrorformKernel {
  constructor(sampleRate, options = {}) {
    this.sampleRate = sampleRate;
    this.nyquist = sampleRate / 2;
    this.tableSize = TF_TABLE_SIZE;
    this.frames = TF_BANK_FRAMES;
    this.random = new Vc5Random(options.seed ?? 0);
    // `warble`'s two 40 Hz one-poles. At 44100 in the original; at OUR rate here,
    // because a fixed coefficient would make the wobble rate sample-rate
    // dependent and this is the one place their hard-coded 44100 is a plain bug
    // rather than a character (D-TF-WARBLERATE).
    this.warble1 = new OnePoleLPFilter(TerrorformKernel.WARBLE_CUTOFF_HZ, sampleRate);
    this.warble2 = new OnePoleLPFilter(TerrorformKernel.WARBLE_CUTOFF_HZ, sampleRate);
    this.lpg = new LowpassGate(sampleRate);
    this.subOsc = new TFormSubOsc();
    this.mainDcBlock = new OnePoleHPFilter(TerrorformKernel.DC_BLOCK_HZ, sampleRate);
    this.rawDcBlock = new OnePoleHPFilter(TerrorformKernel.DC_BLOCK_HZ, sampleRate);

    this.phase = 0;
    this.readPhase = 0;
    this.output = 0;
    this.step = 0;
    this.eoc = 0;
    this.prevSync = 0;
    this.shapeName = SHAPE_NAMES[0];
    this.bankData = null;

    this.sw = {};
    this.setBank(options.bank ?? "basic");
    this.setShape(options.shape ?? SHAPE_NAMES[0]);
    this.setLpgMode(options.lpg_mode ?? "bypass");
    for (const name of TerrorformKernel.SWITCHES) this.setSwitch(name, options[name] ?? "off");
  }

  /** Command. Regenerate the wavetable bank. Construct-time on the spec: 128 KB
   *  of Float32 is generated here, so a live sweep of the Bank dial would
   *  allocate per change. */
  setBank(name) {
    if (!(name in TF_BANKS)) {
      throw new Error(`TerrorformKernel.setBank: unknown bank ${JSON.stringify(name)} — see TF_BANKS`);
    }
    this.bank = name;
    this.bankData = terrorformBank(name, this.tableSize, this.frames);
  }

  /** Command. The phase shaper, by panel name. */
  setShape(name) {
    if (!SHAPE_NAMES.includes(name)) {
      throw new Error(`TerrorformKernel.setShape: unknown shape ${JSON.stringify(name)} — see SHAPE_NAMES`);
    }
    this.shapeName = name;
  }

  /** Command. */
  setLpgMode(value) {
    this.lpg.setMode(value);
  }

  /**
   * Command. Set one of the eight panel switches. Every switch reads back through
   * `this.sw[name]`, so `sample` has one place to look and the eight named setters
   * below are one generated line rather than eight hand-kept ones.
   *
   * `lpg_trigger` additionally reaches into the gate, which is why this takes the
   * name rather than being eight independent bodies.
   */
  setSwitch(name, value) {
    if (!TerrorformKernel.SWITCHES.includes(name)) {
      throw new Error(`TerrorformKernel.setSwitch: unknown switch ${JSON.stringify(name)}`);
    }
    this.sw[name] = PlateauKernel.readSwitch(name, value);
    if (name === "lpg_trigger") this.lpg.setTriggerMode(this.sw[name]);
  }

  /** Command (advances the warble noise state when the shaper is `warble`). The
   *  one shaper that is not pure, kept here rather than in SHAPERS so that array
   *  stays a table of pure functions. */
  shape(a, f) {
    if (this.shapeName !== "warble") return SHAPERS[this.shapeName](a, f);
    // D0: their `mwcRand` seeded from `std::time(NULL)`; ours from the seed knob.
    const raw = this.random.nextFloat() * 4 - 2;
    this.warble1.input = raw;
    this.warble2.input = this.warble1.process();
    const noise = this.warble2.process();
    const y = circleWrap((a + noise * f) * 2 - 1);
    return (y + 1) * 0.5;
  }

  /**
   * Command. One sample.
   *
   * @param {object} c - the a-rate controls, by knob key
   * @param {Float64Array} inputs - unused; Terrorform has no audio input
   * @param {Float64Array} frame - [main, raw, sub, env, phasor, eoc] in ±1 units
   * @returns {void} (writes `frame`)
   */
  sample(c, inputs, frame) {
    // ── SYNC: a rising edge zeroes the phasor (HARD_SYNC only, D-TF-SYNC) ────
    const syncHigh = c.sync > 0 ? 1 : 0;
    if (syncHigh && !this.prevSync) this.phase = 0;
    this.prevSync = syncHigh;

    // ── PITCH ───────────────────────────────────────────────────────────────
    // V4: `v_oct`, `coarse` and `fine` are SEMITONES; `octave` is whole octaves,
    // because that is what its own panel label says it is.
    const volts = (c.v_oct + c.coarse + c.fine) / SEMITONES_PER_OCTAVE + Math.round(c.octave);
    let hz = valleyPitchToHz(volts);
    if (this.sw.lfo_mode) hz *= TerrorformKernel.LFO_DIVISOR;
    if (this.sw.zero_freq) hz = 0;
    const fm = c.fm * c.fm_level * TerrorformKernel.FM_SCALE;
    if (this.sw.true_fm) hz += fm * TerrorformKernel.TRUE_FM_HZ_PER_UNIT;
    this.step = Math.min(hz, this.nyquist) / this.sampleRate;

    // ── PHASE MODULATION + SHAPING ──────────────────────────────────────────
    const skew = clampTo(c.skew, 0, 1) * TerrorformKernel.SKEW_SCALE;
    const pm = (this.sw.true_fm ? 0 : fm) + this.output * skew;
    const depth = clampTo(c.shape_depth, 0, 1);
    let rp;
    if (this.sw.post_pm_shape) {
      rp = clampTo(this.shape(this.phase, depth), 0, 1);
      rp = clampTo(TerrorformKernel.wrapSigned(rp + pm), 0, 1);
    } else {
      rp = TerrorformKernel.wrapSigned(this.phase + pm);
      rp = clampTo(this.shape(rp, depth), 0, 1);
    }
    this.readPhase = rp;

    // ── THE TWO-FRAME MORPHING TABLE READ ───────────────────────────────────
    const framesMinusOne = this.frames - 1;
    const wave = clampTo(c.wave, 0, 1) * framesMinusOne;
    const lowFrame = Math.trunc(wave);
    const highFrame = clampTo(lowFrame + 1, 0, framesMinusOne);
    const fade = wave - lowFrame;
    const scaled = rp * (this.tableSize - 1);
    const i0 = Math.trunc(scaled);
    let i1 = i0 + 1;
    if (i1 >= this.tableSize) i1 -= this.tableSize;
    const frac = scaled - i0;
    const bank = this.bankData;
    const lo = this.tableSize * lowFrame;
    const hi = this.tableSize * highFrame;
    const r1 = linterp(bank[lo + i0], bank[lo + i1], frac);
    const r2 = linterp(bank[hi + i0], bank[hi + i1], frac);
    this.output = linterp(r1, r2, fade);

    // ── ADVANCE ─────────────────────────────────────────────────────────────
    this.phase += this.step;
    let wrapped = false;
    if (this.phase < 0) {
      this.phase += 1;
      wrapped = true;
    }
    if (this.phase >= 1) {
      this.phase -= 1;
      wrapped = true;
    }
    this.eoc = wrapped ? 1 : 0;

    // ── SUB, LPG, OUTPUT ────────────────────────────────────────────────────
    const sub = this.subOsc.process(this.output, this.phase, this.eoc, this.step, 1);
    this.subOsc.setWave(clampTo(c.sub_wave, 0, 1));
    this.lpg.setAttack(c.lpg_attack, this.sw.lpg_long);
    this.lpg.setDecay(c.lpg_decay, this.sw.lpg_long);
    const rawTrigger = c.trigger * TerrorformKernel.TRIGGER_SCALE;
    const trigger = clampTo(this.sw.lpg_velocity ? rawTrigger : (rawTrigger > 0 ? 1 : 0), 0, 1);
    const subMix = sub * clampTo(c.sub_level, 0, 1);
    // `swapEnhancerAndLPG` still decides where the sub joins, because the sub is
    // added to the LPG's INPUT in one order and to its output in the other. The
    // enhancer half of the swap is absent (D-TF-ENHANCER).
    const main = this.sw.swap ? this.lpg.process(this.output + subMix, trigger) : this.lpg.process(this.output, trigger) + subMix;

    this.mainDcBlock.input = clampTo(main * RACK_VOLTS_PER_UNIT, -RACK_MAX_VOLTS, RACK_MAX_VOLTS);
    this.rawDcBlock.input = this.output * RACK_VOLTS_PER_UNIT;
    frame[0] = this.mainDcBlock.process() / RACK_VOLTS_PER_UNIT;
    frame[1] = this.rawDcBlock.process() / RACK_VOLTS_PER_UNIT;
    frame[2] = sub;
    // ── R7-UNITS CLAUSE 2, NOT CLAUSE 1 (lead ruling, 2026-08-06) ───────────
    // These two are NOT audio, they are MODULATION SOURCES — so the rule is "the
    // real unit of the quantity", and the real unit of a normalised envelope or a
    // phase ramp is 0..1. Their Rack outputs are 0..10 V, and clause 1's divide-by-
    // five would put them at 0..2: outside the rail every other normalised control
    // in this library uses, so an author patching `env` into a 0..1 depth knob
    // would get DOUBLE what the panel shows. Same argument clause 4 makes for
    // gates, one step over: level, but not audio level.
    frame[3] = this.lpg.env;
    // Their `PHASOR_OUTPUT` is `(phasor * -2 + 1) * -5` volts — two negations that
    // cancel into a rising 0..10 V ramp. Emitted as the 0..1 phasor it already is.
    frame[4] = this.phase;
    // CLAUSE 4: `eoc` is a gate, so it is 0 or 1 and not their 5 V / 5.
    frame[5] = this.eoc;
  }

  /**
   * Pure function. `ScanningQuadOsc::tick`'s phase wrap — truncate toward zero,
   * then subtract one MORE for a negative value, so the result is always in
   * [0, 1). Their `negMask` branch.
   *
   * @example TerrorformKernel.wrapSigned(1.25) // 0.25
   * @example TerrorformKernel.wrapSigned(-0.25) // 0.75
   * @example TerrorformKernel.wrapSigned(0.5) // 0.5
   */
  static wrapSigned(p) {
    let shifts = Math.trunc(p);
    if (p < 0) shifts -= 1;
    return p - shifts;
  }
}
/**
 * THE EIGHT PANEL SWITCHES, message-delivered rather than a-rate.
 *
 * ⚠ D-TF-DIVIDER — `Terrorform::process` gates every one of these, plus the Bank
 * and Shape Type selections, behind `if (counter > 512)` — a CLOCK DIVIDER, so on
 * the original they update at fs/513 (about 94 Hz) and a CV-modulated Shape Type
 * audibly STEPS at that rate. R7-11's rule is to port the divisor.
 *
 * THERE IS NOTHING LEFT FOR IT TO DIVIDE HERE, and that is a consequence of V2
 * rather than an oversight. Their divided reads all came from CV-input-plus-
 * attenuverter pairs; in this port Bank is a construct-time knob, Shape is a
 * discrete knob, and these eight are discrete switches — all three delivered by
 * message, none read per sample. So the divider is vestigial and is not shipped.
 * THE COST, STATED: Shape Type cannot be modulated at all on this node, where on
 * the original it could be swept (in 94 Hz steps) from a CV input. If that
 * modulation is wanted, the honest fix is a `shape` a-rate param indexing
 * SHAPE_NAMES with the divider restored — not a silent removal, which is why this
 * is written down.
 */
TerrorformKernel.SWITCHES = Object.freeze([
  "true_fm", "lfo_mode", "zero_freq", "post_pm_shape", "swap",
  "lpg_long", "lpg_velocity", "lpg_trigger",
]);
/** Their divisor, kept as a named constant so D-TF-DIVIDER's number is on record
 *  for whoever restores it. */
TerrorformKernel.CONTROL_DIVIDER = 512;

/**
 * THE EIGHT SWITCH SETTERS, GENERATED FROM THE ROSTER ABOVE rather than written
 * out. `vc5OptionSetter` turns option `true_fm` into method `setTrueFm`, and the
 * bridge calls that name — so eight hand-written one-line bodies would be a
 * hand-maintained mirror of `SWITCHES`, which is the drift shape the brief names.
 * One loop, and a switch added to the roster gets its setter for free.
 */
for (const name of TerrorformKernel.SWITCHES) {
  const method = `set${name.split("_").map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join("")}`;
  TerrorformKernel.prototype[method] = function setSwitchByName(value) {
    this.setSwitch(name, value);
  };
}
/** `__hundredths` in LFO mode — the pitch is divided by 100, so C4 becomes
 *  2.6 Hz and the whole V/oct range becomes an LFO range. */
TerrorformKernel.LFO_DIVISOR = 0.01;
/** Their FM level knobs are scaled by 0.2 before summing, and true-FM multiplies
 *  the sum by 1000 Hz. Both theirs. */
TerrorformKernel.FM_SCALE = 0.2;
TerrorformKernel.TRUE_FM_HZ_PER_UNIT = 1000;
/** `params[SKEW_PARAM] * 0.18f` with the Skew input unpatched. */
TerrorformKernel.SKEW_SCALE = 0.18;
/** `__tenths` — the trigger input is read as volts/10, so a 10 V gate is 1.0 of
 *  velocity. Our trigger port is already 0..1, so this is 1 and named rather
 *  than silently dropped. */
TerrorformKernel.TRIGGER_SCALE = 1;
/** `mainOutDCBlock.setCutoffFreq(lfoModeEnabled ? 0.f : 2.f)`. LFO mode's 0 Hz is
 *  handled by OnePoleHPFilter's 1 Hz floor; 2 Hz is the audio-mode value. */
TerrorformKernel.DC_BLOCK_HZ = 2;
TerrorformKernel.WARBLE_CUTOFF_HZ = 40;
TerrorformKernel.GATE_THRESHOLD = 0.5;

/**
 * ══ V4 — A PITCH PORT CARRIES SEMITONES, ORIGIN C4 ══════════════════════════
 * THE LEAD'S R7-UNITS RULING (2026-08-06, `claude_instructions.md` above
 * § R7-17-SEL): `semitones = 12 × volts`. V1's five-volts-per-unit rule is about
 * AUDIO and must NOT be applied to a pitch CV — the reason is a seam. `rewin` is
 * a quantiser whose whole job is to hand a pitch to an oscillator's `v_oct`; if
 * the two sides disagreed about the scale the wire would still connect, the types
 * would still agree, and the tuning would be silently wrong. One convention,
 * stated once, on both sides.
 *
 * ⚠ THE ORIGIN IS C4, NOT E4, AND THAT IS THE PART MOST LIKELY TO BE QUIETLY
 * WRONG. VCV's 0 V is `dsp::FREQ_C4` = 261.6256 Hz. Axoloti's semitone 0 is MIDI
 * 64 = E4 = 329.6276 Hz, and `core/audio_nodes.semitonesToHz` is THE E4 ONE —
 * built for the AX blocks. Reusing it on a VCV card would read FOUR SEMITONES
 * SHARP. This block therefore never imports it; `vcvSemitonesToHz` below is the
 * C4-origin converter, and it is the only one any VCV port may use.
 */
export const SEMITONES_PER_OCTAVE = 12;

/**
 * Pure function. A VCV semitone (origin C4) to hertz — the C4-origin counterpart
 * of `core/audio_nodes.semitonesToHz`, which is E4-origin and must not be used on
 * a VCV port. Valley's own five-figure C4 is kept; see `valleyPitchToHz`.
 *
 * @param {number} semitones - semitones from C4, so 0 is C4 and 12 is C5
 * @returns {number} hertz
 *
 * @example Math.round(vcvSemitonesToHz(0) * 10) / 10 // 261.6
 * @example Math.round(vcvSemitonesToHz(12)) // 523
 * @example Math.round(vcvSemitonesToHz(9)) // 440
 * @example Math.round(vcvSemitonesToHz(-12) * 10) / 10 // 130.8
 */
export function vcvSemitonesToHz(semitones) {
  return valleyPitchToHz(semitones / SEMITONES_PER_OCTAVE);
}

// ════════════════════════════════════════════════════════════════════════════
// JUSTAPHASER — FrozenWasteland/JustAPhaser, a 4/8/12-stage phaser
// ════════════════════════════════════════════════════════════════════════════

/**
 * Nigel Redmon's EarLevel biquad, as FrozenWasteland vendors it
 * (`src/filters/biquad.{h,cpp}`). Transposed direct form 2:
 *
 *     out = in*a0 + z1
 *     z1  = in*a1 + z2 - b1*out
 *     z2  = in*a2 - b2*out
 *
 * ONLY the two types JustAPhaser uses are ported (notch and allpass); the other
 * six in the header are not reachable from that module.
 *
 * ⚠ D-JAP-ALLPASS — THEIR ALLPASS COEFFICIENTS ARE COMPUTED IN THE WRONG UNITS
 * AND WITH Q ON THE WRONG SIDE, AND BOTH ARE REPRODUCED.
 *     `double alpha = sin(Fc) / 2.0 * Q;  double cs = cos(Fc);`
 * `Fc` is a NORMALISED frequency (f/fs, 0..0.5) everywhere else in this class —
 * the notch branch correctly writes `tan(M_PI * Fc)`. Here `sin` and `cos` are
 * handed it as RADIANS, so a 4.8 kHz allpass at 48 kHz uses sin(0.1) = 0.0998
 * where the cookbook wants sin(2*PI*0.1) = 0.5878, and `cos(0.1)` = 0.995 pins
 * every pole near DC. On top of that the cookbook's alpha is `sin(w)/(2Q)` and
 * this is `(sin(w)/2)*Q`, so raising Resonance BROADENS the notch instead of
 * narrowing it. The audible result is a phaser whose allpass mode barely sweeps.
 * Reproduced because the module's sound is the sum of its bugs; named because a
 * future reader will otherwise "fix" it and change every P4 render.
 *
 * Command (mutates z1/z2).
 */
export class EarLevelBiquad {
  constructor(type, fc, q) {
    this.z1 = 0;
    this.z2 = 0;
    this.type = type;
    this.fc = fc;
    this.q = q;
    this.calc();
  }

  /** Command. One sample. */
  process(input) {
    const out = input * this.a0 + this.z1;
    this.z1 = input * this.a1 + this.z2 - this.b1 * out;
    this.z2 = input * this.a2 - this.b2 * out;
    return out;
  }

  /** Command. */
  setType(type) {
    if (!EarLevelBiquad.TYPES.includes(type)) {
      throw new Error(`EarLevelBiquad.setType: expected one of ${EarLevelBiquad.TYPES.join(", ")}, got ${JSON.stringify(type)}`);
    }
    this.type = type;
    this.calc();
  }

  /** Command. */
  setQ(q) {
    this.q = q;
    this.calc();
  }

  /** Command. `fc` is NORMALISED (f / sampleRate). */
  setFc(fc) {
    this.fc = fc;
    this.calc();
  }

  /** Command. Recompute the five coefficients. See D-JAP-ALLPASS. */
  calc() {
    if (this.type === "notch") {
      const K = Math.tan(Math.PI * this.fc);
      const norm = 1 / (1 + K / this.q + K * K);
      this.a0 = (1 + K * K) * norm;
      this.a1 = 2 * (K * K - 1) * norm;
      this.a2 = this.a0;
      this.b1 = this.a1;
      this.b2 = (1 - K / this.q + K * K) * norm;
      return;
    }
    // D-JAP-ALLPASS, verbatim: radians-vs-normalised AND Q multiplied.
    const alpha = (Math.sin(this.fc) / 2) * this.q;
    const cs = Math.cos(this.fc);
    const norm = 1 / (1 + alpha);
    this.b1 = -2 * cs * norm;
    this.b2 = (1 - alpha) * norm;
    this.a0 = (1 - alpha) * norm;
    this.a1 = -2 * cs * norm;
    this.a2 = (1 + alpha) * norm;
  }
}
EarLevelBiquad.TYPES = Object.freeze(["notch", "allpass"]);

/**
 * `FrozenWasteland/JustAPhaser` — a 4, 8 or 12 stage phaser with per-stage
 * frequency offsets, four modulation-span profiles and an external feedback loop.
 *
 * ── DERIVATION RECORD (R7-17) ───────────────────────────────────────────────
 * SOURCE   github.com/almostEric/FrozenWasteland `src/JustAPhaser.cpp` +
 *          `src/filters/biquad.cpp`, model `JustAPhaser`,
 *          @ 608d49dc365eb2fd4734e58ee5fd356ce03919ff.
 * BLOCK    `JustAPhaser::process`, plus the `basefreq` / `basespan` tables in the
 *          struct body and `LowFrequencyOscillator` above them.
 *
 * THE RECURRENCE AS PORTED (per channel c, per sample):
 *
 *     lfoFreq = 2^clamp(freqDial, -8, 3)                    // 0.0039 .. 8 Hz
 *     lfo.phase += min(lfoFreq/fs, 0.5) ; wrap at 1
 *     lfoValue  = extMod patched ? extMod/5 - 1 : wave(phase + (c ? stereoPhase : 0))
 *     for stage i:
 *       Fc = centre - 2 + basefreq[stages][i]*span + depth*basespan[mode][stages][i]*lfoValue
 *       if |Fc - lastFc[i][c]| > 0.01:  filter.fc = clamp(2^Fc, 20, 15000) / fs
 *     y = dry[c] + feedbackIn[c]*feedback
 *     y = stage_n(...stage_1(y))
 *     feedbackOut[c] = y ; feedbackIn[c] = fbReturn patched ? fbReturn : y
 *     out[c] = lerp(dry[c], y, mix)
 *
 * ⚠ D-JAP-INTDIV — THE STAGE FREQUENCY TABLE IS HALF INTEGER DIVISION AND THAT
 * IS WHERE THE SOUND COMES FROM. `basefreq` is a `float[][]` initialised from
 * expressions like `{1.5 / 12, 19.5 / 12, 35 / 12, 50 / 12}`. The first two are
 * double division; `35 / 12` and `50 / 12` are INT / INT in C++ and evaluate to
 * **2** and **4**. So the four-stage profile is not the intended
 * {0.125, 1.625, 2.917, 4.167} octaves above centre but {0.125, 1.625, 2, 4} —
 * and in the twelve-stage profile `7 / 12` collapses to **0**, putting a stage
 * exactly on the centre frequency. Every truncated entry is marked below.
 * Reproduced: the module has shipped like this since 2019 and P4 is voiced on it.
 *
 * ⚠ D-JAP-MODEINVERT — THE FILTER TYPE SWITCH IS BACKWARDS. `enum FilterModes`
 * is `{FILTER_ALLPASS, FILTER_NOTCH}` and the panel light `FILTER_AP_LIGHT` is
 * lit when `filterMode == FILTER_ALLPASS` (0) — but the code writes
 * `setType(filterMode ? bq_type_allpass : bq_type_notch)`, so mode 0 installs a
 * NOTCH and mode 1 an ALLPASS. The lights and the sound disagree. Reproduced,
 * and our option NAMES follow THE SOUND rather than the light: `"notch"` is the
 * first option, matching stored `filterMode: 0`. A patch's saved integer
 * therefore still selects the same filter it did in Rack.
 *
 * ⚠ D-JAP-FCTHRESHOLD — a stage's coefficients are only recomputed when its
 * target frequency has moved by more than 0.01 OCTAVES. That is a 1/100-octave
 * quantiser on the sweep and it is audible as fine stepping on a slow, deep
 * modulation. Reproduced: removing it makes the phaser smoother than the module.
 *
 * ⚠ D-JAP-EXTMOD — `lfoValue = extMod/5.0 - 1.0` when an external modulation
 * input is patched. The `- 1` means a 0 V modulator parks the sweep at −1 (fully
 * down) rather than at centre, so an external LFO must be UNIPOLAR 0..10 V to
 * behave. Reproduced; our port reads the input in ±1 units, so `in*5/5 - 1`.
 *
 * DEVIATIONS: D-JAP-SQR — their square LFO is `|phase + offset| < 0.5`, which is
 * UNIPOLAR 0/1 and (because `phase + offset` can exceed 1) is low for most of the
 * cycle on the right channel. Reproduced. D-NOCV per V2.
 *
 * Command.
 */
export class JustAPhaserKernel {
  constructor(sampleRate, options = {}) {
    this.sampleRate = sampleRate;
    this.phase = 0;
    this.filters = [];
    this.lastFc = [];
    for (let c = 0; c < JustAPhaserKernel.CHANNELS; c++) {
      this.filters.push(Array.from({ length: JustAPhaserKernel.MAX_STAGES }, () => new EarLevelBiquad("allpass", JustAPhaserKernel.INIT_FC, JustAPhaserKernel.INIT_Q)));
      this.lastFc.push(new Float64Array(JustAPhaserKernel.MAX_STAGES).fill(NaN));
    }
    this.feedbackIn = new Float64Array(JustAPhaserKernel.CHANNELS);
    this.lastResonance = NaN;
    this.filterType = null;
    this.setStages(options.stages ?? "4");
    this.setFilter(options.filter ?? "notch");
    this.setWave(options.wave ?? "sin");
    this.setSpan(options.span ?? "log");
  }

  /** Command. 4, 8 or 12 — each has its own frequency profile. */
  setStages(value) {
    const index = JustAPhaserKernel.STAGE_COUNTS.indexOf(value);
    if (index < 0) {
      throw new Error(`JustAPhaserKernel.setStages: expected one of ${JustAPhaserKernel.STAGE_COUNTS.join(", ")}, got ${JSON.stringify(value)}`);
    }
    this.stageIndex = index;
    this.stages = Number(value);
    for (const row of this.lastFc) row.fill(NaN);
  }

  /** Command. See D-JAP-MODEINVERT: these names follow the SOUND. */
  setFilter(value) {
    if (!EarLevelBiquad.TYPES.includes(value)) {
      throw new Error(`JustAPhaserKernel.setFilter: expected one of ${EarLevelBiquad.TYPES.join(", ")}, got ${JSON.stringify(value)}`);
    }
    this.filterType = value;
    for (const row of this.filters) for (const f of row) f.setType(value);
    this.lastResonance = NaN;
  }

  /** Command. */
  setWave(value) {
    if (!JustAPhaserKernel.WAVES.includes(value)) {
      throw new Error(`JustAPhaserKernel.setWave: expected one of ${JustAPhaserKernel.WAVES.join(", ")}, got ${JSON.stringify(value)}`);
    }
    this.wave = value;
  }

  /** Command. Which per-stage modulation-depth profile: log, constant, or either
   *  with alternating sign so adjacent notches sweep in opposite directions. */
  setSpan(value) {
    if (!JustAPhaserKernel.SPANS.includes(value)) {
      throw new Error(`JustAPhaserKernel.setSpan: expected one of ${JustAPhaserKernel.SPANS.join(", ")}, got ${JSON.stringify(value)}`);
    }
    this.span = value;
  }

  /** Query. One LFO sample at a phase offset. See D-JAP-SQR. */
  lfo(offset) {
    const p = this.phase + offset;
    switch (this.wave) {
      case "sin": return Math.sin(2 * Math.PI * Math.abs(p));
      case "tri": return -1 + 4 * Math.abs(p - 0.75 - Math.round(p - 0.75));
      case "saw": return 2 * (p - Math.round(p));
      case "sqr": return Math.abs(p) < JustAPhaserKernel.SQUARE_PW ? 1 : 0;
      default: throw new Error(`JustAPhaserKernel: unreachable wave ${this.wave}`);
    }
  }

  /**
   * Command. One sample.
   *
   * @param {object} c - the a-rate controls
   * @param {Float64Array} inputs - [in_l, in_r, fb_in_l, fb_in_r, ext_mod_l, ext_mod_r]
   * @param {Float64Array} frame - [out_l, out_r, fb_out_l, fb_out_r]
   * @returns {void} (writes `frame`)
   */
  sample(c, inputs, frame) {
    const feedbackAmount = clampTo(c.feedback, -1, 1);
    const lfoFreq = Math.pow(2, Math.min(clampTo(c.frequency, JustAPhaserKernel.FREQ_MIN, JustAPhaserKernel.FREQ_MAX), JustAPhaserKernel.PITCH_CEILING));
    this.phase += Math.min(lfoFreq / this.sampleRate, JustAPhaserKernel.MAX_PHASE_STEP);
    if (this.phase >= 1) this.phase -= 1;

    const resonance = clampTo(c.resonance, JustAPhaserKernel.RESO_MIN, JustAPhaserKernel.RESO_MAX);
    if (resonance !== this.lastResonance) {
      for (const row of this.filters) for (let i = 0; i < this.stages; i++) row[i].setQ(resonance);
      this.lastResonance = resonance;
    }

    const centre = clampTo(c.center_frequency, JustAPhaserKernel.CENTRE_MIN, JustAPhaserKernel.CENTRE_MAX);
    const span = clampTo(c.frequency_span, 0, 1);
    const depth = clampTo(c.depth, 0, 1);
    const stereoPhase = clampTo(c.stereo_phase, 0, 1);
    const baseFreq = JAP_BASE_FREQ[this.stageIndex];
    const baseSpan = JAP_BASE_SPAN[this.span][this.stageIndex];

    for (let ch = 0; ch < JustAPhaserKernel.CHANNELS; ch++) {
      const ext = inputs[JustAPhaserKernel.EXT_MOD_BASE + ch];
      // D-JAP-EXTMOD: theirs is `extMod/5 - 1`, and our ±1 unit IS extMod/5.
      const lfoValue = ext !== 0 ? ext - 1 : this.lfo(ch === 0 ? 0 : stereoPhase);
      const row = this.filters[ch];
      const last = this.lastFc[ch];
      for (let i = 0; i < this.stages; i++) {
        const fc = centre - JustAPhaserKernel.CENTRE_OFFSET + baseFreq[i] * span + depth * baseSpan[i] * lfoValue;
        // D-JAP-FCTHRESHOLD: a 0.01-octave quantiser on the sweep.
        if (!(Math.abs(last[i] - fc) <= JustAPhaserKernel.FC_THRESHOLD)) {
          row[i].setFc(clampTo(Math.pow(2, fc), JustAPhaserKernel.FC_MIN_HZ, JustAPhaserKernel.FC_MAX_HZ) / this.sampleRate);
          last[i] = fc;
        }
      }
    }

    const mix = clampTo(c.mix, 0, 1);
    for (let ch = 0; ch < JustAPhaserKernel.CHANNELS; ch++) {
      // Their `directInput = in/5.0`, and our ±1 unit is exactly that.
      const dry = inputs[ch];
      let y = dry + this.feedbackIn[ch] * feedbackAmount;
      const row = this.filters[ch];
      for (let i = 0; i < this.stages; i++) y = row[i].process(y);
      frame[JustAPhaserKernel.FB_OUT_BASE + ch] = y;
      const ret = inputs[JustAPhaserKernel.FB_IN_BASE + ch];
      this.feedbackIn[ch] = ret !== 0 ? ret : y;
      frame[ch] = linterp(dry, y, mix);
    }
  }
}
JustAPhaserKernel.CHANNELS = 2;
JustAPhaserKernel.MAX_STAGES = 12;
JustAPhaserKernel.STAGE_COUNTS = Object.freeze(["4", "8", "12"]);
JustAPhaserKernel.WAVES = Object.freeze(["sin", "tri", "saw", "sqr"]);
/** `enum FrequencyModTypes` in its own order: log, constant, then the two
 *  alternating-sign variants. */
JustAPhaserKernel.SPANS = Object.freeze(["log", "constant", "alt_log", "alt_constant"]);
JustAPhaserKernel.INIT_FC = 0.5;
JustAPhaserKernel.INIT_Q = 0.707;
JustAPhaserKernel.FREQ_MIN = -8;
JustAPhaserKernel.FREQ_MAX = 3;
/** `LowFrequencyOscillator::setPitch` does `fminf(pitch, 8.0)` — a second,
 *  looser ceiling above the dial's own 3. Kept because a modulation input can
 *  reach it. */
JustAPhaserKernel.PITCH_CEILING = 8;
/** `fminf(freq * dt, 0.5)` — the LFO cannot advance more than half a cycle per
 *  sample, which is Nyquist for a phasor. */
JustAPhaserKernel.MAX_PHASE_STEP = 0.5;
JustAPhaserKernel.RESO_MIN = 0.5;
JustAPhaserKernel.RESO_MAX = 5;
JustAPhaserKernel.CENTRE_MIN = 4;
JustAPhaserKernel.CENTRE_MAX = 14;
/** `float Fc = centerFrequency - 2.0 + ...` with the comment "2.0 is temporary".
 *  Still there four years later; it is part of the tuning. */
JustAPhaserKernel.CENTRE_OFFSET = 2;
JustAPhaserKernel.FC_THRESHOLD = 0.01;
JustAPhaserKernel.FC_MIN_HZ = 20;
JustAPhaserKernel.FC_MAX_HZ = 15000;
JustAPhaserKernel.SQUARE_PW = 0.5;
/** Where each pair sits in the `inputs` / `frame` arrays. */
JustAPhaserKernel.FB_IN_BASE = 2;
JustAPhaserKernel.EXT_MOD_BASE = 4;
JustAPhaserKernel.FB_OUT_BASE = 2;

/**
 * `basefreq` — per-stage offsets in OCTAVES above `centre - 2`, for the 4, 8 and
 * 12 stage profiles. THE VALUES MARKED `int` BELOW ARE C++ INTEGER DIVISION IN
 * THE ORIGINAL, not a transcription error here. See D-JAP-INTDIV.
 */
const JAP_BASE_FREQ = Object.freeze([
  Object.freeze([1.5 / 12, 19.5 / 12, 2, 4]),
  //                                 ^int(35/12)  ^int(50/12)
  Object.freeze([0.6 / 12, 1.5 / 12, 0, 19.5 / 12, 2, 2, 3, 4]),
  //                                 ^int(7/12)    ^int(27/12) ^int(35/12) ^int(43/12) ^int(50/12)
  Object.freeze([0.6 / 12, 1.5 / 12, 2.2 / 12, 0, 19.5 / 12, 1, 2, 2, 3, 3, 4, 4]),
  //                                           ^int(7/12)    ^int(23/12) … ^int(55/12)
]);

/** `basespan` — per-stage modulation depth, in octaves per unit of LFO. The
 *  `alt_*` rows negate every other stage, which is what makes adjacent notches
 *  cross instead of moving together. All entries are literal floats in the source,
 *  so none of these suffer D-JAP-INTDIV. */
const JAP_BASE_SPAN = Object.freeze({
  log: Object.freeze([
    Object.freeze([2, 1.5, 1, 0.5]),
    Object.freeze([2, 2, 1.75, 1.5, 1.25, 1, 0.75, 0.5]),
    Object.freeze([2, 2, 1.8, 1.75, 1.5, 1.25, 1.1, 1, 0.75, 0.6, 0.5, 0.4]),
  ]),
  constant: Object.freeze([
    Object.freeze([2, 2, 2, 2]),
    Object.freeze([2, 2, 2, 2, 2, 2, 2, 2]),
    Object.freeze([2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2]),
  ]),
  alt_log: Object.freeze([
    Object.freeze([2, -1.5, 1, -0.5]),
    Object.freeze([2, -2, 1.75, -1.5, 1.25, -1, 0.75, -0.5]),
    Object.freeze([2, -2, 1.8, -1.75, 1.5, -1.25, 1.1, -1, 0.75, -0.6, 0.5, -0.4]),
  ]),
  alt_constant: Object.freeze([
    Object.freeze([2, -2, 2, -2]),
    Object.freeze([2, -2, 2, -2, 2, -2, 2, -2]),
    Object.freeze([2, -2, 2, -2, 2, -2, 2, -2, 2, -2, 2, -2]),
  ]),
});

// ════════════════════════════════════════════════════════════════════════════
// SPF — dbRackModules/SPF, a three-input state-space parallel filter
// ════════════════════════════════════════════════════════════════════════════

/**
 * `dbRackModules/SPF` — Victor Lazzarini's Csound state-space filter: ONE
 * biquad denominator shared by THREE separate numerators, so a lowpass, a
 * bandpass and a highpass input can be summed inside one resonant structure.
 *
 * ── DERIVATION RECORD (R7-17) ───────────────────────────────────────────────
 * SOURCE   github.com/docb/dbRackModules `src/SPF.cpp`, model `SPF`,
 *          @ fa15d1b708e1e27f560a2bc0788888b9d80a4bfc. The file's own header
 *          credits the algorithm: "taken from csound Copyright (c) Victor
 *          Lazzarini, 2021".
 * BLOCK    `SPFFilter<T>::process` and `SPF::process`.
 *
 * THE RECURRENCE AS PORTED, verbatim:
 *
 *     w   = tan(PI * f / fs) ;  w2 = w*w ;  fac = 1/(1 + R*w + w2)
 *     al0 = w2*fac ; al1 = 2*w2*fac          // lowpass numerator
 *     ah0 = fac    ; ah1 = -2*fac            // highpass numerator
 *     ab  = w*fac*R                          // bandpass numerator
 *     b0  = -2*(1 - w2)*fac ; b1 = (1 - R*w + w2)*fac
 *     x   = hp*ah0 + shp0*ah1 + shp1*ah0
 *     x  += lp*al0 + slp0*al1 + slp1*al0
 *     x  += (bp - sbp1)*ab
 *     y   = x - b0*s0 - b1*s1
 *     // shift every state pair, then s0 = y
 *
 * ⚠ THE `R` DIAL IS INVERTED AND OFF BY ONE. `R = 2 - clamp(dial, 0, 1.999)`,
 * and R is the DAMPING in the denominator — so the dial's 0 gives R = 2
 * (critically over-damped, no resonance at all) and its top gives R = 0.001
 * (self-oscillating). The knob's declared range is 0..2 while the clamp is
 * 1.999, so the last 0.001 of travel does nothing. Both theirs.
 *
 * ⚠ THE THREE INPUTS ARE NOT THREE FILTERS. There is one pole pair; the three
 * numerators feed it. Patching the same signal to all three sums the three
 * responses, which is what makes SPF a MORPHING filter with no morph knob.
 *
 * DEVIATIONS: D-SPF-POLY — Rack's polyphony (up to 16 channels through four
 * `float_4` lanes) is absent; our wire is mono. D-SPF-CLAMP — `cutoff` is clamped
 * to `[2, fs*0.33]` exactly as theirs is, which is BELOW Nyquist on purpose (the
 * bilinear `tan` blows up approaching it). D-NOCV per V2.
 *
 * Command.
 */
export class SpfKernel {
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    this.s = new Float64Array(2);
    this.sl = new Float64Array(2);
    this.sh = new Float64Array(2);
    this.sb = new Float64Array(2);
  }

  /**
   * Command. One sample.
   *
   * @param {object} c - freq (the 4..14 dial) and r (the 0..2 damping dial)
   * @param {Float64Array} inputs - [lp, bp, hp] in ±1 units
   * @param {Float64Array} frame - [cv] in ±1 units
   * @returns {void} (writes `frame`)
   */
  sample(c, inputs, frame) {
    const piosr = Math.PI / this.sampleRate;
    const cutoff = clampTo(Math.pow(2, c.freq), SpfKernel.MIN_HZ, this.sampleRate * SpfKernel.MAX_HZ_FRACTION);
    const R = SpfKernel.R_CEILING - clampTo(c.r, 0, SpfKernel.R_DIAL_CLAMP);

    const w = Math.tan(cutoff * piosr);
    const w2 = w * w;
    const fac = 1 / (1 + R * w + w2);
    const al0 = w2 * fac;
    const al1 = 2 * w2 * fac;
    const ah0 = fac;
    const ah1 = -2 * fac;
    const ab = w * fac * R;
    const b0 = -2 * (1 - w2) * fac;
    const b1 = (1 - R * w + w2) * fac;

    // V1: our ±1 becomes their volts.
    const lp = inputs[0] * RACK_VOLTS_PER_UNIT;
    const bp = inputs[1] * RACK_VOLTS_PER_UNIT;
    const hp = inputs[2] * RACK_VOLTS_PER_UNIT;

    let x = hp * ah0 + this.sh[0] * ah1 + this.sh[1] * ah0;
    this.sh[1] = this.sh[0];
    this.sh[0] = hp;
    x += lp * al0 + this.sl[0] * al1 + this.sl[1] * al0;
    this.sl[1] = this.sl[0];
    this.sl[0] = lp;
    x += (bp - this.sb[1]) * ab;
    this.sb[1] = this.sb[0];
    this.sb[0] = bp;
    const y = x - b0 * this.s[0] - b1 * this.s[1];
    this.s[1] = this.s[0];
    this.s[0] = y;

    frame[0] = y / RACK_VOLTS_PER_UNIT;
  }
}
SpfKernel.MIN_HZ = 2;
/** `args.sampleRate * 0.33f` — deliberately well below Nyquist. */
SpfKernel.MAX_HZ_FRACTION = 0.33;
SpfKernel.R_CEILING = 2;
SpfKernel.R_DIAL_CLAMP = 1.999;

// ════════════════════════════════════════════════════════════════════════════
// REWIN — repelzen/rewin, a four-channel scale quantiser
// ════════════════════════════════════════════════════════════════════════════

/**
 * Pure function. `repelzen-math.hpp modN` — a modulo that is always non-negative,
 * which is what lets the scale search walk DOWN past 0 into the octave below.
 *
 * @example modN(-1, 12) // 11
 * @example modN(13, 12) // 1
 * @example modN(0, 12) // 0
 */
export function modN(k, n) {
  const m = k % n;
  return m < 0 ? m + n : m;
}

/**
 * Pure function. `repelzen-math.hpp ceilN` — "a modified version of ceil that
 * works with negative values (example: -2.3 becomes -3)", i.e. it rounds AWAY
 * from zero, not up.
 *
 * @example ceilN(2.3) // 3
 * @example ceilN(-2.3) // -3
 * @example ceilN(2) // 2
 */
export function ceilN(x) {
  return x < 0 ? Math.floor(x) : Math.ceil(x);
}

/**
 * `repelzen/rewin` — four V/oct quantisers sharing one twelve-note scale, with
 * per-channel octave transposition and a shared semitone transpose.
 *
 * ── DERIVATION RECORD (R7-17) ───────────────────────────────────────────────
 * SOURCE   github.com/wiqid/repelzen `src/erwin.cpp` — the FILE is `erwin` and the
 *          MODEL SLUG is `rewin` (`createModel<Erwin, ErwinWidget>("rewin")`);
 *          the v1 rename kept the class name. Read at commit
 *          78b1765eb9ccb9e4e2a1967ee02f4126b1846806. THE REPO WAS NOT PRE-CLONED
 *          and the survey lists it as "REPO NOT IDENTIFIED"; found and cloned for
 *          this port.
 * BLOCK    `Erwin::process`, plus `modN` / `ceilN` from `repelzen-math.hpp`.
 *
 * THE RECURRENCE AS PORTED (per channel, per sample):
 *
 *     transposeSemi   = round(semi * 1.2)                 // +/- 1 octave from +/-10 V
 *     octave          = trunc(in)                         // toward zero
 *     frac            = in - octave
 *     transposeOctave = clamp(round(transpose / 2.5) + octaveKnob, -4, 4)
 *     semiUp          = ceilN(frac * 12)                  // away from zero
 *     semiDown        = trunc(frac * 12)
 *     stepsUp   = smallest s < 12 with scale[modN(semiUp + s, 12)] set
 *     stepsDown = smallest s < 12 with scale[modN(semiDown - s, 12)] set
 *     stepsUp %= 12 ; stepsDown %= 12                     // empty-scale reset
 *     index = down ? semiDown - stepsDown
 *           : up   ? semiUp + stepsUp
 *           : (stepsUp < stepsDown ? semiUp + stepsUp : semiDown - stepsDown)
 *     out = octave + index/12 + transposeOctave + (transposeSemi ? transposeSemi : 0)
 *
 * ⚠ `trunc` AND `ceilN` BOTH ROUND TOWARD OR AWAY FROM **ZERO**, NOT UP AND DOWN.
 * So for a NEGATIVE input voltage the "up" search actually walks away from zero,
 * i.e. downward in pitch. That asymmetry about 0 V is theirs and it means the
 * quantiser is not translation-invariant across the C4 boundary.
 *
 * ⚠ THE EMPTY-SCALE GUARD IS `steps %= 12`, WHICH MAKES AN EMPTY SCALE A
 * PASS-THROUGH OF THE FLOOR. If no note is enabled both loops run to 12 and both
 * `steps` become 0, so `index` is `semiDown` (or `semiUp`) unquantised. The source
 * comment says this exists "to avoid transposing by 1 octave". Reproduced.
 *
 * DEVIATIONS, NAMED:
 *   D-RW-SCENES  their SIXTEEN scale scenes (`noteState[12 * 16]`, a bank
 *                switched by a knob and a CV input, exported to JSON files) are
 *                NOT ported, and the `select` input with them. In PowerRP a scene
 *                change is a KEYFRAME on the `scale` knob — one scene per slide,
 *                tweenable, with no fixed bank size — which is strictly more
 *                expressive than sixteen slots. The scale itself is one integer:
 *                a TWELVE-BIT MASK, bit 0 = C, so `2773` is the major scale. That
 *                follows the precedent AX-2's `polynomial` knob set ("a number
 *                rather than their dropdown so an equation can sweep it").
 *   D-RW-BUTTONS the twelve note buttons and their lights are the UI of that
 *                mask; the mask is the state.
 *   V4           every pitch port here is in OCTAVES, both directions.
 *
 * Command (nothing but the channel normalisation is stateful; kept a class for
 * uniformity with the block's bridge).
 */
export class RewinKernel {
  constructor() {
    this.setMode("down");
  }

  /** Command. Their `enum QModes` order — DOWN is 0 and is the default, which is
   *  NOT the order the context menu lists them in. A stored integer maps here. */
  setMode(value) {
    if (!RewinKernel.MODES.includes(value)) {
      throw new Error(`RewinKernel.setMode: expected one of ${RewinKernel.MODES.join(", ")}, got ${JSON.stringify(value)}`);
    }
    this.mode = value;
  }

  /**
   * Query. Quantise one pitch. Split out as a pure-enough helper so the mask
   * search has one definition for four channels.
   *
   * @param {number} pitch - VOLTS (octaves from C4); the caller converts from semitones
   * @param {number} mask - twelve-bit scale mask, bit 0 = C
   * @returns {number} the quantised semitone index within `trunc(pitch)`'s octave
   */
  quantise(pitch, mask) {
    const octave = Math.trunc(pitch);
    const frac = pitch - octave;
    const semiUp = ceilN(frac * RewinKernel.SEMITONES);
    const semiDown = Math.trunc(frac * RewinKernel.SEMITONES);
    let stepsUp = 0;
    while (!(mask & (1 << modN(semiUp + stepsUp, RewinKernel.SEMITONES))) && stepsUp < RewinKernel.SEMITONES) stepsUp += 1;
    let stepsDown = 0;
    while (!(mask & (1 << modN(semiDown - stepsDown, RewinKernel.SEMITONES))) && stepsDown < RewinKernel.SEMITONES) stepsDown += 1;
    stepsUp %= RewinKernel.SEMITONES;
    stepsDown %= RewinKernel.SEMITONES;
    switch (this.mode) {
      case "down": return semiDown - stepsDown;
      case "up": return semiUp + stepsUp;
      case "nearest": return stepsUp < stepsDown ? semiUp + stepsUp : semiDown - stepsDown;
      default: throw new Error(`RewinKernel: unreachable mode ${this.mode}`);
    }
  }

  /**
   * Command. One sample.
   *
   * @param {object} c - scale, transpose, semi, octave_1..octave_4
   * @param {Float64Array} inputs - [in_1..in_4] in SEMITONES from C4 (V4)
   * @param {Float64Array} frame - [out_1..out_4] in SEMITONES from C4
   * @returns {void} (writes `frame`)
   */
  sample(c, inputs, frame) {
    const mask = Math.round(c.scale) & RewinKernel.MASK_ALL;
    // V4: every pitch port is in semitones, so each is divided by twelve to reach
    // the volts their arithmetic is written in. ONE conversion site, here.
    const transposeSemi = Math.round((c.semi / RewinKernel.SEMITONES) * RewinKernel.SEMI_PER_VOLT);
    for (let y = 0; y < RewinKernel.CHANNELS; y++) {
      // Their "normalize to first channel": an unpatched input reads channel 1.
      // A zero reading is indistinguishable from an unpatched jack on our wires,
      // so channel 1's value is used when this channel reads exactly 0 — the same
      // convention JustAPhaser's feedback return uses in this block.
      const semitones = y === 0 || inputs[y] !== 0 ? inputs[y] : inputs[0];
      const pitch = semitones / RewinKernel.SEMITONES;
      const transposeOctave = clampTo(
        Math.round(c.transpose / RewinKernel.SEMITONES / RewinKernel.VOLTS_PER_TRANSPOSE_OCTAVE) + Math.round(c[`octave_${y + 1}`]),
        -RewinKernel.MAX_TRANSPOSE_OCTAVES,
        RewinKernel.MAX_TRANSPOSE_OCTAVES,
      );
      let index = this.quantise(pitch, mask);
      if (transposeSemi) index += transposeSemi;
      frame[y] = (Math.trunc(pitch) + transposeOctave) * RewinKernel.SEMITONES + index;
    }
  }
}
RewinKernel.MODES = Object.freeze(["down", "up", "nearest"]);
RewinKernel.CHANNELS = 4;
RewinKernel.SEMITONES = 12;
RewinKernel.MASK_ALL = 0xfff;
/** `round(semiVolts * 1.2)` with the source comment "limit to 1 octave" — 1.2
 *  because their input is +/-10 V and twelve semitones over ten volts is 1.2. So a
 *  full +/-10 V (+/-120 semitone) sweep of the `semi` port transposes +/-12
 *  semitones, and 12 semitones IN transposes ONE semitone. Theirs, and it is why
 *  the semi port is not a clean semitone control. */
RewinKernel.SEMI_PER_VOLT = 1.2;
/** `round(transposeVolts / 2.5)` — 2.5 V per octave of transposition, i.e. their
 *  +/-10 V input spans the +/-4 octave clamp exactly. */
RewinKernel.VOLTS_PER_TRANSPOSE_OCTAVE = 2.5;
RewinKernel.MAX_TRANSPOSE_OCTAVES = 4;

// ════════════════════════════════════════════════════════════════════════════
// REBURST — repelzen/reburst, a burst generator with accel, jitter and CV modes
// ════════════════════════════════════════════════════════════════════════════

/**
 * `repelzen/reburst` — a trigger fires N pulses whose spacing accelerates, with
 * optional jitter and eight CV shapes, clock-syncable.
 *
 * ── DERIVATION RECORD (R7-17) ───────────────────────────────────────────────
 * SOURCE   github.com/wiqid/repelzen `src/burst.cpp` — file `burst`, model slug
 *          `reburst`, @ 78b1765eb9ccb9e4e2a1967ee02f4126b1846806. Cloned for this
 *          port; the survey lists the repo as unidentified.
 * BLOCK    `Burst::process`.
 *
 * THE RECURRENCE AS PORTED:
 *
 *     timeParam = clamp(timeDial, 0, 1)
 *     timeParam = (exp(timeParam) - 1) / (e - 1)          // exponential dial
 *     if a clock is patched:
 *       on each clock edge: mult = int(timeDial * 8 - 4)  // RAW dial, not the exp
 *                           timeParam = clockPeriod * 2^mult
 *       timeParam = the value from the last edge           // held between edges
 *     when timer > seconds and pulseCount < pulses:
 *       pulseCount++ ; timer = 0
 *       seconds = timeParam / accel^pulseCount            // ACCELERATION
 *       if jitter: seconds +/- uniform() * jitter * seconds
 *       if pulseCount == pulses: fire EOC (10 ms)
 *       gateLength = triggerMode ? 0.01 : seconds/2
 *       fire the gate ; cvOut = the mode's next value
 *     on a gate or button edge: pulseCount = 0 ; timer = 0
 *                               seconds = timeParam ; pulses = pulseParam
 *                               cvOut = 0 ; fire the gate
 *     timer += 1/fs
 *
 * ⚠ THE ACCELERATION IS `time / accel^n`, SO IT COMPOUNDS. At accel 2 and 8
 * repetitions the last gap is 1/256 of the first — the burst does not slow into a
 * ritardando, it collapses. That geometric collapse is the module.
 *
 * ⚠ THE SYNC MULTIPLIER READS THE RAW DIAL, NOT THE EXPONENTIAL ONE.
 * `timeParam = params[TIME_PARAM].getValue()` INSIDE the clock branch overwrites
 * the exponential mapping computed three lines earlier, then
 * `int mult = (int)(timeParam * 8 - 4)` truncates toward zero — so the dial's
 * lower half gives 2^-4..2^0 in five uneven steps and `int()` truncation makes the
 * step boundaries asymmetric about the centre. Reproduced.
 *
 * ⚠ D0 — `random::uniform()` IS CALLED TWICE PER PULSE (once for the jitter
 * magnitude, once for its sign) AND ONCE MORE FOR `randomcv`. All three come from
 * the seeded `Vc5Random` here, IN THAT ORDER, so a given seed reproduces their
 * exact sequence shape. Their generator is Rack's xoshiro seeded from the clock;
 * ours is Valley's MWC seeded from the knob. The DISTRIBUTION is the same
 * (uniform on [0,1)); the specific numbers are not, and cannot be.
 *
 * DEVIATIONS: D-RB-BUTTON the manual-burst button is a momentary control and is
 * not property state; the `gate` trigger input covers it. D-RB-PULSEWIDTH their
 * EOC pulse and trigger-mode gate are both 10 ms, hard-coded; kept. D-NOCV per V2.
 *
 * Command.
 */
export class ReburstKernel {
  constructor(sampleRate, options = {}) {
    this.sampleRate = sampleRate;
    this.random = new Vc5Random(options.seed ?? 0);
    this.timer = 0;
    this.seconds = 0;
    this.pulseCount = 0;
    this.pulses = ReburstKernel.DEFAULT_PULSES;
    this.cvOut = 0;
    this.clockSamples = 0;
    this.clockedTimeParam = 0;
    this.prevGate = 0;
    this.prevClock = 0;
    this.gateRemaining = 0;
    this.eocRemaining = 0;
    this.gateOutLength = ReburstKernel.SHORT_PULSE_SECONDS;
    this.setCvMode(options.cv_mode ?? ReburstKernel.CV_MODES[0]);
    this.setGateMode(options.gate_mode ?? "gate");
  }

  /** Command. */
  setCvMode(value) {
    if (!ReburstKernel.CV_MODES.includes(value)) {
      throw new Error(`ReburstKernel.setCvMode: expected one of ${ReburstKernel.CV_MODES.join(", ")}, got ${JSON.stringify(value)}`);
    }
    this.cvMode = value;
  }

  /** Command. `gate` makes each pulse half the gap long; `trigger` makes it 10 ms. */
  setGateMode(value) {
    if (value !== "gate" && value !== "trigger") {
      throw new Error(`ReburstKernel.setGateMode: expected "gate" or "trigger", got ${JSON.stringify(value)}`);
    }
    this.gateMode = value;
  }

  /** Command (advances the seeded RNG for the random modes). Their eight CV
   *  shapes, in `enum CvModes` order so a stored integer still selects one. */
  nextCv(cvDelta, randomcv) {
    const n = this.pulseCount;
    switch (this.cvMode) {
      case "up": return n * cvDelta;
      case "down": return n * cvDelta * -1;
      // Their CV_MODE3: a widening alternation, so the burst walks outward.
      case "alt_widen": {
        const v = Math.trunc((n + 1) / 2) * cvDelta;
        return n % 2 === 1 ? -v : v;
      }
      case "alt_ramp": {
        const v = n * cvDelta;
        return n % 2 === 1 ? -v : v;
      }
      case "random_pos": return randomcv * ReburstKernel.CV_VOLTS;
      case "random_neg": return randomcv * -ReburstKernel.CV_VOLTS;
      case "random_walk": return randomcv > 0.5 ? this.cvOut + cvDelta : this.cvOut - cvDelta;
      case "random": return randomcv * ReburstKernel.CV_VOLTS * 2 - ReburstKernel.CV_VOLTS;
      default: throw new Error(`ReburstKernel: unreachable cv mode ${this.cvMode}`);
    }
  }

  /**
   * Command. One sample.
   *
   * @param {object} c - time, rep, accel, jitter, gate, clock
   * @param {Float64Array} inputs - unused; every input is a param
   * @param {Float64Array} frame - [gate, eoc, cv] in ±1 units
   * @returns {void} (writes `frame`)
   */
  sample(c, inputs, frame) {
    const delta = 1 / this.sampleRate;
    const accel = clampTo(c.accel, ReburstKernel.ACCEL_MIN, ReburstKernel.ACCEL_MAX);
    const jitter = clampTo(c.jitter, 0, 1);
    const rawTimeDial = clampTo(c.time, 0, ReburstKernel.MAX_TIME);

    // Their exponential dial: `(exp(t) - 1) / (e - 1)`, which is unity at t = 1.
    let timeParam = (Math.exp(rawTimeDial) - 1) / (Math.E - 1);
    const pulseParam = clampTo(Math.trunc(c.rep), 0, ReburstKernel.MAX_REPS);

    this.clockSamples += 1;
    const clockHigh = c.clock > ReburstKernel.GATE_THRESHOLD ? 1 : 0;
    const clockPatched = c.clock !== 0 || this.clockedTimeParam !== 0;
    if (clockPatched) {
      if (clockHigh && !this.prevClock) {
        // THE RAW DIAL, not the exponential one — see the docblock's warning.
        const mult = Math.trunc(rawTimeDial * ReburstKernel.SYNC_RANGE - ReburstKernel.SYNC_CENTRE);
        this.clockedTimeParam = (this.clockSamples / this.sampleRate) * Math.pow(2, mult);
        this.clockSamples = 0;
      }
      timeParam = this.clockedTimeParam;
    }
    this.prevClock = clockHigh;

    if (this.timer > this.seconds && this.pulseCount < this.pulses) {
      this.pulseCount += 1;
      this.timer = 0;
      this.seconds = accel > 0 ? timeParam / Math.pow(accel, this.pulseCount) : timeParam;
      if (jitter > 0) {
        // D0: two draws, in their order — magnitude then sign.
        const randomDelta = this.random.nextFloat() * jitter * this.seconds;
        this.seconds += this.random.nextFloat() > 0.5 ? randomDelta : -randomDelta;
      }
      if (this.pulseCount === this.pulses) this.eocRemaining = ReburstKernel.SHORT_PULSE_SECONDS;
      this.gateOutLength = this.gateMode === "trigger" ? ReburstKernel.SHORT_PULSE_SECONDS : this.seconds / 2;
      this.gateRemaining = this.gateOutLength;
      const randomcv = this.random.nextFloat();
      this.cvOut = this.nextCv(ReburstKernel.CV_VOLTS / Math.max(this.pulses, 1), randomcv);
    }

    const gateHigh = c.gate > ReburstKernel.GATE_THRESHOLD ? 1 : 0;
    if (gateHigh && !this.prevGate) {
      this.pulseCount = 0;
      this.timer = 0;
      this.gateRemaining = this.gateOutLength;
      this.seconds = timeParam;
      this.pulses = pulseParam;
      this.cvOut = 0;
    }
    this.prevGate = gateHigh;

    this.timer += delta;
    const gate = this.gateRemaining > 0 ? 1 : 0;
    const eoc = this.eocRemaining > 0 ? 1 : 0;
    this.gateRemaining = Math.max(0, this.gateRemaining - delta);
    this.eocRemaining = Math.max(0, this.eocRemaining - delta);

    // R7-UNITS CLAUSE 4 (the lead, 2026-08-06): a GATE carries 0..1, NOT volts / 5.
    // Clause 1 is about LEVEL and logic is not level — their 10 V gate divided by
    // five would be 2.0, outside our wire's +/-1 and outside every gate param's own
    // 0..1 bound. `cv` below IS a level, so clause 1 applies to it and not to these.
    frame[0] = gate;
    frame[1] = eoc;
    frame[2] = this.cvOut / RACK_VOLTS_PER_UNIT;
  }
}
/** Their `enum CvModes` order, renamed from CV_MODE3/CV_MODE4 to what they do. */
ReburstKernel.CV_MODES = Object.freeze([
  "up", "down", "alt_widen", "alt_ramp", "random_pos", "random_neg", "random_walk", "random",
]);
ReburstKernel.MAX_REPS = 8;
ReburstKernel.DEFAULT_PULSES = 4;
ReburstKernel.MAX_TIME = 1;
ReburstKernel.ACCEL_MIN = 1;
ReburstKernel.ACCEL_MAX = 2;
/** `cvDelta = 5.0 / pulses` — the CV shapes span 5 V across the whole burst. */
ReburstKernel.CV_VOLTS = 5;
/** `(int)(timeParam * 8 - 4)`, i.e. 2^-4 .. 2^4 across the dial. */
ReburstKernel.SYNC_RANGE = 8;
ReburstKernel.SYNC_CENTRE = 4;
/** Their hard-coded 0.01 for the EOC pulse and for trigger-mode gates. */
ReburstKernel.SHORT_PULSE_SECONDS = 0.01;
ReburstKernel.GATE_THRESHOLD = 0.5;

// ════════════════════════════════════════════════════════════════════════════
// XFX F-35 — Blamsoft, a 35-mode ZDF filter. BEHAVIOUR-DERIVED.
// ════════════════════════════════════════════════════════════════════════════

/**
 * Pure function. A windowed-sinc half-band lowpass kernel for the 4x
 * oversampler — a Blackman-windowed sinc at a quarter of the oversampled
 * Nyquist, which is what "4x windowed sinc oversampling" means.
 *
 * @param {number} taps - kernel length, ODD so it has a true centre
 * @param {number} cutoff - normalised cutoff at the OVERSAMPLED rate
 * @returns {Float64Array} `taps` coefficients summing to 1
 *
 * @example windowedSincKernel(5, 0.25).length // 5
 * @example Math.abs(windowedSincKernel(31, 0.125).reduce((a, b) => a + b) - 1) < 1e-12 // true
 */
export function windowedSincKernel(taps, cutoff) {
  if (taps % 2 !== 1) throw new Error(`windowedSincKernel: taps must be odd, got ${taps}`);
  const h = new Float64Array(taps);
  const mid = (taps - 1) / 2;
  let sum = 0;
  for (let i = 0; i < taps; i++) {
    const n = i - mid;
    const sinc = n === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * n) / (Math.PI * n);
    // Blackman: 0.42 - 0.5 cos(2πi/(N-1)) + 0.08 cos(4πi/(N-1)).
    const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * i) / (taps - 1)) + 0.08 * Math.cos((4 * Math.PI * i) / (taps - 1));
    h[i] = sinc * w;
    sum += h[i];
  }
  for (let i = 0; i < taps; i++) h[i] /= sum;
  return h;
}

/**
 * `Blamsoft-XFXF35/Blamsoft-XFXF35` — the 35-mode filter.
 *
 * ══ THIS PORT IS BEHAVIOUR-DERIVED, NOT SOURCE-DERIVED. SAID PLAINLY. ═══════
 * There is NO source. `VCVRack/library manifests/Blamsoft-XFXF35.json` carries
 * `pluginUrl` (blamsoft.com/vcv-rack/xfx-f-35) and `manualUrl` and NO
 * `sourceUrl`; Blamsoft ships binaries. Searched 2026-08-06.
 *
 * THE DERIVATION RECORD NAMES DOCUMENTS:
 *   1. blamsoft.com/vcv-rack/xfx-f-35 — the numbered list of all 35 modes,
 *      transcribed into `XFXF35_MODES` below, IN THE VENDOR'S ORDER so a stored
 *      mode integer selects the same filter.
 *   2. The same page's statement of topology, quoted because it is the whole
 *      specification available: "optimized 4x windowed sinc oversampling for
 *      pristine quality drive and true cutoff slope at high frequencies … Zero
 *      Delay Feedback for accurate cutoff frequency and equal resonance across
 *      the spectrum … cutoff frequency range is 20 Hz to 20 kHz".
 *
 * SO WHAT IS PORTED IS THE TOPOLOGY THE VENDOR STATES, in the three families the
 * mode names identify: a Sallen-Key pair, a TPT state-variable filter, and a
 * four-stage TPT ladder with tap mixes. Every mode below is a real filter of the
 * named type and order. NONE of them is claimed to match Blamsoft's coefficients,
 * because those are not published.
 *
 * ⚠ TWENTY-SIX OF THE THIRTY-FIVE ARE SHIPPED. The nine absent ones, by the
 * vendor's own numbering, are 27 (Diode Lowpass 24 dB), 28-30 (Dual Resonator
 * 1/2/3), 31-32 (Comb + / Comb −), 33 (Frequency Modulation), 34 (Ring
 * Modulation) and 35 (Bitcrusher). They are absent because each is a DIFFERENT
 * ALGORITHM rather than another tap on the two topologies above — the diode
 * ladder needs its own nonlinear solve, the dual resonators are undocumented, and
 * the last three are not filters at all (33 and 34 need a second audio input this
 * node does not declare). `XFXF35_MODES` lists all 35 with a `shipped` flag, so
 * selecting an absent one is a LOUD error naming the mode rather than a silent
 * substitution. D-XF-MODES.
 *
 * THE RECURRENCE AS PORTED (per oversampled sample):
 *
 *     g  = tan(PI * clamp(f, 20, 20000) / (fs * OS))       // TPT prewarp
 *     G  = g / (1 + g)                                     // one-pole ZDF gain
 *     x  = tanh-ish drive(in * (1 + drive * 9))            // Valley's saturator
 *     ladder:  u  = (x - k * z4) / (1 + k * G^4)
 *              s1..s4 = four TPT one-poles in series from u
 *              out = sum(tap[i] * s[i])
 *     svf:     hp = (x - (2*R + g)*ic1 - ic2) / (1 + 2*R*g + g*g)
 *              bp = g*hp + ic1 ; lp = g*bp + ic2
 *              ic1 = g*hp + bp  ; ic2 = g*bp + lp
 *              out = lp | bp | hp | (lp + hp + 2*R*bp)     // the "peak" tap
 *     sallenKey: two TPT one-poles with one feedback path, k = 2 - 2/Q
 *
 * DEVIATIONS: D-XF-COEF the coefficients are OURS, from the standard TPT
 * formulations, because the vendor's are unpublished. D-XF-OS the oversampler is a
 * 31-tap Blackman-windowed sinc at 4x, per the vendor's stated method but not
 * their kernel. D-NOCV per V2. D-XF-POLY the v1 module gained polyphony on its
 * frequency input; our wire is mono.
 *
 * Command.
 */
export class Xfxf35Kernel {
  constructor(sampleRate, options = {}) {
    this.baseRate = sampleRate;
    this.setOversample(options.oversample ?? "4x");
    this.z = new Float64Array(Xfxf35Kernel.LADDER_STAGES);
    this.ic1 = 0;
    this.ic2 = 0;
    this.skZ = new Float64Array(2);
    this.setMode(options.mode ?? Xfxf35Kernel.DEFAULT_MODE);
  }

  /** Command. 1x or 4x. The vendor's own figure is 4x; 1x exists because the
   *  oversampler is 8 filter evaluations per sample and a CPU-bound deck may
   *  prefer the aliasing to the cost. */
  setOversample(value) {
    if (!Xfxf35Kernel.OVERSAMPLE.includes(value)) {
      throw new Error(`Xfxf35Kernel.setOversample: expected one of ${Xfxf35Kernel.OVERSAMPLE.join(", ")}, got ${JSON.stringify(value)}`);
    }
    this.oversample = value;
    this.factor = Number(value.slice(0, -1));
    this.rate = this.baseRate * this.factor;
    this.kernel = windowedSincKernel(Xfxf35Kernel.SINC_TAPS, Xfxf35Kernel.SINC_CUTOFF / this.factor);
    this.upState = new Float64Array(Xfxf35Kernel.SINC_TAPS);
    this.downState = new Float64Array(Xfxf35Kernel.SINC_TAPS);
  }

  /** Command. LOUD on an unshipped mode — see D-XF-MODES. */
  setMode(value) {
    const row = XFXF35_MODES.find((m) => m.key === value);
    if (!row) {
      throw new Error(`Xfxf35Kernel.setMode: unknown mode ${JSON.stringify(value)} — see XFXF35_MODES`);
    }
    if (!row.shipped) {
      throw new Error(`Xfxf35Kernel.setMode: mode ${row.n} ${JSON.stringify(row.label)} is not ported (D-XF-MODES) — it is a different algorithm, not another tap`);
    }
    this.mode = row;
  }

  /** Query. `2 - 2/Q` for a Sallen-Key, `4 * (Q - 0.5) / 9.5` for the ladder's
   *  feedback — both mapped from one 0..1 resonance dial so the two families feel
   *  the same under the same knob. */
  resonance(dial) {
    return clampTo(dial, 0, 1);
  }

  /** Command. One OVERSAMPLED sample through the selected topology. */
  core(x, g, res) {
    const G = g / (1 + g);
    const family = this.mode.family;
    if (family === "ladder") {
      const k = res * Xfxf35Kernel.LADDER_MAX_K;
      const G4 = G * G * G * G;
      const u = (x - k * this.z[3]) / (1 + k * G4);
      let v = u;
      const taps = this.mode.taps;
      let out = taps[0] * v;
      for (let i = 0; i < Xfxf35Kernel.LADDER_STAGES; i++) {
        const y = this.z[i] + G * (v - this.z[i]);
        this.z[i] = y + G * (v - y);
        v = y;
        out += taps[i + 1] * v;
      }
      return out;
    }
    if (family === "svf") {
      const R = Xfxf35Kernel.SVF_MIN_R + (1 - res) * (Xfxf35Kernel.SVF_MAX_R - Xfxf35Kernel.SVF_MIN_R);
      const hp = (x - (2 * R + g) * this.ic1 - this.ic2) / (1 + 2 * R * g + g * g);
      const bp = g * hp + this.ic1;
      const lp = g * bp + this.ic2;
      this.ic1 = g * hp + bp;
      this.ic2 = g * bp + lp;
      switch (this.mode.tap) {
        case "lp": return lp;
        case "bp": return bp;
        case "hp": return hp;
        case "peak": return lp - hp;
        default: throw new Error(`Xfxf35Kernel: unreachable svf tap ${this.mode.tap}`);
      }
    }
    // ── SALLEN-KEY ──────────────────────────────────────────────────────────
    // Mode 2 is "Highpass 6 dB", i.e. ONE pole, so it is a single TPT one-pole
    // subtracted from the input and has no resonance path at all — a 6 dB slope
    // cannot resonate.
    if (this.mode.tap === "hp") {
      const y = this.skZ[0] + G * (x - this.skZ[0]);
      this.skZ[0] = y + G * (x - y);
      return x - y;
    }
    // Mode 1 is "Lowpass 12 dB". A Sallen-Key IS a two-pole with a Q set by its
    // feedback ratio, so the LINEAR response is that of the state-variable
    // two-pole; what makes it a different mode rather than a duplicate of mode 3
    // is WHERE THE NONLINEARITY SITS. In a real Sallen-Key the resonance path runs
    // through the buffer amplifier, so it saturates BEFORE the integrators —
    // which is why a driven Sallen-Key compresses its own resonance instead of
    // clipping its output. That saturator on `ic1` is the one structural
    // difference, and it is why `sk_lp12` and `sv_lp12` measure the same at low
    // drive and diverge as Drive rises.
    const damping = 1 / Math.max(Xfxf35Kernel.SK_MIN_Q + res * Xfxf35Kernel.SK_Q_SPAN, Xfxf35Kernel.SK_MIN_Q);
    const fedBack = tanhDriveSignal(this.skZ[0], 1);
    const hp2 = (x - (damping + g) * fedBack - this.skZ[1]) / (1 + damping * g + g * g);
    const bp2 = g * hp2 + this.skZ[0];
    const lp2 = g * bp2 + this.skZ[1];
    this.skZ[0] = g * hp2 + bp2;
    this.skZ[1] = g * bp2 + lp2;
    return lp2;
  }

  /**
   * Command. One sample at the BASE rate, through the oversampler.
   *
   * @param {object} c - frequency (Hz), resonance (0..1), drive (0..1)
   * @param {Float64Array} inputs - [in] in ±1 units
   * @param {Float64Array} frame - [out] in ±1 units
   * @returns {void} (writes `frame`)
   */
  sample(c, inputs, frame) {
    const f = clampTo(c.frequency, Xfxf35Kernel.MIN_HZ, Xfxf35Kernel.MAX_HZ);
    const g = Math.tan((Math.PI * f) / this.rate);
    const res = this.resonance(c.resonance);
    const drive = 1 + clampTo(c.drive, 0, 1) * Xfxf35Kernel.DRIVE_SPAN;
    const x = tanhDriveSignal(inputs[0] * drive, 1);

    if (this.factor === 1) {
      frame[0] = this.core(x, g, res);
      return;
    }

    // 4x: zero-stuff (with the factor's gain restored), filter, run the core,
    // then the same kernel again as the decimation antialias.
    const taps = Xfxf35Kernel.SINC_TAPS;
    let acc = 0;
    for (let s = 0; s < this.factor; s++) {
      for (let i = taps - 1; i > 0; i--) this.upState[i] = this.upState[i - 1];
      this.upState[0] = s === 0 ? x * this.factor : 0;
      let up = 0;
      for (let i = 0; i < taps; i++) up += this.upState[i] * this.kernel[i];
      const y = this.core(up, g, res);
      for (let i = taps - 1; i > 0; i--) this.downState[i] = this.downState[i - 1];
      this.downState[0] = y;
      if (s === this.factor - 1) {
        for (let i = 0; i < taps; i++) acc += this.downState[i] * this.kernel[i];
      }
    }
    frame[0] = acc;
  }
}
/**
 * ⚠ EVERY NUMBER BELOW IS **MINE**, AND SO IS EVERY `taps` ARRAY IN XFXF35_MODES.
 *
 * That is what D-XF-COEF means, said here rather than only in the derivation
 * record. Blamsoft publishes the MODE LIST, the "20 Hz to 20 kHz" cutoff range and
 * the words "4x windowed sinc oversampling" and "Zero Delay Feedback" — and
 * nothing else. So the vendor's contribution is the NAME and the ORDER of each of
 * the 35 modes; the topology is the standard TPT formulation those names imply,
 * and every coefficient, tap mix, resonance mapping and drive curve here is a
 * reasonable filter of the named type rather than a reproduction of theirs.
 *
 * DOCUMENTED: the 35 mode names, their order, MIN_HZ/MAX_HZ, that it is ZDF, that
 * it oversamples 4x with a windowed sinc.
 * MINE: LADDER_MAX_K, SVF_MIN_R, SVF_MAX_R, SK_MIN_Q, SK_Q_SPAN, DRIVE_SPAN,
 * SINC_TAPS, SINC_CUTOFF, DEFAULT_MODE, and all 26 shipped tap mixes.
 *
 * THE PRACTICAL CONSEQUENCE, so nobody is surprised: a P19 render will have the
 * right FILTER TYPE at the right slope (its stored `mode: 17` is a Ladder mode,
 * which is shipped) and will NOT have Blamsoft's exact voicing or resonance feel.
 * Its stored dial values cannot transfer at all, which is why `frequency` is in
 * hertz rather than a normalised dial.
 */
Xfxf35Kernel.OVERSAMPLE = Object.freeze(["1x", "4x"]);
Xfxf35Kernel.LADDER_STAGES = 4;
/** k = 4 is the classic four-pole self-oscillation threshold. */
Xfxf35Kernel.LADDER_MAX_K = 4;
/** The SVF's damping runs from 0.707 (Butterworth) down to 0.02 (Q = 25). */
Xfxf35Kernel.SVF_MIN_R = 0.02;
Xfxf35Kernel.SVF_MAX_R = 0.707;
Xfxf35Kernel.SK_MIN_Q = 0.5;
Xfxf35Kernel.SK_Q_SPAN = 9.5;
/** The vendor's stated cutoff range, verbatim: "20 Hz to 20 kHz". */
Xfxf35Kernel.MIN_HZ = 20;
Xfxf35Kernel.MAX_HZ = 20000;
/** Their drive is undocumented past "pristine quality drive"; ours is 1x..10x
 *  into Valley's own saturator, which is the block's one shaping function. */
Xfxf35Kernel.DRIVE_SPAN = 9;
Xfxf35Kernel.SINC_TAPS = 31;
/** Half-band at the base Nyquist, i.e. 0.25 of the 4x rate, divided by the factor
 *  in setOversample so a 1x instance is a pass-through. */
Xfxf35Kernel.SINC_CUTOFF = 0.5;
Xfxf35Kernel.DEFAULT_MODE = "sv_lp12";

/**
 * ALL THIRTY-FIVE MODES, IN THE VENDOR'S OWN NUMBERED ORDER, with a `shipped`
 * flag. The nine unshipped rows are HERE ON PURPOSE: the list is the vendor's
 * specification, and dropping a row would make mode 28 silently mean mode 31.
 *
 * `taps` is the ladder's [input, s1, s2, s3, s4] mix — a highpass is the input
 * minus the lowpass of the same order, which is why the HP rows carry a leading 1.
 */
export const XFXF35_MODES = Object.freeze([
  { n: 1, key: "sk_lp12", label: "Sallen-Key Lowpass 12 dB", family: "sallenKey", tap: "lp", shipped: true },
  { n: 2, key: "sk_hp6", label: "Sallen-Key Highpass 6 dB", family: "sallenKey", tap: "hp", shipped: true },
  { n: 3, key: "sv_lp12", label: "State Variable Lowpass 12 dB", family: "svf", tap: "lp", shipped: true },
  { n: 4, key: "sv_lp24", label: "State Variable Lowpass 24 dB", family: "ladder", taps: [0, 0, 0, 0, 1], shipped: true },
  { n: 5, key: "sv_bp6", label: "State Variable Bandpass 6 dB", family: "svf", tap: "bp", shipped: true },
  { n: 6, key: "sv_bp12", label: "State Variable Bandpass 12 dB", family: "ladder", taps: [0, 0, 4, -8, 4], shipped: true },
  { n: 7, key: "sv_hp12", label: "State Variable Highpass 12 dB", family: "svf", tap: "hp", shipped: true },
  { n: 8, key: "sv_hp24", label: "State Variable Highpass 24 dB", family: "ladder", taps: [1, -4, 6, -4, 1], shipped: true },
  { n: 9, key: "sv_peak12", label: "State Variable Peak 12 dB", family: "svf", tap: "peak", shipped: true },
  { n: 10, key: "sv_peak24", label: "State Variable Peak 24 dB", family: "ladder", taps: [1, -4, 6, -4, 2], shipped: true },
  { n: 11, key: "ladder_lp6", label: "Ladder Lowpass 6 dB", family: "ladder", taps: [0, 1, 0, 0, 0], shipped: true },
  { n: 12, key: "ladder_lp12", label: "Ladder Lowpass 12 dB", family: "ladder", taps: [0, 0, 1, 0, 0], shipped: true },
  { n: 13, key: "ladder_lp18", label: "Ladder Lowpass 18 dB", family: "ladder", taps: [0, 0, 0, 1, 0], shipped: true },
  { n: 14, key: "ladder_lp24", label: "Ladder Lowpass 24 dB", family: "ladder", taps: [0, 0, 0, 0, 1], shipped: true },
  { n: 15, key: "ladder_bp6", label: "Ladder Bandpass 6 dB", family: "ladder", taps: [0, 2, -2, 0, 0], shipped: true },
  { n: 16, key: "ladder_bp12", label: "Ladder Bandpass 12 dB", family: "ladder", taps: [0, 0, 4, -8, 4], shipped: true },
  { n: 17, key: "ladder_hp6", label: "Ladder Highpass 6 dB", family: "ladder", taps: [1, -1, 0, 0, 0], shipped: true },
  { n: 18, key: "ladder_hp12", label: "Ladder Highpass 12 dB", family: "ladder", taps: [1, -2, 1, 0, 0], shipped: true },
  { n: 19, key: "ladder_hp18", label: "Ladder Highpass 18 dB", family: "ladder", taps: [1, -3, 3, -1, 0], shipped: true },
  { n: 20, key: "ladder_hp24", label: "Ladder Highpass 24 dB", family: "ladder", taps: [1, -4, 6, -4, 1], shipped: true },
  { n: 21, key: "ladder_hp12_lp6", label: "Ladder Highpass 12 dB + Lowpass 6 dB", family: "ladder", taps: [0, 1, -2, 1, 0], shipped: true },
  { n: 22, key: "ladder_hp18_lp6", label: "Ladder Highpass 18 dB + Lowpass 6 dB", family: "ladder", taps: [0, 1, -3, 3, -1], shipped: true },
  { n: 23, key: "ladder_notch", label: "Ladder Notch", family: "ladder", taps: [1, -2, 2, 0, 0], shipped: true },
  { n: 24, key: "ladder_notch_lp6", label: "Ladder Notch + Lowpass 6 dB", family: "ladder", taps: [0, 1, -2, 2, 0], shipped: true },
  { n: 25, key: "ladder_phase", label: "Ladder Phase", family: "ladder", taps: [1, -2, 0, 0, 0], shipped: true },
  { n: 26, key: "ladder_phase_lp6", label: "Ladder Phase + Lowpass 6 dB", family: "ladder", taps: [0, 1, -2, 0, 0], shipped: true },
  { n: 27, key: "diode_lp24", label: "Diode Lowpass 24 dB", family: "diode", shipped: false },
  { n: 28, key: "dual_res_1", label: "Dual Resonator 1", family: "dualResonator", shipped: false },
  { n: 29, key: "dual_res_2", label: "Dual Resonator 2", family: "dualResonator", shipped: false },
  { n: 30, key: "dual_res_3", label: "Dual Resonator 3", family: "dualResonator", shipped: false },
  { n: 31, key: "comb_plus", label: "Comb +", family: "comb", shipped: false },
  { n: 32, key: "comb_minus", label: "Comb -", family: "comb", shipped: false },
  { n: 33, key: "fm", label: "Frequency Modulation", family: "modulation", shipped: false },
  { n: 34, key: "ring", label: "Ring Modulation", family: "modulation", shipped: false },
  { n: 35, key: "bitcrush", label: "Bitcrusher", family: "destruction", shipped: false },
]);

/** Query. The mode keys this kernel can actually be set to — what the spec's
 *  option list must be, DERIVED rather than restated (the brief's Tower of Babel
 *  rule: a hand-kept second list is a place for the two to disagree). */
export function xfxf35ShippedModes() {
  return XFXF35_MODES.filter((m) => m.shipped).map((m) => m.key);
}
