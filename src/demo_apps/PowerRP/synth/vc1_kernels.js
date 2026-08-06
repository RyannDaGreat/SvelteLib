/**
 * VC-1 — THE VCV RACK / MUTABLE INSTRUMENTS KERNELS, PORTED TO OUR FLOAT WIRES.
 *
 * ── WHAT THIS FILE IS ───────────────────────────────────────────────────────
 * The DSP of the AudibleInstruments block, and nothing else. No AudioNodes, no
 * AudioWorklet, no DOM: plain ES module, so `tests/port_vc1_test.js` can run every
 * recurrence in BARE NODE and diff it against a transcription of the C++.
 *
 * `worklets/processors_vc1.js` imports this and wraps each kernel in an
 * AudioWorkletProcessor; `modules_vc1.js` wires those into engine modules.
 *
 * ── THE DERIVATION RECORD (R7-17) ───────────────────────────────────────────
 * Sources, cloned READ-ONLY and read at these commits on 2026-08-06:
 *
 *   eurorack           pichenettes/eurorack           @ 08460a69a7e1f7a81c5a2abcc7189c9a6b7208d4
 *   AudibleInstruments VCVRack/AudibleInstruments      @ a1cd335ec6ac44e8be55891854015bf0763f8552
 *   stmlib             pichenettes/stmlib             @ d18def816c51d1da0c108236928b2bbd25c17481
 *
 * `eurorack`'s `stmlib/` directory is an UNPOPULATED SUBMODULE in that clone — every
 * helper the DSP calls (`Interpolate`, `ONE_POLE`, `Svf`, `DelayLine`, `Random`, …)
 * lives in the third repo, which had to be cloned separately. Anyone re-deriving this
 * port will hit the same empty directory; that is why the commit is pinned here.
 *
 * **Mutable's own DSP is the source of the algorithm; AudibleInstruments is the source
 * of the PARAMETER RANGES, the CV scaling and the block sizes.** Both are cited per
 * kernel because a patch's stored knob value only means something through the wrapper.
 *
 * Each kernel's own docblock names its C++ file and function, gives the recurrence in
 * float, and lists the deviations that are ITS OWN. The deviations below are the ones
 * that apply to the WHOLE BLOCK.
 *
 * ── D1. VOLTAGE SCALING — THE ONE DECISION, STATED ONCE ─────────────────────
 * Rack cables are ±5 V nominal / ±10 V max; our `audio` wires are ±1 and our `number`
 * wires carry real units. Three clauses, applied identically to every node here:
 *
 *  1. **An `audio` wire is Rack volts / 5.** So full scale ±1 is Rack's nominal ±5 V.
 *     This is not an arbitrary pick: EVERY AudibleInstruments wrapper already divides
 *     its audio inputs by 5 and multiplies its audio outputs by 5 on the way to and
 *     from Mutable's float DSP (`Clouds.cpp:120`, `Rings.cpp:109`, …). Choosing /5
 *     therefore makes those two conversions the IDENTITY at our boundary: **our wire
 *     IS the Mutable DSP's own internal float.** Any other factor would insert a gain
 *     that exists in neither codebase.
 *  2. **A `number` CV wire is in the KNOB's OWN UNITS and sums with the knob.** Where
 *     a wrapper writes `param + volts / 5`, a wire value of 1.0 is what 5 V was.
 *     Same-units knob-and-input is already this project's convention (OSCILLATOR_SPEC,
 *     and AX-2's deviation D9), and it is what makes "a knob or a wire, your choice"
 *     true with one AudioParam and no conversion node.
 *  3. **A `number` PITCH wire is in SEMITONES: `semitones = 12 · volts`.** Rack's
 *     V/oct is one volt per octave; Mutable's DSP works in semitones and MIDI notes
 *     throughout (`SemitonesToRatio(note - 69) * a3`). Twelve is the only factor that
 *     leaves the module's internal note arithmetic untouched, so each module keeps its
 *     OWN reference rather than being re-based on `dsp::FREQ_C4`. Rings' MIDI note
 *     really is `12 + frequency_knob + wire`, and that is reproduced, not corrected.
 *
 * TO TRANSCRIBE A STORED VCV PATCH VALUE: an audio cable's level needs no change (both
 * ends divide by 5); a CV knob in 0…1 needs no change; a knob the wrapper multiplies by
 * 12 (Clouds' `PITCH_PARAM`, whose stored value is in OCTAVES) must be multiplied by 12,
 * because the knob here is in semitones. Each such factor is named in its spec's `help`.
 *
 * ── D2. THE SAMPLE-RATE CONVERTER IS HERMITE, NOT SPEEX ─────────────────────
 * Clouds' DSP runs at 32 kHz and Rings' at 48 kHz — those rates are baked into their
 * grain-size tables, their delay-line lengths and their filter coefficients, so running
 * them at the browser's rate would change the sound. They are therefore run at their OWN
 * rate and resampled at the boundary. Rack uses `dsp::SampleRateConverter`, a windowed
 * speex resampler; ours is 4-point Hermite (`Resampler` below), the same interpolator
 * Mutable's own delay lines use. NOT MEASURED against speex: the honest statement is
 * that this is a different anti-imaging filter, audible as slightly more high-frequency
 * imaging on fast pitch shifts, and that porting speex was out of this block's budget.
 * At a 48 kHz context Rings' converter is bypassed entirely (ratio exactly 1).
 *
 * ── D3. RANDOMNESS IS THE SOURCE'S OWN LCG, AND IS ALREADY DETERMINISTIC ────
 * `stmlib::Random` is `state = state·1664525 + 1013904223`, `GetFloat() = state/2^32`
 * — a pure LCG with no hardware entropy anywhere (unlike Axoloti's, which AX-2 had to
 * substitute for). So the determinism law costs NOTHING here: the generator is ported
 * exactly and each kernel gets a `seed` knob for its initial state. Rack seeds it once
 * at plugin load and never again, which means a Rack patch is not reproducible across
 * launches and ours is — an improvement, not a deviation to apologise for.
 *
 * ── D4. TRANSCRIBED COEFFICIENTS ARE LEFT AS LITERALS, ON PURPOSE ───────────
 * The house rule is "no magic numbers". It is honoured here for every STRUCTURAL value
 * — rates, block sizes, table sizes, delay-line lengths, mode counts, clamps — which
 * are named constants below. It is deliberately NOT applied to the tuning coefficients
 * inside a transcribed recurrence (`0.625` for the diffuser's allpass gain, `0.85`/`0.15`
 * in Rings' `q_loss`, …). R7-17's stated purpose is *"so we can debug shit and find flaws
 * in the emulation"*: that requires a line of this file to diff against a line of the C++
 * character for character. Renaming `0.85f` to `Q_LOSS_BRIGHTNESS_SPAN` would destroy the
 * one property the derivation record exists to provide, and the reader who wants to know
 * why the number is 0.85 has exactly one true answer — *because Emilie Gillet wrote 0.85*
 * — which no local name can give. Every such literal sits on a line whose comment names
 * the C++ file and line it came from.
 *
 * ── THE KERNEL PROTOCOL, WHICH DIFFERS FROM AX-2's ON PURPOSE ───────────────
 * AX-2's Axoloti kernels are `control()` every 16 samples plus `sample()` per sample,
 * because that is Axoloti's architecture. A Rack module is BLOCK-based: it reads its
 * parameters once and renders N frames at its own internal rate. So a VC-1 kernel is:
 *
 *   static internalRate    Hz the DSP must run at, or null for "the context's rate"
 *   static blockSize       frames per render call at that rate
 *   static channels        {in: 0|1|2, out: 1|2}
 *   constructor(sampleRate, options)
 *   set<Option>(value)     one per discrete/construct knob, per ax2OptionSetter's rule
 *   render(controls, input, output)   COMMAND: one block, interleaved by channel count
 *
 * `processors_vc1.js` owns the ring buffers and the resampling around that call, so no
 * kernel here knows what the browser's sample rate is.
 *
 * Every class below is a COMMAND (it advances its own state) and allocates NOTHING in
 * `render()`, because that runs on the audio thread. The pure helpers above them are
 * labelled individually.
 */

// ── PLATFORM CONSTANTS ──────────────────────────────────────────────────────

/** Rack's nominal cable level, in volts — the divisor deviation D1 clause 1 names. */
export const RACK_NOMINAL_VOLTS = 5;

/** Semitones per octave, i.e. the V/oct → semitones factor of D1 clause 3. */
export const SEMITONES_PER_VOLT = 12;

/** MIDI note whose frequency is A440 — the origin every Mutable `SemitonesToRatio`
 *  call is relative to (`rings/dsp/part.cc:504`: `SemitonesToRatio(note - 69) * a3`). */
export const A3_MIDI_NOTE = 69;

/** A440, in hertz. */
export const A440_HZ = 440;

// ── STMLIB, PORTED ──────────────────────────────────────────────────────────
// stmlib/dsp/dsp.h, stmlib/dsp/filter.h, stmlib/dsp/delay_line.h,
// stmlib/dsp/cosine_oscillator.h, stmlib/dsp/units.h, stmlib/utils/random.h
// @ d18def81. These are the block's shared vocabulary; every kernel below is written
// in them, so a wrong one is wrong in eleven places at once and the test pins each.

/**
 * Pure function. `stmlib::Interpolate` (dsp.h:43) — linear read of a table whose
 * index is a fraction of `size`. TRUNCATING to the integral part, as the C's
 * `static_cast<int32_t>` is.
 *
 * ── THE `fractional === 0` SHORT-CIRCUIT IS NOT AN OPTIMISATION ─────────────
 * It is what makes a LATENT OUT-OF-BOUNDS READ IN THE ORIGINAL portable, and it was
 * found the hard way: `granular_processor.cc:278` calls
 * `Interpolate(lut_xfade_in, dry_wet, 16.0f)` against a table of exactly 17 entries, so
 * a dry/wet of exactly 1.0 gives `index_integral == 16` and the C reads `table[17]` —
 * one past the end. In C that is harmless, because the fraction is then 0 and whatever
 * garbage `b` holds is multiplied away. In JS `table[17]` is `undefined`,
 * `(undefined - a) * 0` is `NaN`, and the NaN propagates into every sample of the output
 * for the rest of the session. MEASURED: without this guard, Clouds emits 3778 non-finite
 * samples out of 3840 at `dryWet: 1`, in all four qualities and both playback modes.
 * Reading `b` only when it is actually needed is bit-identical to the C for every
 * in-range input and cannot fault at the top of the domain.
 *
 * @param {Float32Array|number[]} table - `size + 1` entries at least
 * @param {number} index - normally in [0, 1]
 * @param {number} size - the table's span in entries
 * @returns {number}
 *
 * @example interpolate([0, 10, 20], 0.5, 2) // 10
 * @example interpolate([0, 10, 20], 0.75, 2) // 15
 * @example interpolate([0, 10, 20], 1, 2) // 20
 */
export function interpolate(table, index, size) {
  const scaled = index * size;
  const integral = Math.trunc(scaled);
  const fractional = scaled - integral;
  const a = table[integral];
  if (fractional === 0) return a;
  const b = table[integral + 1];
  return a + (b - a) * fractional;
}

/**
 * Pure function. `stmlib::SemitonesToRatio` (units.h:39) as EXACT `2^(s/12)`.
 *
 * THE SOURCE INTERPOLATES A TABLE AND WE DO NOT, which is a deviation worth stating
 * where it is: `lut_pitch_ratio_high[257] · lut_pitch_ratio_low[256]` is a product of
 * two exact powers of two — the high table steps by whole semitones and the low table
 * by 1/256 of one — and the only approximation is that the low index is TRUNCATED
 * rather than interpolated. So the source is exact at multiples of 1/256 semitone and
 * reads at most 0.0022 % flat between them (1/256 semitone = 0.39 cent, and the error
 * is the truncation of that step). That is 40 dB below the pitch error AX-2 had to
 * reproduce for Axoloti (0.72 cent) and it is not load-bearing for anything here —
 * nothing in this block beats two of these against each other the way a supersaw does.
 *
 * @param {number} semitones
 * @returns {number} the frequency ratio
 *
 * @example semitonesToRatio(0) // 1
 * @example semitonesToRatio(12) // 2
 * @example semitonesToRatio(-12) // 0.5
 */
export function semitonesToRatio(semitones) {
  return Math.pow(2, semitones / SEMITONES_PER_VOLT);
}

/**
 * Pure function. `stmlib::Crossfade` (dsp.h:105) — plain linear interpolation, named
 * because the C names it and a reader diffing the two needs the same word.
 *
 * @param {number} a - value at fade 0
 * @param {number} b - value at fade 1
 * @param {number} fade
 * @returns {number}
 *
 * @example crossfade(0, 10, 0.25) // 2.5
 */
export function crossfade(a, b, fade) {
  return a + (b - a) * fade;
}

/**
 * Pure function. `stmlib::SoftLimit` (dsp.h:109) — the cubic-ish saturator every
 * Mutable output stage ends with. Unity slope at 0, and it is NOT bounded: it is a
 * Padé approximant of tanh that only behaves inside about ±3.
 *
 * @param {number} x
 * @returns {number}
 *
 * @example softLimit(0) // 0
 * @example softLimit(1) // 0.7777777777777778
 */
export function softLimit(x) {
  return (x * (27 + x * x)) / (27 + 9 * x * x);
}

/**
 * Pure function. `stmlib::SoftClip` (dsp.h:113) — SoftLimit with the hard rails the
 * approximation needs outside ±3.
 *
 * @param {number} x
 * @returns {number}
 *
 * @example softClip(5) // 1
 * @example softClip(-5) // -1
 */
export function softClip(x) {
  if (x < -3) return -1;
  if (x > 3) return 1;
  return softLimit(x);
}

/**
 * Pure function. `stmlib::Clip16` (dsp.h:141) — the int16 saturation Clouds' buffers
 * and its `SoftConvert` output stage go through. TRUNCATES toward zero first, because
 * the C casts to `int32_t` before saturating.
 *
 * @param {number} x
 * @returns {number} an integer in [-32768, 32767]
 *
 * @example clip16(40000) // 32767
 * @example clip16(-40000) // -32768
 * @example clip16(1.7) // 1
 */
export function clip16(x) {
  const i = Math.trunc(x);
  if (i < -32768) return -32768;
  if (i > 32767) return 32767;
  return i;
}

/**
 * Pure function. `stmlib::SoftConvert` (dsp.h:167) — Clouds' float→int16 output
 * stage. THE HALVING IS THE POINT: it soft-limits `x/2` and scales by 32768, so a float
 * of ±1 leaves at ±15263 — 47 % of full scale, six decibels of headroom — instead of
 * clipping, and the curve is still climbing at ±2 (25486). Nothing here saturates hard.
 *
 * @param {number} x
 * @returns {number} an integer in [-32768, 32767]
 *
 * @example softConvert(0) // 0
 * @example softConvert(1) // 15263
 * @example softConvert(2) // 25486
 */
export function softConvert(x) {
  return clip16(softLimit(x * 0.5) * 32768);
}

/**
 * Pure function. `stmlib::fast_rsqrt_carmack` (rsqrt.h:52) — the Quake inverse square
 * root, ONE Newton step. Reproduced rather than replaced by `1/Math.sqrt(x)` because
 * Clouds' grain gain normalisation reads it and it is up to 0.18 % low, which is a
 * real (if tiny) gain error at every grain count.
 *
 * @param {number} x - must be positive
 * @returns {number} approximately 1/sqrt(x)
 *
 * @example Math.abs(fastRsqrtCarmack(4) - 0.5) < 0.001 // true
 * @example Math.abs(fastRsqrtCarmack(1) - 1) < 0.002 // true
 */
export function fastRsqrtCarmack(x) {
  const bits = new DataView(new ArrayBuffer(4));
  bits.setFloat32(0, x);
  bits.setUint32(0, (0x5f3759df - (bits.getUint32(0) >>> 1)) >>> 0);
  let y = bits.getFloat32(0);
  y = y * (1.5 - x * 0.5 * y * y);
  return y;
}

/**
 * Pure function. `stmlib::OnePole::tan<FREQUENCY_FAST>` (filter.h:112) — the tangent
 * approximation Mutable's filters are TUNED against. Fitted for 16 Hz…16 kHz at
 * 48 kHz; using `Math.tan(π·f)` instead shifts every resonator mode by a fraction of
 * a percent, which for a 64-mode bank is an audible detune of the whole comb.
 *
 * @param {number} f - cutoff as a fraction of the sample rate
 * @returns {number} the SVF's `g` coefficient
 *
 * @example Math.abs(tanFast(0.01) - Math.tan(Math.PI * 0.01)) < 1e-5 // true
 */
export function tanFast(f) {
  const a = 3.26e-1 * Math.PI ** 3;
  const b = 1.823e-1 * Math.PI ** 5;
  const f2 = f * f;
  return f * (Math.PI + f2 * (a + b * f2));
}

/**
 * Pure function. `stmlib::OnePole::tan<FREQUENCY_DIRTY>` (filter.h:107) — the cheap
 * one, valid below about 8 kHz. Rings' excitation filter and its plucker use it.
 *
 * @param {number} f - cutoff as a fraction of the sample rate
 * @returns {number}
 *
 * @example Math.abs(tanDirty(0.01) - Math.tan(Math.PI * 0.01)) < 1e-4 // true
 */
export function tanDirty(f) {
  const a = 3.736e-1 * Math.PI ** 3;
  return f * (Math.PI + a * f * f);
}

/**
 * Pure function. `stmlib::OnePole::tan<FREQUENCY_ACCURATE>` (filter.h:124) — the
 * 11th-order one, used where a mistuned pole would be heard as a wrong note (Rings'
 * string IIR damping filter).
 *
 * @param {number} f - cutoff as a fraction of the sample rate
 * @returns {number}
 *
 * @example Math.abs(tanAccurate(0.2) - Math.tan(Math.PI * 0.2)) < 1e-5 // true
 */
export function tanAccurate(f) {
  const a = 3.333314036e-1 * Math.PI ** 3;
  const b = 1.333923995e-1 * Math.PI ** 5;
  const c = 5.33740603e-2 * Math.PI ** 7;
  const d = 2.900525e-3 * Math.PI ** 9;
  const e = 9.5168091e-3 * Math.PI ** 11;
  const f2 = f * f;
  return f * (Math.PI + f2 * (a + f2 * (b + f2 * (c + f2 * (d + f2 * e)))));
}

/** `stmlib::FilterMode` (filter.h:40), as the numbers the C enum has. */
export const FILTER_MODE_LOW_PASS = 0;
export const FILTER_MODE_BAND_PASS = 1;
export const FILTER_MODE_BAND_PASS_NORMALIZED = 2;
export const FILTER_MODE_HIGH_PASS = 3;

/**
 * `stmlib::Svf` (filter.h:177) — the topology-preserving 2-pole state variable filter
 * that IS every Mutable filter. Command: `process` advances two state variables.
 *
 * The recurrence, verbatim from filter.h:232:
 *   hp = (in − r·s1 − g·s1 − s2) · h
 *   bp = g·hp + s1 ;  s1 = g·hp + bp
 *   lp = g·bp + s2 ;  s2 = g·bp + lp
 * with `h = 1/(1 + r·g + g·g)` and `r = 1/Q`.
 */
export class Svf {
  constructor() {
    this.g = 0;
    this.r = 0;
    this.h = 0;
    this.state1 = 0;
    this.state2 = 0;
  }

  /** Command. `set_f_q<FREQUENCY_FAST>` — cutoff as a fraction of the rate, Q in
   *  true units. `tanKind` picks which of stmlib's three approximations to use, so a
   *  call site cannot silently get a different one than the C++ asked for. */
  setFQ(f, resonance, tanKind = tanFast) {
    this.g = tanKind(f);
    this.r = 1 / resonance;
    this.h = 1 / (1 + this.r * this.g + this.g * this.g);
  }

  /** Command. `set_g_q` — frequency already in `g`, Q in true units. */
  setGQ(g, resonance) {
    this.g = g;
    this.r = 1 / resonance;
    this.h = 1 / (1 + this.r * this.g + this.g * this.g);
  }

  /** Command. `Svf::set(const Svf&)` — copy the coefficients, keep our own state.
   *  Clouds' stereo pairs use it so both channels cannot drift apart. */
  copyCoefficients(other) {
    this.g = other.g;
    this.r = other.r;
    this.h = other.h;
  }

  /** Command. Clear the two state variables (`Svf::Reset`). */
  reset() {
    this.state1 = 0;
    this.state2 = 0;
  }

  /** Command. One sample through the filter, returning the requested output. */
  process(input, mode) {
    const hp = (input - this.r * this.state1 - this.g * this.state1 - this.state2) * this.h;
    const bp = this.g * hp + this.state1;
    this.state1 = this.g * hp + bp;
    const lp = this.g * bp + this.state2;
    this.state2 = this.g * bp + lp;
    if (mode === FILTER_MODE_LOW_PASS) return lp;
    if (mode === FILTER_MODE_BAND_PASS) return bp;
    if (mode === FILTER_MODE_BAND_PASS_NORMALIZED) return bp * this.r;
    return hp;
  }
}

/**
 * `stmlib::DCBlocker` (filter.h:62). Command: `y = y·pole + x − x_previous`.
 */
export class DcBlocker {
  constructor(pole) {
    this.pole = pole;
    this.x = 0;
    this.y = 0;
  }

  /** Command. One sample. */
  process(input) {
    const oldX = this.x;
    this.x = input;
    this.y = this.y * this.pole + this.x - oldX;
    return this.y;
  }
}

/**
 * `stmlib::DelayLine<float, N>` (delay_line.h:39) — and the WRITE POINTER MOVES
 * BACKWARDS, which is the single easiest thing to get wrong here. `Write` decrements
 * the pointer, so `Read(d)` at `write_ptr + d` reads d samples into the PAST.
 */
export class DelayLine {
  constructor(size) {
    this.size = size;
    this.line = new Float32Array(size);
    this.writePtr = 0;
  }

  /** Command. Clear the line and rewind the pointer (`Reset`). */
  reset() {
    this.line.fill(0);
    this.writePtr = 0;
  }

  /** Command. Push one sample; the pointer moves BACKWARDS. */
  write(sample) {
    this.line[this.writePtr] = sample;
    this.writePtr = (this.writePtr - 1 + this.size) % this.size;
  }

  /** Query. Linear read `delay` samples into the past. */
  read(delay) {
    const integral = Math.trunc(delay);
    const fractional = delay - integral;
    const a = this.line[(this.writePtr + integral) % this.size];
    const b = this.line[(this.writePtr + integral + 1) % this.size];
    return a + (b - a) * fractional;
  }

  /** Query. Integer read, no interpolation (`Read(size_t)`). */
  readInt(delay) {
    return this.line[(this.writePtr + delay) % this.size];
  }

  /** Query. de Soras Hermite read (`ReadHermite`) — what every Mutable string and
   *  looper uses, because linear interpolation on a feedback loop is a lowpass that
   *  changes the decay time with the pitch. */
  readHermite(delay) {
    const integral = Math.trunc(delay);
    const fractional = delay - integral;
    const t = this.writePtr + integral + this.size;
    const xm1 = this.line[(t - 1) % this.size];
    const x0 = this.line[t % this.size];
    const x1 = this.line[(t + 1) % this.size];
    const x2 = this.line[(t + 2) % this.size];
    const c = (x1 - xm1) * 0.5;
    const v = x0 - x1;
    const w = c + v;
    const a = w + v + (x2 - x0) * 0.5;
    const bNeg = w + a;
    return ((a * fractional - bNeg) * fractional + c) * fractional + x0;
  }

  /** Command. `Allpass` — read, write `sample + k·read`, return `−k·write + read`. */
  allpass(sample, delay, coefficient) {
    const read = this.line[(this.writePtr + Math.trunc(delay)) % this.size];
    const write = sample + coefficient * read;
    this.write(write);
    return -write * coefficient + read;
  }
}

/**
 * `stmlib::CosineOscillator` (cosine_oscillator.h:44) — a two-tap resonator that
 * emits a cosine in 0…1, used both as an LFO and (in Rings' resonator) as a
 * per-sample generator of the mode AMPLITUDES for a given pickup position.
 *
 * APPROXIMATE mode is the one every Mutable call site asks for, and it is not a
 * cosine: `iir_coefficient` is a piecewise-quadratic fit of `2cos(2πf)`. Ported
 * exactly, because Rings' whole "position" character comes out of its error.
 */
export class CosineOscillator {
  constructor() {
    this.y0 = 0;
    this.y1 = 0;
    this.iirCoefficient = 0;
    this.initialAmplitude = 0;
  }

  /** Command. `Init<COSINE_OSCILLATOR_APPROXIMATE>` (cosine_oscillator.h:66). */
  initApproximate(frequency) {
    let sign = 16;
    let f = frequency - 0.25;
    if (f < 0) {
      f = -f;
    } else if (f > 0.5) {
      f -= 0.5;
    } else {
      sign = -16;
    }
    this.iirCoefficient = sign * f * (1 - 2 * f);
    this.initialAmplitude = this.iirCoefficient * 0.25;
    this.start();
  }

  /** Command. `Init<COSINE_OSCILLATOR_EXACT>`. */
  initExact(frequency) {
    this.iirCoefficient = 2 * Math.cos(2 * Math.PI * frequency);
    this.initialAmplitude = this.iirCoefficient * 0.25;
    this.start();
  }

  /** Command. Rewind to the start of the cycle. */
  start() {
    this.y1 = this.initialAmplitude;
    this.y0 = 0.5;
  }

  /** Query. The current value without advancing. */
  value() {
    return this.y1 + 0.5;
  }

  /** Command. Advance one step and return the new value. */
  next() {
    const temp = this.y0;
    this.y0 = this.iirCoefficient * this.y0 - this.y1;
    this.y1 = temp;
    return temp + 0.5;
  }
}

/**
 * `stmlib::ParameterInterpolator` (parameter_interpolator.h:35) — a per-sample ramp
 * from a stored previous value to a target across a block, writing the reached value
 * back at the end. Its DESTRUCTOR does the write-back in C++; here `finish()` is
 * explicit, and forgetting it is the port's characteristic bug (a parameter that
 * snaps back to its old value every block).
 */
export class ParamRamp {
  constructor() {
    this.value = 0;
    this.increment = 0;
  }

  /** Command. `Init(state, new_value, size)`. */
  init(previous, target, size) {
    this.value = previous;
    this.increment = (target - previous) / size;
  }

  /** Command. Advance and return. */
  next() {
    this.value += this.increment;
    return this.value;
  }
}

/**
 * `stmlib::Random` (random.h:44) — the LCG that IS every "random" in this block.
 * Command: each read advances the state. See deviation D3.
 */
export class Lcg {
  constructor(seed) {
    this.state = seed >>> 0;
  }

  /** Command. `GetWord()`. */
  word() {
    this.state = (Math.imul(this.state, 1664525) + 1013904223) >>> 0;
    return this.state;
  }

  /** Command. `GetFloat()` — in [0, 1). */
  float() {
    return this.word() / 4294967296;
  }
}

/** The interpolation kernel's reach: `pull` reads one frame BEHIND its base and two ahead,
 *  so the reader must stay at least this far from the writer to read only written frames. */
export const RESAMPLER_MIN_LAG = 4;

/** How far behind the writer a resampler's reader starts, in frames. It must clear the
 *  block-quantisation swing (see the constructor) plus `RESAMPLER_MIN_LAG`; 128 is a whole
 *  quantum, which is generous and costs 2.7 ms of latency at 48 kHz. */
export const RESAMPLER_LAG = 128;

/**
 * A 4-point Hermite resampler with a fractional read pointer — deviation D2's
 * boundary converter, standing in for Rack's `dsp::SampleRateConverter`.
 *
 * Command. Push samples at one rate, pull them at another. The ratio is
 * `sourceRate / destinationRate`, so pulling one sample advances the read pointer by
 * that much. A ratio of exactly 1 is a straight copy with no interpolation at all,
 * which is how a 48 kHz context gets Rings bit-for-bit.
 */
export class Resampler {
  constructor(channels, capacity, lag = RESAMPLER_LAG) {
    if ((capacity & (capacity - 1)) !== 0) {
      throw new Error(`Resampler capacity ${capacity} must be a power of two`);
    }
    if (lag < RESAMPLER_MIN_LAG || lag > capacity / 2) {
      throw new Error(`Resampler lag ${lag} must be between ${RESAMPLER_MIN_LAG} and half of ${capacity}`);
    }
    this.channels = channels;
    this.capacity = capacity;
    this.lines = [];
    for (let c = 0; c < channels; c++) this.lines.push(new Float32Array(capacity));
    this.writeIndex = 0;
    // THE READER STARTS `lag` FRAMES BEHIND THE WRITER, AND THAT IS NOT SLACK — IT IS THE
    // WHOLE CORRECTNESS ARGUMENT. MEASURED with the reader starting level with the writer
    // (`readPosition = 0`): over 1068 blocks of a 48 kHz host feeding a 32 kHz kernel, the
    // reader came within four frames of the writer 133 TIMES, and each crossing reads a
    // frame the writer has not produced yet — a discontinuity. The tone stayed at 440 Hz
    // and its RMS stayed correct, so nothing coarse would have caught it; what it produced
    // was a 1.21 peak on a unit sine and a phase that would not correlate, i.e. periodic
    // clicks. THE REASON THE LAG MUST EXIST AT ALL: `blockSize` inner frames do not divide
    // a 128-frame quantum's worth of them, so the number of blocks per quantum alternates
    // (2, 3, 3, 2, …) and the reader's distance behind the writer SWINGS by up to one
    // block's worth of source frames on each side even though it is exact over a whole
    // cycle. The lag has to clear that swing plus the interpolation kernel's own reach.
    this.readPosition = (capacity - lag) % capacity;
  }

  /** Command. Append one frame. `frame` is `channels` long. */
  push(frame) {
    for (let c = 0; c < this.channels; c++) this.lines[c][this.writeIndex] = frame[c];
    this.writeIndex = (this.writeIndex + 1) % this.capacity;
  }

  /** Query. How many source frames are available ahead of the read pointer. */
  available() {
    const ahead = this.writeIndex - this.readPosition;
    return ahead >= 0 ? ahead : ahead + this.capacity;
  }

  /**
   * Command. Read one frame at `ratio` source frames per destination frame, into
   * `out`. Reads BEHIND the write index by three frames so the Hermite kernel always
   * has its x2 point, which costs three frames of latency and nothing else.
   */
  pull(ratio, out) {
    const base = Math.floor(this.readPosition);
    const t = this.readPosition - base;
    for (let c = 0; c < this.channels; c++) {
      const line = this.lines[c];
      const xm1 = line[(base - 1 + this.capacity) % this.capacity];
      const x0 = line[base % this.capacity];
      const x1 = line[(base + 1) % this.capacity];
      const x2 = line[(base + 2) % this.capacity];
      const cc = (x1 - xm1) * 0.5;
      const v = x0 - x1;
      const w = cc + v;
      const a = w + v + (x2 - x0) * 0.5;
      const bNeg = w + a;
      out[c] = ((a * t - bNeg) * t + cc) * t + x0;
    }
    this.readPosition += ratio;
    if (this.readPosition >= this.capacity) this.readPosition -= this.capacity;
  }
}

// ── THE FX ENGINE — CLOUDS' AND RINGS' SHARED REVERB SUBSTRATE ──────────────
// clouds/dsp/fx/fx_engine.h @ 08460a69. One circular buffer, a set of delay lines
// carved out of it at compile time, and an ACCUMULATOR that a sequence of reads and
// writes threads through. It is not a utility: the whole Griesinger topology is
// expressed in its verbs, so getting one of them wrong mistunes a reverb rather than
// breaking it.
//
// THE ONE THING THAT SURPRISES EVERY PORTER: `Start()` DECREMENTS the write pointer,
// so `base + length - 1` (spelled `TAIL` in the C, and `-1` as an offset here) is the
// OLDEST sample in a line, and writing at offset 0 writes the newest.

/** `FORMAT_12_BIT` — the reverb's storage: `int16` of `x·4096`, so ±8 of headroom. */
export const FX_FORMAT_12_BIT = 4096;
/** `FORMAT_16_BIT` — the pitch shifter's storage. */
export const FX_FORMAT_16_BIT = 32768;
/** `FORMAT_32_BIT` — the diffuser's storage: float, no quantisation at all. */
export const FX_FORMAT_FLOAT = 0;

/**
 * Pure function. The `{base, length}` layout `E::Reserve<a, E::Reserve<b, …>>` and
 * `E::DelayLine<Memory, i>` produce between them (fx_engine.h:127): each line gets
 * ONE guard sample after it, which is what makes an interpolating read at the very end
 * of a line legal.
 *
 * @param {number[]} lengths - each line's length, in declaration order
 * @returns {{base: number, length: number}[]}
 *
 * @example fxLines([126, 180]) // [{base: 0, length: 126}, {base: 127, length: 180}]
 * @example fxLines([2047, 2047])[1].base // 2048
 */
export function fxLines(lengths) {
  const lines = [];
  let base = 0;
  for (const length of lengths) {
    lines.push({ base, length });
    base += length + 1;
  }
  return lines;
}

/**
 * `FxEngine<size, format>` (fx_engine.h:101). Command: every method mutates the
 * accumulator, the buffer, or both.
 *
 * `size` MUST be a power of two — the C masks with `size - 1` rather than dividing,
 * and a non-power-of-two would silently alias two delay lines onto each other.
 */
export class FxEngine {
  constructor(size, format, lengths) {
    if ((size & (size - 1)) !== 0) {
      throw new Error(`FxEngine size ${size} is not a power of two; fx_engine.h masks with size - 1`);
    }
    this.size = size;
    this.mask = size - 1;
    this.format = format;
    this.buffer = format === FX_FORMAT_FLOAT ? new Float32Array(size) : new Int16Array(size);
    this.lines = fxLines(lengths);
    const last = this.lines[this.lines.length - 1];
    if (last.base + last.length > size) {
      throw new Error(`FxEngine lines need ${last.base + last.length} of ${size} words (delay_memory_full)`);
    }
    this.writePtr = 0;
    this.accumulator = 0;
    this.previousRead = 0;
    this.lfo = [new CosineOscillator(), new CosineOscillator()];
    this.lfoValue = [0, 0];
  }

  /** Command. `Clear()`. */
  clear() {
    this.buffer.fill(0);
    this.writePtr = 0;
  }

  /** Command. `SetLFOFrequency` — note the `· 32`: the LFOs only tick once per 32
   *  samples (see `start`), so their oscillator runs 32× the stated frequency. */
  setLfoFrequency(index, frequency) {
    this.lfo[index].initApproximate(frequency * 32);
  }

  /** Command. `Start(Context*)` — one sample's worth of setup. */
  start() {
    this.writePtr -= 1;
    if (this.writePtr < 0) this.writePtr += this.size;
    this.accumulator = 0;
    this.previousRead = 0;
    if ((this.writePtr & 31) === 0) {
      this.lfoValue[0] = this.lfo[0].next();
      this.lfoValue[1] = this.lfo[1].next();
    } else {
      this.lfoValue[0] = this.lfo[0].value();
      this.lfoValue[1] = this.lfo[1].value();
    }
  }

  /** Query. Buffer word → float, per the engine's format. */
  decompress(word) {
    return this.format === FX_FORMAT_FLOAT ? word : word / this.format;
  }

  /** Query. Float → buffer word, per the engine's format. */
  compress(value) {
    return this.format === FX_FORMAT_FLOAT ? value : clip16(value * this.format);
  }

  /** Query. The buffer index for a line and an offset, where offset −1 is the TAIL. */
  address(line, offset) {
    const within = offset === -1 ? line.length - 1 : offset;
    return (this.writePtr + line.base + within) & this.mask;
  }

  /** Command. `Context::Load` — set the accumulator outright. */
  load(value) {
    this.accumulator = value;
  }

  /** Command. `Context::Read(float, float)` — accumulate a plain value. */
  readValue(value, scale = 1) {
    this.accumulator += value * scale;
  }

  /** Command. `Context::Read(D&, offset, scale)` — accumulate from a delay line AND
   *  remember it as `previous_read_`, which is the half `writeAllPass` depends on. */
  readLine(line, offset, scale) {
    const value = this.decompress(this.buffer[this.address(line, offset)]);
    this.previousRead = value;
    this.accumulator += value * scale;
  }

  /** Command. `Context::Write(float&, scale)` — the value is RETURNED here rather
   *  than written through a reference, and the accumulator is then scaled. */
  writeValue(scale) {
    const value = this.accumulator;
    this.accumulator *= scale;
    return value;
  }

  /** Command. `Context::Write(D&, offset, scale)`. */
  writeLine(line, offset, scale) {
    this.buffer[this.address(line, offset)] = this.compress(this.accumulator);
    this.accumulator *= scale;
  }

  /** Command. `Context::WriteAllPass(D&, offset, scale)` — a write followed by adding
   *  back the last thing READ, which is what turns a delay into an allpass. */
  writeAllPass(line, offset, scale) {
    this.writeLine(line, offset, scale);
    this.accumulator += this.previousRead;
  }

  /** Command. `Context::Interpolate(D&, offset, scale)` — a linear read at a
   *  fractional offset, optionally displaced by one of the two LFOs. */
  interpolate(line, offset, scale, lfoIndex = -1, amplitude = 0) {
    let position = offset;
    if (lfoIndex >= 0) position += amplitude * this.lfoValue[lfoIndex];
    const integral = Math.trunc(position);
    const fractional = position - integral;
    const a = this.decompress(this.buffer[(this.writePtr + integral + line.base) & this.mask]);
    const b = this.decompress(this.buffer[(this.writePtr + integral + line.base + 1) & this.mask]);
    const x = a + (b - a) * fractional;
    this.previousRead = x;
    this.accumulator += x * scale;
  }

  /** Command. `Context::Lp(state, coefficient)` — a one-pole through the accumulator.
   *  Returns the new state, because JS has no float reference. */
  lp(state, coefficient) {
    const next = state + coefficient * (this.accumulator - state);
    this.accumulator = next;
    return next;
  }

  /** Command. `Context::Hp(state, coefficient)`. */
  hp(state, coefficient) {
    const next = state + coefficient * (this.accumulator - state);
    this.accumulator -= next;
    return next;
  }
}

// ════════════════════════════════════════════════════════════════════════════
// CLOUDS — the granular buffer engine
// ════════════════════════════════════════════════════════════════════════════
//
// ── DERIVATION RECORD ───────────────────────────────────────────────────────
// ALGORITHM   eurorack @ 08460a69:
//               clouds/dsp/granular_processor.cc       Process(), ProcessGranular()
//               clouds/dsp/granular_sample_player.h    Play(), ScheduleGrain()
//               clouds/dsp/grain.h                     Start(), RenderEnvelope(), OverlapAdd()
//               clouds/dsp/looping_sample_player.h     Play()
//               clouds/dsp/audio_buffer.h              WriteFade(), Read*()
//               clouds/dsp/mu_law.h                    Lin2MuLaw(), MuLaw2Lin()
//               clouds/dsp/fx/{diffuser,reverb,pitch_shifter}.h
//               clouds/resources/lookup_tables.py      window, xfade_in/out, grain_size
// RANGES/CV   AudibleInstruments @ a1cd335e: src/Clouds.cpp — configParam lines 70…82,
//             the CV arithmetic at 165…193, and the 32-frame / 32 kHz render at 138…215.
//
// ── THE RECURRENCE, IN ONE PARAGRAPH ────────────────────────────────────────
// Incoming audio is written continuously into a circular buffer (unless FREEZE). A pool
// of up to `numGrains` grains is scheduled — probabilistically below DENSITY 0.5 and on
// a strict phasor above it — each grain reading the buffer from `position` back with its
// own pitch ratio and its own raised-cosine window, panned by `spread`. The grains are
// summed, gain-normalised by 1/sqrt(activeGrains − 1), diffused through eight allpasses,
// reverberated, and crossfaded against the dry input.
//
// ── DEVIATIONS THAT ARE CLOUDS' OWN ─────────────────────────────────────────
// C1. ONLY TWO OF THE FOUR PLAYBACK MODES ARE PORTED: `granular` and `loopingDelay`.
//     `stretch` is a WSOLA time-stretcher needing `wsola_sample_player.h` plus
//     `correlator.{h,cc}`; `spectral` is a phase vocoder needing an FFT
//     (`clouds/dsp/pvoc/*` plus stmlib's FFT). Both were out of this block's budget.
//     They are NOT offered as options — an inert mode would be a control that lies —
//     and a patch that selected one CANNOT be reproduced by this node. Said out loud
//     rather than approximated with granular, because a silent substitution is exactly
//     the "shallow port of a famous module" failure this round exists to avoid.
// C2. THE PITCH KNOB IS IN SEMITONES, NOT OCTAVES. `Clouds.cpp:72` configures
//     `PITCH_PARAM` over −2…2 and then multiplies the sum by 12, so its stored value is
//     in OCTAVES while everything downstream is semitones. Ours is semitones over
//     −48…48, which is the same span and the same clamp (`Clouds.cpp:167`). TO
//     TRANSCRIBE A STORED VCV VALUE, MULTIPLY BY 12.
// C3. THE BLEND-MODE MULTIPLEXER IS GONE. The hardware has one knob and one CV input
//     shared by dry/wet, spread, feedback and reverb, and `blendMode` picks which
//     (`Clouds.cpp:128`, `:177`). That is a panel-space workaround, not a musical
//     feature: here all four are knobs with their own inputs, so there is no mode to
//     store and no hidden state. A stored `blendMode` tells a transcriber which of the
//     four the patch's BLEND cable went to; nothing else is lost.
// C4. THE LOW-FIDELITY DECIMATOR IS HERMITE, NOT A 45-TAP HALFBAND. Qualities 2 and 3
//     run the granular engine at 16 kHz through `src_down_`/`src_up_`
//     (`granular_processor.h:205`, a 45-tap FIR). Block deviation D2's resampler stands
//     in. The 8-bit µ-LAW STORAGE those qualities use is exact: `MuLaw2Lin`'s table is
//     DERIVED from the bit formula `mu_law.h:38` commented out above it, not copied,
//     and `tests/port_vc1_test.js` checks the derivation against the four corner
//     entries of the literal table.
// C5. THE `silence_` AND `bypass_` PATHS ARE NOT PORTED. They exist for the hardware's
//     sample-memory load/save, which this node has no equivalent of.

/** Clouds' own sample rate — baked into its grain-size table, its delay lengths and
 *  its filter coefficients, so the kernel runs here and resamples at the boundary. */
export const CLOUDS_SAMPLE_RATE = 32000;

/** `granular_processor.h:49` — the low-fidelity qualities halve the rate. */
export const CLOUDS_DOWNSAMPLING_FACTOR = 2;

/** `Clouds.cpp:197` — frames per `processor->Process()` call, and therefore per
 *  `render()` here. */
export const CLOUDS_BLOCK_SIZE = 32;

/** `Clouds.cpp:99` — the large (SRAM) buffer, in bytes. */
const CLOUDS_MEM_BYTES = 118784;

/** `Clouds.cpp:100` — the small (CCM) buffer, in bytes. */
const CLOUDS_CCM_BYTES = 65536 - 128;

/** `audio_buffer.h:41` — samples of readable slack past the write head, so an
 *  interpolating read at the wrap point has its x1/x2 points. */
const CLOUDS_INTERPOLATION_TAIL = 8;

/** `audio_buffer.h:40` — the fade length, in samples, that hides a FREEZE seam. */
const CLOUDS_CROSSFADE_SIZE = 256;

/** `lookup_tables.py:53` — the grain window's resolution. */
const CLOUDS_WINDOW_SIZE = 4096;

/** `lookup_tables.py:65` — the dry/wet crossfade table's resolution. */
const CLOUDS_XFADE_SIZE = 16;

/** `lookup_tables.py:120` — the grain-size table's resolution. */
const CLOUDS_GRAIN_SIZE_TABLE_SIZE = 256;

/** `granular_sample_player.h:49` — the hard ceiling on simultaneous grains. */
export const CLOUDS_MAX_GRAINS = 64;

/** `granular_processor.cc:274` — the make-up gain on the wet path. */
const CLOUDS_POST_GAIN = 1.2;

/** `Clouds.cpp:167` — the pitch clamp, in semitones. */
export const CLOUDS_PITCH_LIMIT = 48;

/** `looping_sample_player.h:46` — the loop's crossfade length, in samples. */
const CLOUDS_LOOP_CROSSFADE = 64;

/** Grain interpolation quality (`audio_buffer.h:55`), which the grain pool assigns by
 *  how many grains are already running rather than by any user control. */
const INTERPOLATION_ZOH = 0;
const INTERPOLATION_LINEAR = 1;
const INTERPOLATION_HERMITE = 2;

/** The four playback modes of `granular_processor.h:51`, as this port's option
 *  strings. Only the two in `CLOUDS_PLAYBACK_MODES` are implemented — see C1. */
export const CLOUDS_PLAYBACK_MODES = ["granular", "loopingDelay"];

/** `granular_processor.h:125` — quality is two bits: bit 0 mono, bit 1 low fidelity. */
export const CLOUDS_QUALITIES = ["stereo32k16bit", "mono32k16bit", "stereo16k8bit", "mono16k8bit"];

/**
 * Pure function. `lut_window` (lookup_tables.py:54): a raised cosine over 0…1, as
 * `4096 + 1` entries. This is the SMOOTH end of Clouds' window-shape control; the
 * other end is a trapezoid computed directly in `Grain.renderEnvelope`.
 *
 * @param {number} size - entries minus one
 * @returns {Float32Array}
 *
 * @example buildWindowTable(4)[0] // 0
 * @example buildWindowTable(4)[4] // 1
 * @example Math.abs(buildWindowTable(4)[2] - 0.5) < 1e-6 // true
 */
export function buildWindowTable(size) {
  const table = new Float32Array(size + 1);
  for (let i = 0; i <= size; i++) {
    const t = i / size;
    table[i] = 1 - (Math.cos(t * Math.PI) + 1) / 2;
  }
  return table;
}

/**
 * Pure function. `lut_xfade_in` / `lut_xfade_out` (lookup_tables.py:62): a
 * constant-power crossfade, `1.04·t − 0.02` clamped then run through sin/cos and
 * scaled by 2^-0.5. THE 1.04 AND THE −0.02 ARE WHY DRY/WET REACHES THE ENDS: without
 * them a sine fade never fully mutes either side.
 *
 * @param {number} size - entries minus one (16 in the source)
 * @returns {{fadeIn: Float32Array, fadeOut: Float32Array}}
 *
 * @example buildXfadeTables(16).fadeIn[0] // 0
 * @example Math.abs(buildXfadeTables(16).fadeOut[16]) < 1e-6 // true
 * @example Math.abs(buildXfadeTables(16).fadeIn[8] - 0.5) < 0.02 // true
 */
export function buildXfadeTables(size) {
  const fadeIn = new Float32Array(size + 1);
  const fadeOut = new Float32Array(size + 1);
  for (let i = 0; i <= size; i++) {
    let t = 1.04 * (i / size) - 0.02;
    if (t < 0) t = 0;
    if (t >= 1) t = 1;
    t *= Math.PI / 2;
    fadeIn[i] = Math.sin(t) * Math.pow(2, -0.5);
    fadeOut[i] = Math.cos(t) * Math.pow(2, -0.5);
  }
  return { fadeIn, fadeOut };
}

/**
 * Pure function. `lut_grain_size` (lookup_tables.py:135): `floor(1024 · 2^(4·x))`, so
 * the SIZE knob spans 1024 to 16384 samples — 32 ms to 512 ms at 32 kHz — over four
 * octaves. The FLOOR is the source's and is kept: it quantises grain length to whole
 * samples before the caller ANDs off the low bit.
 *
 * @param {number} size - entries minus one (256 in the source)
 * @returns {Float32Array}
 *
 * @example buildGrainSizeTable(256)[0] // 1024
 * @example buildGrainSizeTable(256)[256] // 16384
 * @example buildGrainSizeTable(256)[64] // 2048
 */
export function buildGrainSizeTable(size) {
  const table = new Float32Array(size + 1);
  for (let i = 0; i <= size; i++) {
    table[i] = Math.floor(1024 * Math.pow(2, (4 * i) / size));
  }
  return table;
}

/**
 * Pure function. `lut_ulaw` (mu_law.cc:34), DERIVED rather than copied — from the bit
 * formula `mu_law.h:38` that sits commented out directly above the table it produced.
 * Deriving it is the DRY answer to a 256-entry literal, and the derivation is checkable:
 * entry 0 is −32124, entry 127 is 0, entry 128 is +32124, entry 255 is 0.
 *
 * @returns {Int16Array} 256 entries, µ-law code → linear int16
 *
 * @example buildMuLawTable()[0] // -32124
 * @example buildMuLawTable()[127] // 0
 * @example buildMuLawTable()[128] // 32124
 */
export function buildMuLawTable() {
  const table = new Int16Array(256);
  for (let code = 0; code < 256; code++) {
    const u = ~code & 0xff;
    let t = ((u & 0x0f) << 3) + 0x84;
    t <<= (u & 0x70) >> 4;
    table[code] = (u & 0x80) !== 0 ? 0x84 - t : t - 0x84;
  }
  return table;
}

/**
 * Pure function. `Lin2MuLaw` (mu_law.h:47) — linear int16 → µ-law code, segment by
 * segment exactly as the C does.
 *
 * @param {number} pcm - an int16
 * @returns {number} a µ-law code in 0…255
 *
 * @example lin2MuLaw(0) // 255
 * @example lin2MuLaw(32124) // 128
 * @example lin2MuLaw(-32124) // 0
 */
export function lin2MuLaw(pcm) {
  let value = pcm >> 2;
  let mask;
  if (value < 0) {
    value = -value;
    mask = 0x7f;
  } else {
    mask = 0xff;
  }
  if (value > 8159) value = 8159;
  value += 0x84 >> 2;
  let seg = 8;
  const bounds = [0x3f, 0x7f, 0xff, 0x1ff, 0x3ff, 0x7ff, 0xfff, 0x1fff];
  for (let i = 0; i < bounds.length; i++) {
    if (value <= bounds[i]) {
      seg = i;
      break;
    }
  }
  if (seg >= 8) return (0x7f ^ mask) & 0xff;
  return (((seg << 4) | ((value >> (seg + 1)) & 0x0f)) ^ mask) & 0xff;
}

/** The tables, built once at module load. They are read-only after that, so sharing
 *  them across every Clouds instance is safe and saves 4 k of float per node. */
const CLOUDS_WINDOW = buildWindowTable(CLOUDS_WINDOW_SIZE);
const CLOUDS_XFADE = buildXfadeTables(CLOUDS_XFADE_SIZE);
const CLOUDS_GRAIN_SIZE = buildGrainSizeTable(CLOUDS_GRAIN_SIZE_TABLE_SIZE);
const CLOUDS_MU_LAW = buildMuLawTable();

/**
 * Pure function. The recording buffer's length in SAMPLES for a quality setting, from
 * the two byte budgets `Clouds.cpp` allocates. Derived rather than tabulated so the
 * four menu labels ("1s / 2s / 4s / 8s") stay a consequence rather than a claim.
 *
 * In stereo BOTH channels get the small buffer and the difference between the two
 * budgets becomes the FX workspace (`granular_processor.cc:400`); in mono the one
 * channel gets the large buffer and the small one is all workspace.
 *
 * @param {boolean} mono
 * @param {boolean} lowFidelity - 8-bit µ-law storage rather than 16-bit
 * @returns {number} readable samples per channel
 *
 * @example cloudsBufferSamples(false, false) // 32696
 * @example cloudsBufferSamples(true, false) // 59384
 * @example cloudsBufferSamples(false, true) // 65400
 * @example cloudsBufferSamples(true, true) // 118776
 */
export function cloudsBufferSamples(mono, lowFidelity) {
  const bytes = mono ? CLOUDS_MEM_BYTES : CLOUDS_CCM_BYTES;
  const samples = lowFidelity ? bytes : bytes >> 1;
  return samples - CLOUDS_INTERPOLATION_TAIL;
}

/**
 * Pure function. `granular_processor.cc:443` — the grain pool size for a quality.
 * The `>> 4` after multiplying by 16 or 23 is the source's fixed-point scaling: 23/16
 * is "44 % more grains when each is cheaper".
 *
 * @param {boolean} mono
 * @param {boolean} lowFidelity
 * @returns {number}
 *
 * @example cloudsGrainCount(false, false) // 32
 * @example cloudsGrainCount(true, false) // 40
 * @example cloudsGrainCount(false, true) // 46
 * @example cloudsGrainCount(true, true) // 57
 */
export function cloudsGrainCount(mono, lowFidelity) {
  return ((mono ? 40 : 32) * (lowFidelity ? 23 : 16)) >> 4;
}

/**
 * `AudioBuffer<resolution>` (audio_buffer.h:59) — Clouds' circular recording buffer.
 * Command: `writeFade` advances the head.
 *
 * THE STORAGE IS INTEGER AND THAT IS AUDIBLE, so it is reproduced: 16-bit is the
 * hi-fi quality's real noise floor and the 8-bit µ-law of qualities 2 and 3 is the
 * crunch those settings exist for.
 */
export class CloudsAudioBuffer {
  constructor(mono, lowFidelity) {
    this.lowFidelity = lowFidelity;
    this.size = cloudsBufferSamples(mono, lowFidelity);
    const total = this.size + CLOUDS_INTERPOLATION_TAIL;
    this.samples = lowFidelity ? new Uint8Array(total) : new Int16Array(total);
    if (lowFidelity) this.samples.fill(lin2MuLaw(0));
    this.writeHead = 0;
    this.crossfadeCounter = 0;
    this.tail = new Int16Array(CLOUDS_CROSSFADE_SIZE);
  }

  /** Query. The write head, i.e. `head()`. */
  head() {
    return this.writeHead;
  }

  /** Command. `Write(float)` — one sample, with the wrap-guard copy that makes the
   *  interpolation tail readable. Note the 32768 here against `writeFade`'s 32767:
   *  that inconsistency is the source's (audio_buffer.h:95 vs :143) and is kept. */
  write(input) {
    if (this.lowFidelity) {
      this.samples[this.writeHead] = lin2MuLaw(clip16(input * 32768));
    } else {
      this.samples[this.writeHead] = clip16(input * 32768);
    }
    if (this.writeHead < CLOUDS_INTERPOLATION_TAIL) {
      this.samples[this.writeHead + this.size] = this.samples[this.writeHead];
    }
    this.writeHead += 1;
    if (this.writeHead >= this.size) this.writeHead = 0;
  }

  /**
   * Command. `WriteFade` (audio_buffer.h:130) — write `count` samples read from
   * `input` at `stride`, or, when `write` is false (FREEZE), divert them into the tail
   * buffer so that resuming can crossfade instead of clicking.
   */
  writeFade(input, offset, count, stride, write) {
    if (!write) {
      for (let i = 0; i < count; i++) {
        if (this.crossfadeCounter >= CLOUDS_CROSSFADE_SIZE) break;
        this.tail[this.crossfadeCounter] = clip16(input[offset + i * stride] * 32767);
        this.crossfadeCounter += 1;
      }
      return;
    }
    if (!this.crossfadeCounter && !this.lowFidelity
        && this.writeHead >= CLOUDS_INTERPOLATION_TAIL && this.writeHead < this.size - count) {
      for (let i = 0; i < count; i++) {
        this.samples[this.writeHead] = clip16(input[offset + i * stride] * 32767);
        this.writeHead += 1;
      }
      return;
    }
    for (let i = 0; i < count; i++) {
      let sample = input[offset + i * stride];
      if (this.crossfadeCounter) {
        this.crossfadeCounter -= 1;
        const tailSample = this.tail[CLOUDS_CROSSFADE_SIZE - this.crossfadeCounter];
        const gain = this.crossfadeCounter * (1 / CLOUDS_CROSSFADE_SIZE);
        sample += (tailSample / 32768 - sample) * gain;
      }
      this.write(sample);
    }
  }

  /** Query. One stored sample as a float, undoing the storage format. */
  at(index) {
    if (this.lowFidelity) return CLOUDS_MU_LAW[this.samples[index]] / 32768;
    return this.samples[index] / 32768;
  }

  /** Query. `Read<method>` (audio_buffer.h:186) — `fractional` is a 16-bit fraction,
   *  because a grain's phase is a 16.16 fixed-point accumulator. */
  read(integral, fractional, method) {
    let index = integral;
    if (index >= this.size) index -= this.size;
    if (method === INTERPOLATION_ZOH) return this.at(index);
    const t = fractional / 65536;
    if (method === INTERPOLATION_LINEAR) {
      const x0 = this.at(index);
      const x1 = this.at(index + 1);
      return x0 + (x1 - x0) * t;
    }
    const xm1 = this.at(index);
    const x0 = this.at(index + 1);
    const x1 = this.at(index + 2);
    const x2 = this.at(index + 3);
    const c = (x1 - xm1) * 0.5;
    const v = x0 - x1;
    const w = c + v;
    const a = w + v + (x2 - x0) * 0.5;
    const bNeg = w + a;
    return ((a * t - bNeg) * t + c) * t + x0;
  }

  /** Query. `ReadHermite` at a 12.12 fixed-point position, which is the addressing
   *  `looping_sample_player.h:102` uses (`delay_int >> 12`, `delay_int << 4`). */
  readHermite12(position) {
    return this.read(position >> 12, (position << 4) & 0xffff, INTERPOLATION_HERMITE);
  }
}

/**
 * `Grain` (grain.h:48) — ONE grain: a windowed, pitch-shifted read of the buffer.
 * Command: `overlapAdd` advances its phase and its envelope and deactivates itself when
 * the envelope runs out.
 *
 * THE PHASE IS 16.16 FIXED POINT and that is load-bearing rather than a fixed-point
 * hangover: `phase >> 16` is the sample index and `phase & 65535` is the interpolation
 * fraction, so a grain's pitch ratio is quantised to 1/65536 of a sample per sample —
 * about 0.026 cent. Using a float phase instead would make a unison grain drift.
 */
export class Grain {
  constructor() {
    this.firstSample = 0;
    this.width = 0;
    this.phase = 0;
    this.phaseIncrement = 0;
    this.preDelay = 0;
    this.envelopeSmoothness = 0;
    this.envelopeSlope = 0;
    this.envelopePhase = 2;
    this.envelopePhaseIncrement = 0;
    this.gainL = 0;
    this.gainR = 0;
    this.active = false;
    this.quality = INTERPOLATION_ZOH;
  }

  /**
   * Command. `Grain::Start` (grain.h:58). The window shape splits at 0.5: ABOVE it the
   * triangle is crossfaded toward the raised-cosine table (`envelopeSmoothness`), BELOW
   * it the triangle's sides are STEEPENED into a trapezoid (`envelopeSlope`), so 0 is a
   * rectangular window with an audible click at each edge and 1 is a Hann.
   */
  start(preDelay, bufferSize, startSample, width, phaseIncrement, windowShape, gainL, gainR, quality) {
    this.preDelay = preDelay;
    this.width = width;
    this.firstSample = ((startSample % bufferSize) + bufferSize) % bufferSize;
    this.phaseIncrement = phaseIncrement;
    this.phase = 0;
    this.envelopePhase = 0;
    this.envelopePhaseIncrement = 2 / width;
    if (windowShape >= 0.5) {
      this.envelopeSmoothness = (windowShape - 0.5) * 2;
      this.envelopeSlope = 0;
    } else {
      this.envelopeSmoothness = 0;
      this.envelopeSlope = 0.5 / (windowShape + 0.01);
    }
    this.active = true;
    this.gainL = gainL;
    this.gainR = gainR;
    this.quality = quality;
  }

  /**
   * Command. `RenderEnvelope` (grain.h:89) — pre-render the window into `envelope`,
   * writing the sentinel −1 at the sample the grain ends on. The sentinel is how the
   * audio loop learns to stop without a second counter.
   */
  renderEnvelope(envelope, offset, count) {
    const increment = this.envelopePhaseIncrement;
    const smoothness = this.envelopeSmoothness;
    const slope = this.envelopeSlope;
    const useLut = smoothness !== 0;
    let phase = this.envelopePhase;
    let index = offset;
    let remaining = count;
    while (remaining--) {
      let gain = phase;
      gain = gain >= 1 ? 2 - gain : gain;
      if (useLut) {
        if (this.quality === INTERPOLATION_HERMITE) {
          const window = interpolate(CLOUDS_WINDOW, gain, CLOUDS_WINDOW_SIZE);
          gain += smoothness * (window - gain);
        }
      } else if (this.quality >= INTERPOLATION_LINEAR) {
        gain *= slope;
        if (gain >= 1) gain = 1;
      }
      phase += increment;
      if (phase >= 2) {
        envelope[index] = -1;
        break;
      }
      envelope[index] = gain;
      index += 1;
    }
    this.envelopePhase = phase;
  }

  /**
   * Command. `OverlapAdd` (grain.h:121) — sum this grain into an interleaved stereo
   * destination. THE STEREO MATH IS NOT A PAN: at `gainL = gainR = 1` the two buffer
   * channels are summed into both outputs, and the spread knob is what pulls them
   * apart, which is why Clouds' stereo image collapses toward mono as spread falls.
   */
  overlapAdd(buffers, destination, envelope, count) {
    if (!this.active) return;
    let index = 0;
    let remaining = count;
    while (this.preDelay && remaining) {
      index += 2;
      remaining -= 1;
      this.preDelay -= 1;
    }
    this.renderEnvelope(envelope, 0, remaining);
    const increment = this.phaseIncrement;
    const first = this.firstSample;
    const gainL = this.gainL;
    const gainR = this.gainR;
    let phase = this.phase;
    let e = 0;
    while (remaining--) {
      const gain = envelope[e];
      e += 1;
      if (gain === -1) {
        this.active = false;
        break;
      }
      const sampleIndex = first + (phase >> 16);
      const fraction = phase & 65535;
      const l = buffers[0].read(sampleIndex, fraction, this.quality) * gain;
      if (buffers.length === 1) {
        destination[index] += l * gainL;
        destination[index + 1] += l * gainR;
      } else {
        const r = buffers[1].read(sampleIndex, fraction, this.quality) * gain;
        destination[index] += l * gainL + r * (1 - gainR);
        destination[index + 1] += r * gainR + l * (1 - gainL);
      }
      index += 2;
      phase += increment;
    }
    this.phase = phase;
  }
}

/**
 * `GranularSamplePlayer` (granular_sample_player.h:53) — the grain SCHEDULER, which is
 * where Clouds' character actually lives. Command.
 *
 * DENSITY IS A META-PARAMETER WITH A DEAD ZONE, and that is the single most surprising
 * thing about the module: below 0.5 grains are seeded by a DETERMINISTIC phasor and
 * above 0.53 by a PROBABILISTIC coin, with a flat gap between 0.47 and 0.53 where
 * `overlap` is zero and NO grains are scheduled at all except by `trigger`
 * (`granular_processor.cc:97`). Both halves ramp the same overlap up from that gap, so
 * the knob is a V — which is why turning density past noon does not make it denser, it
 * makes it RANDOM.
 */
export class CloudsGranularPlayer {
  constructor(channels, maxGrains) {
    this.channels = channels;
    this.maxGrains = maxGrains;
    this.midFiGrains = (3 * maxGrains) / 4;
    this.gainNormalization = 1;
    this.grains = [];
    for (let i = 0; i < CLOUDS_MAX_GRAINS; i++) this.grains.push(new Grain());
    this.availableGrains = new Int32Array(CLOUDS_MAX_GRAINS);
    this.envelope = new Float32Array(CLOUDS_BLOCK_SIZE);
    this.numGrains = 0;
    this.grainSizeHint = 1024;
    this.grainRatePhasor = 0;
  }

  /** Query. `FillAvailableGrainsList` — how many grains are free, and which. */
  fillAvailableGrains() {
    let count = 0;
    for (let i = 0; i < this.maxGrains; i++) {
      if (!this.grains[i].active) {
        this.availableGrains[count] = i;
        count += 1;
      }
    }
    return count;
  }

  /**
   * Command. `ScheduleGrain` (granular_sample_player.h:178) — pick this grain's start
   * point, length, pitch ratio and pan.
   *
   * THE `available` ARITHMETIC IS A RACE AVOIDANCE, not a musical choice: a grain
   * playing FASTER than the record head would overrun the newest audio, so the reachable
   * window is `bufferSize − grainSize·ratio − grainSize` and `position` scans that
   * rather than the whole buffer. Ignore it and a pitched-up grain reads across the
   * write head, which is a periodic click at exactly the buffer period.
   */
  scheduleGrain(grain, controls, preDelay, bufferSize, bufferHead, quality, random) {
    const position = controls.position;
    const pitch = controls.pitch;
    const windowShape = controls.windowShape;
    let grainSize = interpolate(CLOUDS_GRAIN_SIZE, controls.size, CLOUDS_GRAIN_SIZE_TABLE_SIZE);
    const pitchRatio = semitonesToRatio(pitch);
    const invPitchRatio = semitonesToRatio(-pitch);
    const pan = 0.5 + controls.stereoSpread * (random.float() - 0.5);
    let gainL;
    let gainR;
    if (pan < 0.5) {
      gainL = 1;
      gainR = 2 * pan;
    } else {
      gainR = 1;
      gainL = 2 * (1 - pan);
    }
    if (pitchRatio > 1) {
      grainSize = Math.min(grainSize, bufferSize * 0.25 * invPitchRatio);
    }
    const eatenByPlayHead = grainSize * pitchRatio;
    const eatenByRecordingHead = grainSize;
    const available = bufferSize - eatenByPlayHead - eatenByRecordingHead;
    const width = Math.trunc(grainSize) & ~1;
    const start = bufferHead - Math.trunc(position * available + eatenByPlayHead);
    grain.start(preDelay, bufferSize, start, width, Math.trunc(pitchRatio * 65536),
      windowShape, gainL, gainR, quality);
    this.grainSizeHint += 0.1 * (grainSize - this.grainSizeHint);
  }

  /**
   * Command. `Play` (granular_sample_player.h:71) — schedule, overlap-add, normalise.
   * `output` is interleaved stereo, `count` frames.
   */
  play(buffers, controls, output, count, random) {
    let overlap = controls.overlap;
    overlap = overlap * overlap * overlap;
    const targetNumGrains = this.maxGrains * overlap;
    let p = targetNumGrains / this.grainSizeHint;
    const spaceBetweenGrains = this.grainSizeHint / targetNumGrains;
    if (controls.useDeterministicSeed) {
      p = -1;
    } else {
      this.grainRatePhasor = -1000;
    }

    let numAvailableGrains = this.fillAvailableGrains();
    let seedTrigger = controls.trigger;
    for (let t = 0; t < count; t++) {
      this.grainRatePhasor += 1;
      const seedProbabilistic = random.float() < p && targetNumGrains > this.numGrains;
      const seedDeterministic = this.grainRatePhasor >= spaceBetweenGrains;
      const seed = seedProbabilistic || seedDeterministic || seedTrigger;
      if (numAvailableGrains && seed) {
        numAvailableGrains -= 1;
        const index = this.availableGrains[numAvailableGrains];
        const quality = numAvailableGrains < this.midFiGrains ? INTERPOLATION_LINEAR : INTERPOLATION_HERMITE;
        this.scheduleGrain(this.grains[index], controls, t, buffers[0].size,
          buffers[0].head() - count + t, quality, random);
        this.grainRatePhasor = 0;
        seedTrigger = false;
      }
    }

    output.fill(0, 0, count * 2);
    for (let i = 0; i < this.maxGrains; i++) {
      this.grains[i].overlapAdd(buffers, output, this.envelope, count);
    }

    // `SLOPE(num_grains_, active, 0.9f, 0.2f)` — grain count rises nine times faster
    // than it falls, so the normalisation opens quickly and closes gently.
    const activeGrains = this.maxGrains - numAvailableGrains;
    const error = activeGrains - this.numGrains;
    this.numGrains += (error > 0 ? 0.9 : 0.2) * error;

    let gainNormalization = this.numGrains > 2 ? fastRsqrtCarmack(this.numGrains - 1) : 1;
    let windowGain = 1 + 2 * controls.windowShape;
    if (windowGain < 1) windowGain = 1;
    if (windowGain > 2) windowGain = 2;
    gainNormalization *= crossfade(1, windowGain, controls.overlap);

    for (let t = 0; t < count; t++) {
      this.gainNormalization += 0.01 * (gainNormalization - this.gainNormalization);
      output[t * 2] *= this.gainNormalization;
      output[t * 2 + 1] *= this.gainNormalization;
    }
  }
}

/**
 * `LoopingSamplePlayer` (looping_sample_player.h:50) — Clouds' looping-delay mode.
 * Command.
 *
 * UNFROZEN it is a delay whose time GLIDES toward the position knob at 0.00005 per
 * sample (a ~7-second slew at 32 kHz, which is why sweeping POSITION in this mode
 * sounds like tape rather than like a jump). FROZEN it becomes a loop of `size`
 * length, crossfaded at the seam and pitch-shiftable.
 *
 * The tap-tempo half (`tap_delay_`, `synchronized_`) is ported because TRIG in this
 * mode is not a grain trigger, it is a tap: two taps set the loop length.
 */
export class CloudsLoopingPlayer {
  constructor(channels) {
    this.channels = channels;
    this.phase = 0;
    this.currentDelay = 0;
    this.loopPoint = 0;
    this.loopDuration = 0;
    this.tailStart = 0;
    this.tailDuration = 1;
    this.loopReset = 0;
    this.synchronized = false;
    this.tapDelay = 0;
    this.tapDelayCounter = 0;
  }

  /** Command. `Play` — `output` is interleaved stereo, `count` frames. */
  play(buffers, controls, output, count) {
    const maxDelay = buffers[0].size - CLOUDS_LOOP_CROSSFADE;
    this.tapDelayCounter += count;
    if (this.tapDelayCounter > maxDelay) {
      this.tapDelay = 0;
      this.tapDelayCounter = 0;
      this.synchronized = false;
    }
    if (controls.trigger) {
      this.tapDelay = this.tapDelayCounter;
      this.tapDelayCounter = 0;
      this.synchronized = this.tapDelay > 128;
      this.loopReset = this.phase;
      this.phase = 0;
    }

    if (!controls.freeze) {
      for (let i = 0; i < count; i++) {
        // `while (size--)` has already decremented when the body reads `size`, so the
        // C's value here is count − 1 − i, not count − i. Off by one and the delay is a
        // sample short every block, which reads as a faint metallic ring.
        const remaining = count - 1 - i;
        let targetDelay = controls.position * maxDelay;
        if (this.synchronized) targetDelay = this.tapDelay;
        this.currentDelay += 0.00005 * (targetDelay - this.currentDelay);
        let delayInt = (buffers[0].head() - 4 - remaining + buffers[0].size) << 12;
        delayInt -= Math.trunc(this.currentDelay * 4096);
        const l = buffers[0].readHermite12(delayInt);
        const r = buffers.length === 1 ? l : buffers[1].readHermite12(delayInt);
        output[i * 2] = l;
        output[i * 2 + 1] = r;
      }
      this.phase = 0;
      return;
    }

    let loopPoint = (controls.position * maxDelay * 15) / 16 + CLOUDS_LOOP_CROSSFADE;
    const d = controls.size;
    let loopDuration = (0.01 + 0.99 * d * d * d) * maxDelay;
    if (this.synchronized) loopDuration = this.tapDelay;
    if (loopPoint + loopDuration >= maxDelay) loopPoint = maxDelay - loopDuration;
    const phaseIncrement = this.synchronized ? 1 : semitonesToRatio(controls.pitch);

    for (let i = 0; i < count; i++) {
      if (this.phase >= this.loopDuration || this.phase === 0) {
        if (this.phase >= this.loopDuration) this.loopReset = this.loopDuration;
        if (this.loopReset >= this.loopDuration) this.loopReset = this.loopDuration;
        this.tailStart = this.loopDuration - this.loopReset + this.loopPoint;
        this.phase = 0;
        this.tailDuration = Math.min(CLOUDS_LOOP_CROSSFADE, CLOUDS_LOOP_CROSSFADE * phaseIncrement);
        this.loopPoint = loopPoint;
        this.loopDuration = loopDuration;
      }
      this.phase += phaseIncrement;

      let gain = 1;
      if (this.tailDuration !== 0) {
        gain = this.phase / this.tailDuration;
        if (gain < 0) gain = 0;
        if (gain > 1) gain = 1;
      }
      const delayInt = (buffers[0].head() - 4 + buffers[0].size) << 12;
      const position = delayInt - Math.trunc((this.loopDuration - this.phase + this.loopPoint) * 4096);
      const l = buffers[0].readHermite12(position);
      const r = buffers.length === 1 ? l : buffers[1].readHermite12(position);
      output[i * 2] = l * gain;
      output[i * 2 + 1] = r * gain;

      if (gain !== 1) {
        const tailGain = 1 - gain;
        const tailPosition = delayInt - Math.trunc((-this.phase + this.tailStart) * 4096);
        const tl = buffers[0].readHermite12(tailPosition);
        const tr = buffers.length === 1 ? tl : buffers[1].readHermite12(tailPosition);
        output[i * 2] += tl * tailGain;
        output[i * 2 + 1] += tr * tailGain;
      }
    }
  }
}

/**
 * `Diffuser` (diffuser.h:38) — eight allpasses, four per channel, that smear a grain's
 * transient without adding a tail. Command. This is what TEXTURE above 0.75 engages.
 */
export class CloudsDiffuser {
  constructor() {
    this.engine = new FxEngine(2048, FX_FORMAT_FLOAT, [126, 180, 269, 444, 151, 205, 245, 405]);
    this.amount = 0;
  }

  /** Command. Process `count` interleaved stereo frames in place. */
  process(buffer, count) {
    const e = this.engine;
    const [apl1, apl2, apl3, apl4, apr1, apr2, apr3, apr4] = e.lines;
    const kap = 0.625; // diffuser.h:65
    for (let i = 0; i < count; i++) {
      e.start();
      e.readValue(buffer[i * 2]);
      e.readLine(apl1, -1, kap);
      e.writeAllPass(apl1, 0, -kap);
      e.readLine(apl2, -1, kap);
      e.writeAllPass(apl2, 0, -kap);
      e.readLine(apl3, -1, kap);
      e.writeAllPass(apl3, 0, -kap);
      e.readLine(apl4, -1, kap);
      e.writeAllPass(apl4, 0, -kap);
      const wetL = e.writeValue(0);
      buffer[i * 2] += this.amount * (wetL - buffer[i * 2]);

      e.readValue(buffer[i * 2 + 1]);
      e.readLine(apr1, -1, kap);
      e.writeAllPass(apr1, 0, -kap);
      e.readLine(apr2, -1, kap);
      e.writeAllPass(apr2, 0, -kap);
      e.readLine(apr3, -1, kap);
      e.writeAllPass(apr3, 0, -kap);
      e.readLine(apr4, -1, kap);
      e.writeAllPass(apr4, 0, -kap);
      const wetR = e.writeValue(0);
      buffer[i * 2 + 1] += this.amount * (wetR - buffer[i * 2 + 1]);
    }
  }
}

/**
 * `Reverb` (reverb.h:38) — the Griesinger/Dattorro topology: four input allpasses then
 * a figure-of-eight loop of two 2-allpass-plus-delay halves, with the LFOs smearing
 * AP1 and modulating the two long delays. Command.
 *
 * ITS STORAGE IS 12-BIT and that is deliberate: `FORMAT_12_BIT` gives ±8 of headroom in
 * an int16, so the tail's noise floor is part of Clouds' sound rather than a defect.
 */
export class CloudsReverb {
  constructor() {
    this.engine = new FxEngine(16384, FX_FORMAT_12_BIT,
      [113, 162, 241, 399, 1653, 2038, 3411, 1913, 1663, 4782]);
    this.engine.setLfoFrequency(0, 0.5 / CLOUDS_SAMPLE_RATE);
    this.engine.setLfoFrequency(1, 0.3 / CLOUDS_SAMPLE_RATE);
    this.amount = 0;
    this.inputGain = 0.2;
    this.reverbTime = 0.5;
    this.diffusion = 0.625;
    this.lp = 0.7;
    this.lpDecay1 = 0;
    this.lpDecay2 = 0;
  }

  /** Command. Process `count` interleaved stereo frames in place. */
  process(buffer, count) {
    const e = this.engine;
    const [ap1, ap2, ap3, ap4, dap1a, dap1b, del1, dap2a, dap2b, del2] = e.lines;
    const kap = this.diffusion;
    const klp = this.lp;
    const krt = this.reverbTime;
    const amount = this.amount;
    const gain = this.inputGain;
    let lp1 = this.lpDecay1;
    let lp2 = this.lpDecay2;

    for (let i = 0; i < count; i++) {
      e.start();
      // Smear AP1 inside the loop (reverb.h:93) — the write at offset 100 with scale 0
      // is what injects the LFO-displaced read back into the line.
      e.interpolate(ap1, 10, 1, 0, 60);
      e.writeLine(ap1, 100, 0);

      e.readValue(buffer[i * 2] + buffer[i * 2 + 1], gain);
      e.readLine(ap1, -1, kap);
      e.writeAllPass(ap1, 0, -kap);
      e.readLine(ap2, -1, kap);
      e.writeAllPass(ap2, 0, -kap);
      e.readLine(ap3, -1, kap);
      e.writeAllPass(ap3, 0, -kap);
      e.readLine(ap4, -1, kap);
      e.writeAllPass(ap4, 0, -kap);
      const apout = e.writeValue(1);

      e.load(apout);
      e.interpolate(del2, 4680, krt, 1, 100);
      lp1 = e.lp(lp1, klp);
      e.readLine(dap1a, -1, -kap);
      e.writeAllPass(dap1a, 0, kap);
      e.readLine(dap1b, -1, kap);
      e.writeAllPass(dap1b, 0, -kap);
      e.writeLine(del1, 0, 2);
      const wetL = e.writeValue(0);
      buffer[i * 2] += (wetL - buffer[i * 2]) * amount;

      e.load(apout);
      e.readLine(del1, -1, krt);
      lp2 = e.lp(lp2, klp);
      e.readLine(dap2a, -1, kap);
      e.writeAllPass(dap2a, 0, -kap);
      e.readLine(dap2b, -1, -kap);
      e.writeAllPass(dap2b, 0, kap);
      e.writeLine(del2, 0, 2);
      const wetR = e.writeValue(0);
      buffer[i * 2 + 1] += (wetR - buffer[i * 2 + 1]) * amount;
    }
    this.lpDecay1 = lp1;
    this.lpDecay2 = lp2;
  }
}

/**
 * `PitchShifter` (pitch_shifter.h:38) — two crossfaded taps of one delay line half a
 * period apart, which is the cheapest possible pitch shifter and is what gives Clouds'
 * looping-delay mode its distinctive warble. Command.
 */
export class CloudsPitchShifter {
  constructor() {
    this.engine = new FxEngine(4096, FX_FORMAT_16_BIT, [2047, 2047]);
    this.phase = 0;
    this.ratio = 1;
    this.size = 2047;
  }

  /** Command. `set_size` — a cubic map onto 128…2047 samples, one-pole smoothed. */
  setSize(size) {
    const targetSize = 128 + (2047 - 128) * size * size * size;
    this.size += 0.05 * (targetSize - this.size);
  }

  /** Command. Process `count` interleaved stereo frames in place. */
  process(buffer, count) {
    const e = this.engine;
    const [left, right] = e.lines;
    for (let i = 0; i < count; i++) {
      e.start();
      this.phase += (1 - this.ratio) / this.size;
      if (this.phase >= 1) this.phase -= 1;
      if (this.phase <= 0) this.phase += 1;
      const tri = 2 * (this.phase >= 0.5 ? 1 - this.phase : this.phase);
      const phase = this.phase * this.size;
      let half = phase + this.size * 0.5;
      if (half >= this.size) half -= this.size;

      e.readValue(buffer[i * 2], 1);
      e.writeLine(left, 0, 0);
      e.interpolate(left, phase, tri);
      e.interpolate(left, half, 1 - tri);
      buffer[i * 2] = e.writeValue(0);

      e.readValue(buffer[i * 2 + 1], 1);
      e.writeLine(right, 0, 0);
      e.interpolate(right, phase, tri);
      e.interpolate(right, half, 1 - tri);
      buffer[i * 2 + 1] = e.writeValue(0);
    }
  }
}

/**
 * Pure function. The granular mode's FOUR META-MAPPINGS of DENSITY and TEXTURE
 * (`granular_processor.cc:96` and `:217`), extracted as a function because they are the
 * module's least obvious behaviour and a test can then assert the dead zone exists.
 *
 * WRITES INTO `out` rather than returning a fresh object, following
 * `ax3_kernels.axBiquadCoefs`'s precedent: the caller is `render()`, which runs on the
 * audio thread and may not allocate.
 *
 * @param {number} density - 0…1
 * @param {number} texture - 0…1
 * @param {object} out - mutated: {overlap, windowShape, useDeterministicSeed, diffusion}
 * @returns {object} the same `out`, for convenience
 *
 * @example cloudsGranularMeta(0.5, 0.5, {}).overlap // 0
 * @example cloudsGranularMeta(0.5, 0.5, {}).useDeterministicSeed // false
 * @example cloudsGranularMeta(0.2, 0.5, {}).useDeterministicSeed // true
 * @example Math.abs(cloudsGranularMeta(1, 0.5, {}).overlap - 0.9964) < 1e-4 // true
 * @example cloudsGranularMeta(0.5, 0.9, {}).diffusion > 0 // true
 */
export function cloudsGranularMeta(density, texture, out) {
  if (density >= 0.53) {
    out.overlap = (density - 0.53) * 2.12;
  } else if (density <= 0.47) {
    out.overlap = (0.47 - density) * 2.12;
  } else {
    out.overlap = 0;
  }
  out.windowShape = texture < 0.75 ? texture * 1.333 : 1;
  out.useDeterministicSeed = density < 0.5;
  out.diffusion = texture > 0.75 ? (texture - 0.75) * 4 : 0;
  return out;
}

/**
 * THE CLOUDS KERNEL — `GranularProcessor` (granular_processor.cc:159) plus the parts of
 * `Clouds.cpp:process()` that are really parameter conditioning. Command.
 *
 * Also the ENGINE BEHIND SUPERCELL: Grayscale's module is a CV/UI superset of Clouds
 * with the same DSP (see `SupercellKernel`), so it subclasses this rather than forking
 * it — which is the whole reason the blend-mode multiplexer had to go (deviation C3).
 */
export class CloudsKernel {
  static internalRate = CLOUDS_SAMPLE_RATE;
  static blockSize = CLOUDS_BLOCK_SIZE;
  static channels = { in: 2, out: 2 };

  constructor(sampleRate, options = {}) {
    const quality = options.quality === undefined ? CLOUDS_QUALITIES[0] : options.quality;
    const index = CLOUDS_QUALITIES.indexOf(quality);
    if (index < 0) {
      throw new Error(`CloudsKernel: unknown quality ${JSON.stringify(quality)}; expected one of ${CLOUDS_QUALITIES.join(", ")}`);
    }
    this.mono = (index & 1) !== 0;
    this.lowFidelity = (index >> 1) !== 0;
    this.dspRate = CLOUDS_SAMPLE_RATE / (this.lowFidelity ? CLOUDS_DOWNSAMPLING_FACTOR : 1);
    this.buffers = [new CloudsAudioBuffer(this.mono, this.lowFidelity)];
    if (!this.mono) this.buffers.push(new CloudsAudioBuffer(this.mono, this.lowFidelity));
    this.player = new CloudsGranularPlayer(this.mono ? 1 : 2, cloudsGrainCount(this.mono, this.lowFidelity));
    this.looper = new CloudsLoopingPlayer(this.mono ? 1 : 2);
    this.diffuser = new CloudsDiffuser();
    this.reverb = new CloudsReverb();
    this.pitchShifter = new CloudsPitchShifter();
    this.random = new Lcg(options.seed === undefined ? 1 : options.seed);
    this.playback = CLOUDS_PLAYBACK_MODES[0];

    const frames = CLOUDS_BLOCK_SIZE * 2;
    this.inBuffer = new Float32Array(frames);
    this.outBuffer = new Float32Array(frames);
    this.fbBuffer = new Float32Array(frames);
    // The quantised input, kept because the feedback stage overwrites `inBuffer` in place
    // and the dry/wet crossfade at the end still needs the DRY signal.
    this.inputQuantised = new Float32Array(frames);
    this.downBuffer = new Float32Array(frames / CLOUDS_DOWNSAMPLING_FACTOR);
    this.upBuffer = new Float32Array(frames / CLOUDS_DOWNSAMPLING_FACTOR);
    this.fbFilter = [new Svf(), new Svf()];
    this.lpFilter = [new Svf(), new Svf()];
    this.hpFilter = [new Svf(), new Svf()];
    this.freezeLp = 0;
    this.dryWet = 0;
    // Built here, not in `render` — nothing may allocate on the audio thread.
    this.dryWetRamp = new ParamRamp();
    this.meta = { overlap: 0, windowShape: 0, useDeterministicSeed: false, diffusion: 0 };
    // `clouds::Parameters` with the granular sub-struct flattened in. Mutated per block.
    this.state = {
      position: 0, size: 0, pitch: 0, stereoSpread: 0, trigger: false, freeze: false,
      overlap: 0, windowShape: 0, useDeterministicSeed: false,
    };
  }

  /** Command. The `playback` option, per `ax2OptionSetter`'s naming convention. */
  setPlayback(mode) {
    if (!CLOUDS_PLAYBACK_MODES.includes(mode)) {
      throw new Error(`CloudsKernel: playback mode ${JSON.stringify(mode)} is not ported (deviation C1); expected one of ${CLOUDS_PLAYBACK_MODES.join(", ")}`);
    }
    this.playback = mode;
  }

  /** Command. `set_quality` — CONSTRUCT-time, because it reallocates the buffers. The
   *  setter exists so the option protocol is uniform, and it refuses a late change
   *  rather than silently ignoring it. */
  setQuality(quality) {
    if (quality !== CLOUDS_QUALITIES[(this.mono ? 1 : 0) | (this.lowFidelity ? 2 : 0)]) {
      throw new Error("CloudsKernel: quality is construct-time (it sizes the recording buffer); the module must be rebuilt");
    }
  }

  /**
   * Command. `ProcessGranular` (granular_processor.cc:75) — record, then play. Writes
   * `count` interleaved stereo frames into `output`.
   */
  processGranular(controls, input, output, count) {
    for (let c = 0; c < this.buffers.length; c++) {
      this.buffers[c].writeFade(input, c, count, 2, !controls.freeze);
    }
    if (this.playback === "granular") {
      this.player.play(this.buffers, controls, output, count, this.random);
    } else {
      this.looper.play(this.buffers, controls, output, count);
    }
  }

  /**
   * Command. `GranularProcessor::Process` — one block. `input` and `output` are
   * interleaved stereo, `blockSize` frames.
   */
  render(controls, input, output) {
    const size = CLOUDS_BLOCK_SIZE;
    const meta = cloudsGranularMeta(controls.density, controls.texture, this.meta);
    const granular = this.playback === "granular";
    // `state` is the kernel's own scratch object, mutated rather than rebuilt: it is
    // `clouds::Parameters` with the granular sub-struct flattened into it.
    const state = this.state;
    state.position = controls.position;
    state.size = controls.size;
    state.pitch = controls.pitch;
    state.stereoSpread = controls.spread;
    state.trigger = controls.trig;
    state.freeze = controls.freeze;
    state.overlap = meta.overlap;
    state.windowShape = meta.windowShape;
    state.useDeterministicSeed = meta.useDeterministicSeed;

    // INPUT GAIN, then the int16 quantisation, in that order — `Clouds.cpp:120` scales
    // by the gain knob BEFORE the buffer's converter sees the sample, so the knob is also
    // the buffer's exposure control and turning it down really does record more noisily.
    const inGain = controls.inGain;
    for (let i = 0; i < size * 2; i++) {
      this.inBuffer[i] = clip16(input[i] * inGain * 32767) / 32768;
      this.inputQuantised[i] = this.inBuffer[i];
    }
    if (this.mono) {
      for (let i = 0; i < size; i++) {
        const mixed = (this.inBuffer[i * 2] + this.inBuffer[i * 2 + 1]) * 0.5;
        this.inBuffer[i * 2] = mixed;
        this.inBuffer[i * 2 + 1] = mixed;
      }
    }

    // Feedback, high-passed so a build-up at DC cannot swing the buffer
    // (granular_processor.cc:190).
    this.freezeLp += 0.0005 * ((controls.freeze ? 1 : 0) - this.freezeLp);
    const feedback = controls.feedback;
    const cutoff = (20 + 100 * feedback * feedback) / this.dspRate;
    this.fbFilter[0].setFQ(cutoff, 1);
    this.fbFilter[1].copyCoefficients(this.fbFilter[0]);
    for (let i = 0; i < size; i++) {
      this.fbBuffer[i * 2] = this.fbFilter[0].process(this.fbBuffer[i * 2], FILTER_MODE_HIGH_PASS);
      this.fbBuffer[i * 2 + 1] = this.fbFilter[1].process(this.fbBuffer[i * 2 + 1], FILTER_MODE_HIGH_PASS);
    }
    const fbGain = feedback * (1 - this.freezeLp);
    for (let i = 0; i < size * 2; i++) {
      const dry = this.inBuffer[i];
      this.inBuffer[i] += fbGain * (softLimit(fbGain * 1.4 * this.fbBuffer[i] + dry) - dry);
    }

    if (this.lowFidelity) {
      // Deviation C4: a 2-tap average down and linear interpolation up, standing in for
      // the 45-tap halfband pair. Crude, and said so: it is a gentler anti-imaging
      // filter than theirs, so quality 2 and 3 image slightly more than the hardware.
      const half = size / CLOUDS_DOWNSAMPLING_FACTOR;
      for (let i = 0; i < half; i++) {
        this.downBuffer[i * 2] = (this.inBuffer[i * 4] + this.inBuffer[i * 4 + 2]) * 0.5;
        this.downBuffer[i * 2 + 1] = (this.inBuffer[i * 4 + 1] + this.inBuffer[i * 4 + 3]) * 0.5;
      }
      this.processGranular(state, this.downBuffer, this.upBuffer, half);
      for (let i = 0; i < size; i++) {
        const j = Math.min(i >> 1, half - 1);
        const k = Math.min(j + 1, half - 1);
        const t = (i & 1) * 0.5;
        this.outBuffer[i * 2] = crossfade(this.upBuffer[j * 2], this.upBuffer[k * 2], t);
        this.outBuffer[i * 2 + 1] = crossfade(this.upBuffer[j * 2 + 1], this.upBuffer[k * 2 + 1], t);
      }
    } else {
      this.processGranular(state, this.inBuffer, this.outBuffer, size);
    }

    this.diffuser.amount = granular ? meta.diffusion : controls.density;
    this.diffuser.process(this.outBuffer, size);

    if (!granular && (!controls.freeze || this.looper.synchronized)) {
      this.pitchShifter.ratio = semitonesToRatio(controls.pitch);
      this.pitchShifter.setSize(controls.size);
      this.pitchShifter.process(this.outBuffer, size);
    }

    if (!granular) {
      // The looping-delay mode's TEXTURE is a tone control rather than a window shape
      // (granular_processor.cc:232): below noon it closes a lowpass, above it opens a
      // highpass, and 216 semitones is the eighteen octaves that spans.
      const tone = controls.texture;
      let lpCutoff = 0.5 * semitonesToRatio((tone < 0.5 ? tone - 0.5 : 0) * 216);
      let hpCutoff = 0.25 * semitonesToRatio((tone < 0.5 ? -0.5 : tone - 1) * 216);
      if (lpCutoff < 0) lpCutoff = 0;
      if (lpCutoff > 0.499) lpCutoff = 0.499;
      if (hpCutoff < 0) hpCutoff = 0;
      if (hpCutoff > 0.499) hpCutoff = 0.499;
      const lpq = 1 + 3 * (1 - feedback) * (0.5 - lpCutoff);
      this.lpFilter[0].setFQ(lpCutoff, lpq);
      this.lpFilter[1].copyCoefficients(this.lpFilter[0]);
      this.hpFilter[0].setFQ(hpCutoff, 1);
      this.hpFilter[1].copyCoefficients(this.hpFilter[0]);
      for (let i = 0; i < size; i++) {
        this.outBuffer[i * 2] = this.lpFilter[0].process(this.outBuffer[i * 2], FILTER_MODE_LOW_PASS);
        this.outBuffer[i * 2 + 1] = this.lpFilter[1].process(this.outBuffer[i * 2 + 1], FILTER_MODE_LOW_PASS);
      }
      for (let i = 0; i < size; i++) {
        this.outBuffer[i * 2] = this.hpFilter[0].process(this.outBuffer[i * 2], FILTER_MODE_HIGH_PASS);
        this.outBuffer[i * 2 + 1] = this.hpFilter[1].process(this.outBuffer[i * 2 + 1], FILTER_MODE_HIGH_PASS);
      }
    }

    // This is what is fed back. Reverb is NOT (granular_processor.cc:259).
    this.fbBuffer.set(this.outBuffer.subarray(0, size * 2));

    let reverbAmount = controls.reverb * 0.95;
    reverbAmount += feedback * (2 - feedback) * this.freezeLp;
    if (reverbAmount < 0) reverbAmount = 0;
    if (reverbAmount > 1) reverbAmount = 1;
    this.reverb.amount = reverbAmount * 0.54;
    this.reverb.diffusion = 0.7;
    this.reverb.reverbTime = 0.35 + 0.63 * reverbAmount;
    this.reverb.inputGain = 0.2;
    this.reverb.lp = 0.6 + 0.37 * feedback;
    this.reverb.process(this.outBuffer, size);

    this.dryWetRamp.init(this.dryWet, controls.blend, size);
    for (let i = 0; i < size; i++) {
      const dryWet = this.dryWetRamp.next();
      const fadeIn = interpolate(CLOUDS_XFADE.fadeIn, dryWet, CLOUDS_XFADE_SIZE);
      const fadeOut = interpolate(CLOUDS_XFADE.fadeOut, dryWet, CLOUDS_XFADE_SIZE);
      // THE DRY PATH IS THE GAIN-SCALED INPUT, not the raw one: `Clouds.cpp` applies
      // IN_GAIN when it fills its input buffer, and `Process` crossfades against THAT.
      const l = this.inputQuantised[i * 2] * fadeOut
        + this.outBuffer[i * 2] * CLOUDS_POST_GAIN * fadeIn;
      const r = this.inputQuantised[i * 2 + 1] * fadeOut
        + this.outBuffer[i * 2 + 1] * CLOUDS_POST_GAIN * fadeIn;
      output[i * 2] = softConvert(l) / 32768;
      output[i * 2 + 1] = softConvert(r) / 32768;
    }
    this.dryWet = this.dryWetRamp.value;
  }
}

// ════════════════════════════════════════════════════════════════════════════
// RINGS — the modal / string resonator bank
// ════════════════════════════════════════════════════════════════════════════
//
// ── DERIVATION RECORD ───────────────────────────────────────────────────────
// ALGORITHM   eurorack @ 08460a69:
//               rings/dsp/part.cc          Process(), ConfigureResonators(),
//                                          RenderModalVoice(), RenderStringVoice(),
//                                          ComputeSympatheticStringsNotes()
//               rings/dsp/resonator.cc     ComputeFilters(), Process()
//               rings/dsp/string.cc        ProcessInternal()
//               rings/dsp/string.h         DampingFilter (the FIR)
//               rings/dsp/plucker.h        Trigger(), Process()
//               rings/dsp/note_filter.h    Process()
//               rings/dsp/limiter.h        Process()
//               rings/dsp/strummer.h       Process()
//               rings/resources/lookup_tables.py  4_decades, svf_shift, stiffness
// RANGES/CV   AudibleInstruments @ a1cd335e: src/Rings.cpp — configParam 68…78, the CV
//             arithmetic at 145…157, and the 24-frame / 48 kHz render at 128…190.
//
// ── WHY THE ODD AND EVEN OUTPUTS ARE NOT A STEREO PAIR ──────────────────────
// At polyphony 1 they are the resonator's TWO PICKUPS — the odd-numbered modes and the
// even-numbered ones, weighted by a cosine of `position` (`resonator.cc:113`). They are
// DECORRELATED, not panned, which is why P1 can feed them to Clouds as a stereo pair and
// get a wide image out of a mono excitation. At polyphony 2 and 4 the same two jacks
// carry alternating VOICES instead (`part.cc:540`), and each jack then gets
// `out − aux` — a different signal entirely. Getting one output right is not enough.
//
// ── DEVIATIONS THAT ARE RINGS' OWN ──────────────────────────────────────────
// R1. ONLY THE THREE MODELS THE RACK MODULE CAN REACH ARE PORTED, and that is complete
//     rather than partial: `Rings.cpp:121` cycles `(resonatorModel + 1) % 3`, so MODAL,
//     SYMPATHETIC_STRING and STRING are all a patch can ever store. FM_VOICE,
//     SYMPATHETIC_STRING_QUANTIZED and STRING_AND_REVERB exist in the firmware and are
//     unreachable from Rack; they are not ported and no option offers them.
// R2. THE ONSET DETECTOR IS NOT PORTED. `strummer.h` derives an internal strum from
//     EITHER a V/oct step OR a transient on the audio input (`onset_detector.h`, a
//     three-band envelope follower with its own attack/decay ladder). The note-change
//     branch and the inhibit timer ARE ported; the audio-onset branch is not. So an
//     external exciter with STRUM unpatched will not self-trigger here. Every selected
//     patch (P1, P3, P5) wires Marbles into STRUM, so this costs those decks nothing —
//     but it is a real gap and not a rounding error.
// R3. CABLE PRESENCE BECOMES THREE KNOBS. `internal_exciter`, `internal_strum` and
//     `internal_note` are `!input.isConnected()` in Rack, and they change the sound a
//     lot: the internal exciter substitutes a pulse or a noise burst for the audio
//     input, and the excitation filter's cutoff range and Q both switch on it
//     (`part.cc:503`). An AudioParam cannot tell a patched zero from an absent cable, so
//     each is an explicit two-option knob. That is MORE expressive than Rack, not less —
//     an author can run the internal exciter alongside an audio input, which the
//     hardware cannot.
// R4. THE ATTENUVERTERS STAY KNOBS. Per block deviation D1 clause 2 a CV wire is in knob
//     units, but Rings' wrapper multiplies each CV by `3.3 · quadraticBipolar(trim)`, and
//     real patches set those trims (P1: Brightness CV 0.1467, Damping CV 0.1333;
//     P3: Position CV −0.376). Collapsing them would silently discard a stored value, so
//     the chain is `knob + 3.3 · quadraticBipolar(trim) · wire`, reproduced exactly.
// R5. THE UNPATCHED-INPUT NORMAL VOLTAGES BECOME PARAM DEFAULTS. `Rings.cpp:152` reads
//     V/oct through `getNormalVoltage(1/12)` and FM through `getNormalVoltage(1.0)`, so
//     an unpatched Rings is one semitone sharp of its knob and its FM trim has a
//     constant offset. Those two values are the AudioParam DEFAULTS here (1 semitone,
//     and 0.2 wire units = 1 V), which reproduces the behaviour exactly while leaving an
//     author free to zero them.

/** The two values every `internal | external` source option takes. */
export const VC1_SOURCE_OPTIONS = ["internal", "external"];

/**
 * Pure function. One of Rings' three source options as a boolean, LOUD on anything else.
 * Shared rather than repeated three times, and it refuses a typo instead of silently
 * reading it as `external` — which would look exactly like a working module.
 *
 * @param {string} option - the knob key, for the error message
 * @param {string} value - "internal" or "external"
 * @returns {boolean} true for "internal"
 *
 * @example vc1SourceIsInternal("exciter", "internal") // true
 * @example vc1SourceIsInternal("exciter", "external") // false
 */
export function vc1SourceIsInternal(option, value) {
  if (!VC1_SOURCE_OPTIONS.includes(value)) {
    throw new Error(`RingsKernel: ${option} must be one of ${VC1_SOURCE_OPTIONS.join(", ")}, not ${JSON.stringify(value)}`);
  }
  return value === "internal";
}

/** Rings' own sample rate — `rings/dsp/dsp.h:41`. */
export const RINGS_SAMPLE_RATE = 48000;

/** `rings/dsp/dsp.h:43` — frames per `part.Process()` call. */
export const RINGS_BLOCK_SIZE = 24;

/** `a3` (`rings/dsp/dsp.h:42`): A440 as a fraction of the sample rate, which is what
 *  every frequency in Rings is expressed in. */
const RINGS_A3 = A440_HZ / RINGS_SAMPLE_RATE;

/** `resonator.h:43` — the modal bank's ceiling. */
export const RINGS_MAX_MODES = 64;

/** `part.h:63` and `:64`. */
export const RINGS_MAX_POLYPHONY = 4;
const RINGS_NUM_STRINGS = RINGS_MAX_POLYPHONY * 2;

/** `string.h:43` — the Karplus-Strong delay line, and half that for the stiffness
 *  allpass that stretches its partials. */
const RINGS_DELAY_LINE_SIZE = 2048;

/** The three models `Rings.cpp:121` can cycle through. See deviation R1. */
export const RINGS_MODELS = ["modal", "sympathetic", "string"];

/** `part.cc:569` — per-model make-up gain into the limiter. Indexed by RINGS_MODELS. */
const RINGS_MODEL_GAINS = [1.4, 1.0, 1.4];

/** `part.cc:203` — the ping order for ODD polyphony counts. Rack can only select 1, 2
 *  or 4, so this is reachable at polyphony 1 alone, where it is a no-op; kept because
 *  removing it would make the voice rotation differ from the source for no reason. */
const RINGS_PING_PATTERN = [1, 0, 2, 1, 0, 2, 1, 0];

/** `part.cc:98` — the modal bank's per-voice mode budget is `64/polyphony − 4`. */
export const RINGS_MODAL_RESOLUTION_MARGIN = 4;

/**
 * Pure function. `lut_4_decades` (rings/resources/lookup_tables.py:57): `10^(4x)` in 257
 * steps. Rings reads it for the modal bank's Q, so DAMPING spans four decades of decay.
 *
 * @param {number} size - entries minus one
 * @returns {Float32Array}
 *
 * @example build4DecadesTable(256)[0] // 1
 * @example build4DecadesTable(256)[256] // 10000
 */
export function build4DecadesTable(size) {
  const table = new Float32Array(size + 1);
  for (let i = 0; i <= size; i++) table[i] = Math.pow(10, 4 * (i / size));
  return table;
}

/**
 * Pure function. `lut_svf_shift` (rings/resources/lookup_tables.py:66):
 * `atan(2^(−i/12))/π`, the GROUP DELAY of an SVF at a cutoff `i` semitones above the
 * fundamental, in samples. The string subtracts it from its delay length so that closing
 * the damping filter does not flatten the pitch.
 *
 * NOTE THE INDEXING: `Interpolate(lut_svf_shift, damping_cutoff, 1.0f)` passes size 1, so
 * the index IS the semitone value, not a 0…1 fraction. That is the only call in this
 * block where `interpolate`'s second argument is not normalised.
 *
 * @param {number} size - entries minus one
 * @returns {Float32Array}
 *
 * @example Math.abs(buildSvfShiftTable(256)[0] - 0.25) < 1e-6 // true
 * @example buildSvfShiftTable(256)[12] < buildSvfShiftTable(256)[0] // true
 */
export function buildSvfShiftTable(size) {
  const table = new Float32Array(size + 1);
  for (let i = 0; i <= size; i++) {
    const ratio = Math.pow(2, i / SEMITONES_PER_VOLT);
    table[i] = (2 * Math.atan(1 / ratio)) / (2 * Math.PI);
  }
  return table;
}

/**
 * Pure function. `lut_stiffness` (rings/resources/lookup_tables.py:73) — STRUCTURE's
 * inharmonicity curve, and the reason that knob feels like four different controls.
 *
 * Four regions: BELOW 0.25 the stiffness is NEGATIVE (partials compress toward the
 * fundamental — a membrane); 0.25…0.3 is exactly ZERO (a perfect harmonic series, a
 * string); 0.3…0.9 rises exponentially to about 0.99 (a stiff bar); above 0.9 it sweeps a
 * raised cosine from 1.0 to 2.0 (partials at whole multiples of 2 — a bell). The last two
 * entries are FORCED to 2.0, which is the source's own guard against the interpolation
 * overshooting at the top.
 *
 * @param {number} size - entries minus one
 * @returns {Float32Array}
 *
 * @example buildStiffnessTable(256)[0] // -0.0625
 * @example buildStiffnessTable(256)[70] // 0
 * @example buildStiffnessTable(256)[256] // 2
 */
export function buildStiffnessTable(size) {
  const table = new Float32Array(size + 1);
  for (let i = 0; i <= size; i++) {
    let g = i / size;
    if (g < 0.25) {
      g = 0.25 - g;
      table[i] = -g * 0.25;
    } else if (g < 0.3) {
      table[i] = 0;
    } else if (g < 0.9) {
      g = (g - 0.3) / 0.6;
      table[i] = 0.01 * Math.pow(10, g * 2.005) - 0.01;
    } else {
      g = (g - 0.9) / 0.1;
      g *= g;
      table[i] = 1.5 - Math.cos(g * Math.PI) / 2;
    }
  }
  table[size] = 2;
  table[size - 1] = 2;
  return table;
}

const RINGS_TABLE_SIZE = 256;
const RINGS_4_DECADES = build4DecadesTable(RINGS_TABLE_SIZE);
const RINGS_SVF_SHIFT = buildSvfShiftTable(RINGS_TABLE_SIZE);
const RINGS_STIFFNESS = buildStiffnessTable(RINGS_TABLE_SIZE);

/**
 * Pure function. Rack's `dsp::quadraticBipolar` (`Rack/include/dsp/common.hpp:56`) —
 * `sign(x)·x²`, the law every Rings attenuverter trim follows.
 *
 * @param {number} x
 * @returns {number}
 *
 * @example quadraticBipolar(0.5) // 0.25
 * @example quadraticBipolar(-0.5) // -0.25
 */
export function quadraticBipolar(x) {
  return x < 0 ? -x * x : x * x;
}

/**
 * Pure function. Rack's `dsp::quarticBipolar` — `sign(x)·x⁴`, used by Rings' FREQUENCY
 * trim alone, which is why that one control has such a long dead zone at the centre.
 *
 * @param {number} x
 * @returns {number}
 *
 * @example quarticBipolar(0.5) // 0.0625
 * @example quarticBipolar(-1) // -1
 */
export function quarticBipolar(x) {
  const x2 = x * x;
  return x < 0 ? -x2 * x2 : x2 * x2;
}

/**
 * `Resonator` (resonator.cc:42) — a bank of up to 64 band-pass modes.
 * Command.
 *
 * The mode ladder, from `ComputeFilters` (resonator.cc:56):
 *   f_i   = f0 · Σ_{k<i} stretch_k      with  stretch_0 = 1, stretch_{k+1} = stretch_k + s_k
 *   s_{k+1} = s_k · (s_k < 0 ? 0.93 : 0.98)
 *   Q_i   = 1 + f_i · q_i               with  q_0 = 500 · 10^(4·damping), q_{i+1} = q_i · qloss_i
 *   qloss_{i+1} = qloss_i + rate · (1 − qloss_i),  rate = structure·(2 − structure)·0.1
 *
 * The two ASYMMETRIC stiffness decays are not a typo: a NEGATIVE stiffness has to be
 * damped faster (0.93) or the partials would fold through zero into negative
 * frequencies, while a positive one is damped slower (0.98) precisely to buy a few more
 * partials up top. That asymmetry IS the difference between the membrane and the bell.
 */
export class RingsResonator {
  constructor() {
    this.filters = [];
    for (let i = 0; i < RINGS_MAX_MODES; i++) this.filters.push(new Svf());
    this.frequency = 220 / RINGS_SAMPLE_RATE;
    this.structure = 0.25;
    this.brightness = 0.5;
    this.damping = 0.3;
    this.position = 0.999;
    this.previousPosition = 0;
    this.resolution = RINGS_MAX_MODES;
    this.amplitudes = new CosineOscillator();
    this.auxAmplitudes = new CosineOscillator();
    this.positionRamp = new ParamRamp();
  }

  /** Command. `set_resolution` — forced EVEN, because `Process` consumes modes two at a
   *  time (one odd, one even) and an odd count would read past `num_modes`. */
  setResolution(resolution) {
    const even = resolution - (resolution & 1);
    this.resolution = Math.min(even, RINGS_MAX_MODES);
  }

  /** Command. `ComputeFilters` — returns the number of modes below Nyquist. */
  computeFilters() {
    let stiffness = interpolate(RINGS_STIFFNESS, this.structure, RINGS_TABLE_SIZE);
    let harmonic = this.frequency;
    let stretchFactor = 1;
    let q = 500 * interpolate(RINGS_4_DECADES, this.damping, RINGS_TABLE_SIZE);
    let brightnessAttenuation = 1 - this.structure;
    brightnessAttenuation *= brightnessAttenuation;
    brightnessAttenuation *= brightnessAttenuation;
    brightnessAttenuation *= brightnessAttenuation;
    const brightness = this.brightness * (1 - 0.2 * brightnessAttenuation);
    let qLoss = brightness * (2 - brightness) * 0.85 + 0.15;
    const qLossDampingRate = this.structure * (2 - this.structure) * 0.1;
    let numModes = 0;
    const count = Math.min(RINGS_MAX_MODES, this.resolution);
    for (let i = 0; i < count; i++) {
      let partialFrequency = harmonic * stretchFactor;
      if (partialFrequency >= 0.49) {
        partialFrequency = 0.49;
      } else {
        numModes = i + 1;
      }
      this.filters[i].setFQ(partialFrequency, 1 + partialFrequency * q);
      stretchFactor += stiffness;
      stiffness *= stiffness < 0 ? 0.93 : 0.98;
      qLoss += qLossDampingRate * (1 - qLoss);
      harmonic += this.frequency;
      q *= qLoss;
    }
    return numModes;
  }

  /**
   * Command. `Resonator::Process` — `out` gets the odd modes' sum and `aux` the even
   * modes', both weighted by `CosineOscillator(position)`.
   *
   * THE 0.125 ON THE INPUT is the bank's headroom: 64 resonant band-passes summed can
   * reach 18 dB above their input, and this is where that is paid for.
   */
  process(input, out, aux, count) {
    const numModes = this.computeFilters();
    this.positionRamp.init(this.previousPosition, this.position, count);
    for (let i = 0; i < count; i++) {
      this.amplitudes.initApproximate(this.positionRamp.next());
      const sample = input[i] * 0.125;
      let odd = 0;
      let even = 0;
      this.amplitudes.start();
      for (let mode = 0; mode < numModes;) {
        odd += this.amplitudes.next() * this.filters[mode].process(sample, FILTER_MODE_BAND_PASS);
        mode += 1;
        even += this.amplitudes.next() * this.filters[mode].process(sample, FILTER_MODE_BAND_PASS);
        mode += 1;
      }
      out[i] = odd;
      aux[i] = even;
    }
    this.previousPosition = this.positionRamp.value;
  }
}

/**
 * `DampingFilter` (string.h:45) — the string's loop filter: a 3-tap symmetric FIR whose
 * brightness sets the taps and whose damping scales the whole thing. Command.
 *
 * `y = damping · (h0·x[n−1] + h1·(x[n] + x[n−2]))` with `h0 = (1+b)/2`, `h1 = (1−b)/4`.
 * At `b = 1` it is a pure one-sample delay (no lowpass at all, a bright string); at
 * `b = 0` it is the classic `(x[n] + 2x[n−1] + x[n−2])/4`.
 */
export class RingsDampingFilter {
  constructor() {
    this.x1 = 0;
    this.x2 = 0;
    this.brightness = 0;
    this.brightnessIncrement = 0;
    this.damping = 0;
    this.dampingIncrement = 0;
  }

  /** Command. `Configure` — ramp both coefficients across `count` samples. */
  configure(damping, brightness, count) {
    if (!count) {
      this.damping = damping;
      this.brightness = brightness;
      this.dampingIncrement = 0;
      this.brightnessIncrement = 0;
      return;
    }
    const step = 1 / count;
    this.dampingIncrement = (damping - this.damping) * step;
    this.brightnessIncrement = (brightness - this.brightness) * step;
  }

  /** Command. One sample. */
  process(x) {
    const h0 = (1 + this.brightness) * 0.5;
    const h1 = (1 - this.brightness) * 0.25;
    const y = this.damping * (h0 * this.x1 + h1 * (x + this.x2));
    this.x2 = this.x1;
    this.x1 = x;
    this.brightness += this.brightnessIncrement;
    this.damping += this.dampingIncrement;
    return y;
  }
}

/**
 * `String` (string.cc:45) — a Karplus-Strong string with optional DISPERSION: an
 * allpass in the loop that stretches the partials, plus a curved-bridge nonlinearity and
 * a noise term. Command.
 *
 * DISPERSION IS THREE EFFECTS ON ONE CONTROL and the split points matter: above 0.75 it
 * adds filtered NOISE to the delay length (a wobble); below 0 it engages the CURVED
 * BRIDGE, a rectifier in the feedback path that makes the string buzz against a fret;
 * and across the whole positive range it moves an allpass's share of the delay
 * (`stretch_point`), which is what detunes the partials.
 */
export class RingsString {
  constructor(enableDispersion, random) {
    this.enableDispersion = enableDispersion;
    // THE SEEDED GENERATOR IS PASSED IN, not created here: `string.cc:146` reads the
    // one global `stmlib::Random`, so all of a Part's strings share a stream and their
    // dispersion noise is correlated exactly as the source's is.
    this.random = random;
    this.line = new DelayLine(RINGS_DELAY_LINE_SIZE);
    this.stretch = new DelayLine(RINGS_DELAY_LINE_SIZE / 2);
    this.firDamping = new RingsDampingFilter();
    this.iirDamping = new Svf();
    this.dcBlocker = new DcBlocker(1 - 20 / RINGS_SAMPLE_RATE);
    this.frequency = 220 / RINGS_SAMPLE_RATE;
    this.dispersion = 0.25;
    this.brightness = 0.5;
    this.damping = 0.3;
    this.position = 0.8;
    this.delay = 1 / this.frequency;
    this.clampedPosition = 0;
    this.previousDispersion = 0;
    this.previousDampingCompensation = 0;
    this.dispersionNoise = 0;
    this.curvedBridge = 0;
    this.srcPhase = 0;
    this.outSample = [0, 0];
    this.auxSample = [0, 0];
    this.delayRamp = new ParamRamp();
    this.positionRamp = new ParamRamp();
    this.dispersionRamp = new ParamRamp();
    this.compensationRamp = new ParamRamp();
  }

  /** Command. `set_frequency(f, coefficient)` — a GLIDE, not a jump. The sympathetic
   *  strings use a coefficient below 1 so a chord change slurs rather than clicks. */
  setFrequency(frequency, coefficient = 1) {
    this.frequency += coefficient * (frequency - this.frequency);
  }

  /** Command. `set_dispersion` — STRUCTURE's dead zone around 0.25, mapped to a signed
   *  dispersion (`part.cc:404` computes it; kept here so both callers agree). */
  setDispersion(dispersion) {
    this.dispersion = dispersion;
  }

  /**
   * Command. `String::ProcessInternal` — ACCUMULATES into `out` and `aux`, because
   * several strings share one pair of buffers.
   */
  process(input, out, aux, count) {
    let delayTarget = 1 / this.frequency;
    if (delayTarget < 4) delayTarget = 4;
    if (delayTarget > RINGS_DELAY_LINE_SIZE - 4) delayTarget = RINGS_DELAY_LINE_SIZE - 4;

    // Below about 11.7 Hz the delay line cannot hold a period, so the string runs at a
    // divided rate and a linear interpolator upsamples it. `src_ratio == 1` above that.
    let srcRatio = delayTarget * this.frequency;
    if (srcRatio >= 0.9999) {
      this.srcPhase = 1;
      srcRatio = 1;
    }

    const clampedPosition = 0.5 - 0.98 * Math.abs(this.position - 0.5);
    this.delayRamp.init(this.delay, delayTarget, count);
    this.positionRamp.init(this.clampedPosition, clampedPosition, count);
    this.dispersionRamp.init(this.previousDispersion, this.dispersion, count);

    const lfDamping = this.damping * (2 - this.damping);
    const rt60 = 0.07 * semitonesToRatio(lfDamping * 96) * RINGS_SAMPLE_RATE;
    const rt60Base = Math.max((-120 * delayTarget) / srcRatio / rt60, -127);
    let dampingCoefficient = semitonesToRatio(rt60Base);
    let brightness = this.brightness * this.brightness;
    const noiseFilter = semitonesToRatio((this.brightness - 1) * 48);
    let dampingCutoff = Math.min(
      24 + this.damping * this.damping * 48 + this.brightness * this.brightness * 24, 84);
    let dampingF = Math.min(this.frequency * semitonesToRatio(dampingCutoff), 0.499);

    // Crossfade to infinite decay — the top 5 % of DAMPING is a FREEZE, not just a long
    // tail, and all four coefficients move together to get there (string.cc:115).
    if (this.damping >= 0.95) {
      const toInfinite = 20 * (this.damping - 0.95);
      dampingCoefficient += toInfinite * (1 - dampingCoefficient);
      brightness += toInfinite * (1 - brightness);
      dampingF += toInfinite * (0.4999 - dampingF);
      dampingCutoff += toInfinite * (128 - dampingCutoff);
    }

    this.firDamping.configure(dampingCoefficient, brightness, count);
    this.iirDamping.setFQ(dampingF, 0.5, tanAccurate);
    this.compensationRamp.init(this.previousDampingCompensation,
      1 - interpolate(RINGS_SVF_SHIFT, dampingCutoff, 1), count);

    for (let i = 0; i < count; i++) {
      this.srcPhase += srcRatio;
      if (this.srcPhase > 1) {
        this.srcPhase -= 1;

        let delay = this.delayRamp.next();
        const combDelay = delay * this.positionRamp.next();
        delay *= this.compensationRamp.next();
        delay -= 1;

        let s;
        if (this.enableDispersion) {
          // The noise is LOW-PASSED by `noise_filter` and normalised by it, so a dark
          // brightness makes it both slower and larger — a lazy wobble rather than a hiss.
          let noise = 2 * this.random.float() - 1;
          noise *= 1 / (0.2 + noiseFilter);
          this.dispersionNoise += noiseFilter * (noise - this.dispersionNoise);

          const dispersion = this.dispersionRamp.next();
          const stretchPoint = dispersion <= 0 ? 0 : dispersion * (2 - dispersion) * 0.475;
          let noiseAmount = dispersion > 0.75 ? 4 * (dispersion - 0.75) : 0;
          let bridgeCurving = dispersion < 0 ? -dispersion : 0;

          noiseAmount = noiseAmount * noiseAmount * 0.025;
          const acBlockingAmount = bridgeCurving;
          bridgeCurving = bridgeCurving * bridgeCurving * 0.01;
          const apGain = (-0.618 * dispersion) / (0.15 + Math.abs(dispersion));

          let delayFm = 1;
          delayFm += this.dispersionNoise * noiseAmount;
          delayFm -= this.curvedBridge * bridgeCurving;
          delay *= delayFm;

          const apDelay = delay * stretchPoint;
          const mainDelay = delay - apDelay;
          if (apDelay >= 4 && mainDelay >= 4) {
            s = this.line.readHermite(mainDelay);
            s = this.stretch.allpass(s, apDelay, apGain);
          } else {
            s = this.line.readHermite(delay);
          }
          const sAc = this.dcBlocker.process(s);
          s += acBlockingAmount * (sAc - s);

          // The curved bridge: a half-wave rectifier with a DEAD ZONE of 0.025 and an
          // ASYMMETRIC sign (+1 up, −1.5 down). Both are what make it buzz rather than
          // just distort — `string.cc:184`.
          const value = Math.abs(s) - 0.025;
          const sign = s > 0 ? 1 : -1.5;
          this.curvedBridge = (Math.abs(value) + value) * sign;
        } else {
          s = this.line.readHermite(delay);
        }

        s += input[i];
        s = this.firDamping.process(s);
        s = this.iirDamping.process(s, FILTER_MODE_LOW_PASS);
        this.line.write(s);

        this.outSample[1] = this.outSample[0];
        this.auxSample[1] = this.auxSample[0];
        this.outSample[0] = s;
        this.auxSample[0] = this.line.read(combDelay);
      }
      out[i] += crossfade(this.outSample[1], this.outSample[0], this.srcPhase);
      aux[i] += crossfade(this.auxSample[1], this.auxSample[0], this.srcPhase);
    }

    this.delay = this.delayRamp.value;
    this.clampedPosition = this.positionRamp.value;
    this.previousDispersion = this.dispersionRamp.value;
    this.previousDampingCompensation = this.compensationRamp.value;
  }
}

/**
 * `Plucker` (plucker.h:42) — the internal exciter for the string models: a burst of
 * noise exactly one comb-period long, through a comb filter and a lowpass. Command.
 *
 * THIS IS WHERE "POSITION" BECOMES A PLECTRUM. The comb's period is `position` of the
 * string's own period and its gain is `1 − position`, so the excitation already carries
 * the notch a real pluck point would put in the spectrum — before the string's own
 * pickup comb adds a second one.
 */
export class RingsPlucker {
  constructor(random) {
    this.svf = new Svf();
    this.comb = new DelayLine(256);
    this.remainingSamples = 0;
    this.combPeriod = 0;
    this.combGain = 0;
    this.random = random;
  }

  /** Command. `Trigger` — arm a burst. The `while (comb_period >= 255)` halving is the
   *  source's way of keeping a low note's comb inside a 256-sample line; the BURST
   *  length is set BEFORE the halving, so a low note gets a long burst through a short
   *  comb, which is exactly what makes bass plucks sound thicker. */
  trigger(frequency, cutoff, position) {
    const ratio = position * 0.9 + 0.05;
    let combPeriod = (1 / frequency) * ratio;
    this.remainingSamples = Math.trunc(combPeriod);
    while (combPeriod >= 255) combPeriod *= 0.5;
    this.combPeriod = combPeriod;
    this.combGain = (1 - position) * 0.8;
    this.svf.setFQ(Math.min(cutoff, 0.499), 1, tanDirty);
  }

  /** Command. Render `count` samples into `out`, OVERWRITING it. */
  process(out, count) {
    for (let i = 0; i < count; i++) {
      let input = 0;
      if (this.remainingSamples) {
        input = 2 * this.random.float() - 1;
        this.remainingSamples -= 1;
      }
      out[i] = input + this.combGain * this.comb.read(this.combPeriod);
      this.comb.write(out[i]);
    }
    for (let i = 0; i < count; i++) out[i] = this.svf.process(out[i], FILTER_MODE_LOW_PASS);
  }
}

/**
 * `NoteFilter` (note_filter.h:36) — a 4-tap median filter followed by an ADAPTIVE lag
 * processor. Command.
 *
 * Why a resonator needs this at all: the pitch input is a continuous CV, and a resonator
 * retuned mid-decay glissandos. So the filter tracks a big step INSTANTLY (its
 * coefficient resets to `fast`) and then relaxes toward `slow`, which smooths the CV's
 * own noise without smearing a note change. `stable_note()` is that value delayed by
 * eight control ticks, so a polyphonic voice assignment reads the note AFTER the edge
 * has settled rather than during it.
 */
export class RingsNoteFilter {
  static ORDER = 4;

  constructor(sampleRate, fastEdge, steadyPart, edgeRecovery, edgeAvoidanceDelay) {
    this.fastCoefficient = 1 / (fastEdge * sampleRate);
    this.slowCoefficient = 1 / (steadyPart * sampleRate);
    this.lagCoefficient = 1 / (edgeRecovery * sampleRate);
    this.delayed = new DelayLine(16);
    this.delayLength = Math.min(15, Math.trunc(edgeAvoidanceDelay * sampleRate));
    this.noteValue = A3_MIDI_NOTE;
    this.stableNoteValue = A3_MIDI_NOTE;
    this.coefficient = this.fastCoefficient;
    this.stableCoefficient = this.slowCoefficient;
    this.previousValues = new Float64Array(RingsNoteFilter.ORDER).fill(A3_MIDI_NOTE);
    this.sorted = new Float64Array(RingsNoteFilter.ORDER);
  }

  /** Command. One control tick. Returns the tracked note. */
  process(note, strum) {
    const n = RingsNoteFilter.ORDER;
    if (Math.abs(note - this.noteValue) > 0.4 || strum) {
      this.stableNoteValue = note;
      this.noteValue = note;
      this.coefficient = this.fastCoefficient;
      this.stableCoefficient = this.slowCoefficient;
      this.previousValues.fill(note);
      return this.noteValue;
    }
    for (let i = 0; i < n - 1; i++) this.previousValues[i] = this.previousValues[i + 1];
    this.previousValues[n - 1] = note;
    this.sorted.set(this.previousValues);
    this.sorted.sort();
    const median = 0.5 * (this.sorted[(n - 1) >> 1] + this.sorted[n >> 1]);

    this.noteValue += this.coefficient * (median - this.noteValue);
    this.stableNoteValue += this.stableCoefficient * (this.noteValue - this.stableNoteValue);
    this.coefficient += this.lagCoefficient * (this.slowCoefficient - this.coefficient);
    // NOT A TYPO, AND IT IS THE SOURCE'S: the stable coefficient relaxes toward
    // `lag_coefficient_`, not toward `slow_coefficient_` (note_filter.h:88). Reproduced,
    // because it is what makes `stable_note` settle an order of magnitude slower than
    // `note` and therefore useful as a voice-assignment value.
    this.stableCoefficient += this.lagCoefficient * (this.lagCoefficient - this.stableCoefficient);
    this.delayed.write(this.stableNoteValue);
    return this.noteValue;
  }

  /** Query. The delayed stable note (`stable_note()`). */
  stableNote() {
    return this.delayed.readInt(this.delayLength);
  }
}

/**
 * `Limiter` (limiter.h:38) — Rings' output stage. Command.
 *
 * IT MEASURES THE SIDE SIGNAL TOO (`fabs(r − l)`), not just the two channels, which is
 * why a decorrelated ODD/EVEN pair is limited harder than a correlated one. That is
 * deliberate: the two jacks are often summed downstream and the sum is what would clip.
 * The 0.8 afterwards is "clamp to 8 Vpp, clipping softly toward 10".
 */
export class RingsLimiter {
  constructor() {
    this.peak = 0.5;
  }

  /** Command. Process `count` frames of `left`/`right` in place. */
  process(left, right, count, preGain) {
    for (let i = 0; i < count; i++) {
      const l = left[i] * preGain;
      const r = right[i] * preGain;
      const peak = Math.max(Math.max(Math.abs(l), Math.abs(r)), Math.abs(r - l));
      const error = peak - this.peak;
      this.peak += (error > 0 ? 0.05 : 0.00002) * error;
      const gain = this.peak <= 1 ? 1 : 1 / this.peak;
      left[i] = softLimit(l * gain * 0.8);
      right[i] = softLimit(r * gain * 0.8);
    }
  }
}

/**
 * THE RINGS KERNEL — `Part` (part.cc:463) plus `Rings.cpp`'s parameter conditioning and
 * the note-change half of `Strummer`. Command.
 */
export class RingsKernel {
  static internalRate = RINGS_SAMPLE_RATE;
  static blockSize = RINGS_BLOCK_SIZE;
  static channels = { in: 1, out: 2 };

  constructor(sampleRate, options = {}) {
    this.random = new Lcg(options.seed === undefined ? 1 : options.seed);
    this.model = RINGS_MODELS[0];
    this.polyphony = 1;
    // Deviation R3: cable presence, as three explicit two-option knobs. The defaults are
    // Rack's own unpatched state for the exciter and its patched state for the other two,
    // which is what the `strum` and `pitch` ports being wired means.
    this.internalExciter = true;
    this.internalStrum = false;
    this.internalNote = false;
    this.activeVoice = 0;
    this.stepCounter = 0;
    this.dirty = true;
    this.notes = new Float64Array(RINGS_MAX_POLYPHONY);

    this.excitationFilter = [];
    this.dcBlockers = [];
    this.pluckers = [];
    this.resonators = [];
    for (let i = 0; i < RINGS_MAX_POLYPHONY; i++) {
      this.excitationFilter.push(new Svf());
      this.dcBlockers.push(new DcBlocker(1 - 10 / RINGS_SAMPLE_RATE));
      this.pluckers.push(new RingsPlucker(this.random));
      this.resonators.push(new RingsResonator());
    }
    this.strings = [];
    this.lfos = [];
    for (let i = 0; i < RINGS_NUM_STRINGS; i++) {
      this.strings.push(new RingsString(false, this.random));
      this.lfos.push(new CosineOscillator());
    }
    this.limiter = new RingsLimiter();

    // The control rate is one tick per block — `kSampleRate / kMaxBlockSize` = 2 kHz —
    // and the four time constants are `part.cc:60`'s comments verbatim.
    this.noteFilter = new RingsNoteFilter(RINGS_SAMPLE_RATE / RINGS_BLOCK_SIZE,
      0.001, 0.010, 0.050, 0.004);

    const n = RINGS_BLOCK_SIZE;
    this.resonatorInput = new Float32Array(n);
    this.outBuffer = new Float32Array(n);
    this.auxBuffer = new Float32Array(n);
    this.noiseBurst = new Float32Array(n);
    this.sympatheticInput = new Float32Array(n);
    this.frequencies = new Float64Array(RINGS_NUM_STRINGS);
    this.sympatheticNotes = new Float64Array(9);
    this.previousNote = A3_MIDI_NOTE;
    this.lastStrum = false;
    this.inhibitCounter = 0;
    // `Rings.cpp:96` — `strummer.Init(0.01, 44100/24)`, so the inhibit window is 10 ms
    // of CONTROL ticks at the rate the wrapper passes, not at Rings' own.
    this.inhibitTimer = Math.trunc(0.01 * (44100 / RINGS_BLOCK_SIZE));
  }

  /** Command. The `model` option (`ax2OptionSetter`'s convention). */
  setModel(model) {
    if (!RINGS_MODELS.includes(model)) {
      throw new Error(`RingsKernel: model ${JSON.stringify(model)} is not one of ${RINGS_MODELS.join(", ")} (deviation R1)`);
    }
    if (model !== this.model) this.dirty = true;
    this.model = model;
  }

  /** Command. The `polyphony` option — 1, 2 or 4, as `Rings.cpp:135`'s `1 << mode`. */
  setPolyphony(polyphony) {
    const value = Number(polyphony);
    if (value !== 1 && value !== 2 && value !== 4) {
      throw new Error(`RingsKernel: polyphony ${JSON.stringify(polyphony)} must be 1, 2 or 4 (Rings.cpp renders 1 << mode for mode in 0..2)`);
    }
    if (value !== this.polyphony) this.dirty = true;
    this.polyphony = value;
  }

  /** Command. The `exciter` option — `internal` substitutes a pulse or a noise burst and
   *  retunes the excitation filter; `external` filters whatever is on `in`. */
  setExciter(value) {
    this.internalExciter = vc1SourceIsInternal("exciter", value);
  }

  /** Command. The `strumSource` option. */
  setStrumSource(value) {
    this.internalStrum = vc1SourceIsInternal("strumSource", value);
  }

  /** Command. The `noteSource` option. */
  setNoteSource(value) {
    this.internalNote = vc1SourceIsInternal("noteSource", value);
  }

  /** Command. `ConfigureResonators` — rebuild whatever the model needs. Only runs when
   *  the model or the polyphony changed, because it CLEARS every resonator's state. */
  configureResonators() {
    if (!this.dirty) return;
    if (this.model === "modal") {
      const resolution = RINGS_MAX_MODES / this.polyphony - RINGS_MODAL_RESOLUTION_MARGIN;
      for (let i = 0; i < this.polyphony; i++) {
        this.resonators[i] = new RingsResonator();
        this.resonators[i].setResolution(resolution);
      }
    } else {
      // `part.cc:88` — seven mutually prime LFO rates so the sympathetic strings never
      // beat into a common period.
      const lfoFrequencies = [0.5, 0.4, 0.35, 0.23, 0.211, 0.2, 0.171];
      const hasDispersion = this.model === "string";
      for (let i = 0; i < RINGS_NUM_STRINGS; i++) {
        this.strings[i] = new RingsString(hasDispersion, this.random);
        const rate = lfoFrequencies[i % lfoFrequencies.length];
        this.lfos[i].initApproximate((RINGS_BLOCK_SIZE / RINGS_SAMPLE_RATE) * rate);
      }
      for (let i = 0; i < this.polyphony; i++) this.pluckers[i] = new RingsPlucker(this.random);
    }
    if (this.activeVoice >= this.polyphony) this.activeVoice = 0;
    this.dirty = false;
  }

  /**
   * Command. `ComputeSympatheticStringsNotes` (part.cc:242) — the chord the sympathetic
   * model tunes its extra strings to, written into `this.sympatheticNotes`.
   *
   * `Squash` (part.h:127) is an eighth-power S-curve that makes the interpolation between
   * two chord degrees SNAP: STRUCTURE sweeps continuously but the strings sit on real
   * intervals for most of the travel. The `parameter += (1 − parameter) · 0.2` inside the
   * loop is what fans the higher strings out faster than the lower ones.
   */
  computeSympatheticNotes(tonic, note, parameter, destination, numStrings) {
    const notes = [
      tonic, note - 12, note - 7.01955, note, note + 7.01955,
      note + 12, note + 19.01955, note + 24, note + 24,
    ];
    const detunings = [0.013, 0.011, 0.007, 0.017];
    const numDetuned = (numStrings - 1) >> 1;
    const firstDetuned = numStrings - numDetuned;
    let p = parameter;
    for (let i = 0; i < firstDetuned; i++) {
      let index = 3;
      if (i !== 0) {
        index = p * 7;
        p += (1 - p) * 0.2;
      }
      const integral = Math.trunc(index);
      const fractional = squashRings(index - integral);
      const a = notes[integral];
      const b = notes[integral + 1];
      destination[i] = a + (b - a) * fractional;
      if (i + firstDetuned < numStrings) {
        destination[i + firstDetuned] = destination[i] + detunings[i & 3];
      }
    }
  }

  /** Command. `RenderModalVoice` (part.cc:298). */
  renderModalVoice(voice, patch, internalExciter, strum, frequency, filterCutoff, count) {
    if (internalExciter && voice === this.activeVoice && strum) {
      // The internal exciter for the modal model is ONE SAMPLE, scaled so that a bright
      // setting does not also mean a loud one (part.cc:307).
      this.resonatorInput[0] += (0.25 * semitonesToRatio(filterCutoff * filterCutoff * 24)) / filterCutoff;
    }
    const filter = this.excitationFilter[voice];
    for (let i = 0; i < count; i++) {
      this.resonatorInput[i] = filter.process(this.resonatorInput[i], FILTER_MODE_LOW_PASS);
    }
    const r = this.resonators[voice];
    r.frequency = frequency;
    r.structure = patch.structure;
    // BRIGHTNESS IS SQUARED for the modal model and not for the strings (part.cc:319).
    r.brightness = patch.brightness * patch.brightness;
    r.position = patch.position;
    r.damping = patch.damping;
    r.process(this.resonatorInput, this.outBuffer, this.auxBuffer, count);
  }

  /** Command. `RenderStringVoice` (part.cc:347). */
  renderStringVoice(voice, patch, performance, frequency, filterCutoff, count) {
    const sympathetic = this.model === "sympathetic";
    let numStrings = 1;
    if (sympathetic) {
      numStrings = (2 * RINGS_MAX_POLYPHONY) / this.polyphony;
      this.computeSympatheticNotes(
        performance.tonic + performance.fm,
        performance.tonic + this.notes[voice] + performance.fm,
        patch.structure, this.sympatheticNotes, numStrings);
      for (let i = 0; i < numStrings; i++) {
        this.frequencies[i] = semitonesToRatio(this.sympatheticNotes[i] - A3_MIDI_NOTE) * RINGS_A3;
      }
    } else {
      this.frequencies[0] = frequency;
    }

    if (voice === this.activeVoice) {
      const gain = 1 / Math.sqrt(numStrings * 2);
      for (let i = 0; i < count; i++) this.resonatorInput[i] *= gain;
    }

    const filter = this.excitationFilter[voice];
    for (let i = 0; i < count; i++) {
      this.resonatorInput[i] = filter.process(this.resonatorInput[i], FILTER_MODE_LOW_PASS);
    }

    if (performance.internalExciter) {
      if (voice === this.activeVoice && performance.strum) {
        this.pluckers[voice].trigger(frequency, filterCutoff * 8, patch.position);
      }
      this.pluckers[voice].process(this.noiseBurst, count);
      for (let i = 0; i < count; i++) this.resonatorInput[i] += this.noiseBurst[i];
    }
    const dc = this.dcBlockers[voice];
    for (let i = 0; i < count; i++) this.resonatorInput[i] = dc.process(this.resonatorInput[i]);

    this.outBuffer.fill(0, 0, count);
    this.auxBuffer.fill(0, 0, count);

    // STRUCTURE's dead zone for the string models: exactly harmonic between 0.24 and
    // 0.26, and asymmetric outside it (part.cc:404). The 4.166 below and the 1.35135
    // above are what put dispersion 0 at 0.24/0.26 and ±1 at the knob's ends.
    const structure = patch.structure;
    const dispersion = structure < 0.24
      ? (structure - 0.24) * 4.166
      : (structure > 0.26 ? (structure - 0.26) * 1.35135 : 0);

    for (let string = 0; string < numStrings; string++) {
      const index = voice + string * this.polyphony;
      const s = this.strings[index];
      const lfoValue = this.lfos[index].next();

      let brightness = patch.brightness;
      let damping = patch.damping;
      let position = patch.position;
      let glide = 1;
      const stringIndex = string / numStrings;
      let source = this.resonatorInput;

      // String 0 is struck; the rest ring by SYMPATHY, fed from string 0's own output.
      // They are darker, damped differently, and their pickup position wanders on the
      // per-string LFO — that wander is what stops the extra strings sounding like a
      // chorus of identical copies (part.cc:428).
      if (string > 0 && performance.internalExciter) {
        brightness *= 2 - brightness;
        brightness *= 2 - brightness;
        damping = 0.7 + patch.damping * 0.27;
        const amount = (0.5 - Math.abs(0.5 - patch.position)) * 0.9;
        position = patch.position + lfoValue * amount;
        glide = semitonesToRatio((brightness - 1) * 36);
        source = this.sympatheticInput;
      }

      s.setDispersion(dispersion);
      s.setFrequency(this.frequencies[string], glide);
      s.brightness = brightness;
      s.position = position;
      s.damping = damping + stringIndex * (0.95 - damping);
      s.process(source, this.outBuffer, this.auxBuffer, count);

      if (string === 0) {
        const gain = 0.2 / numStrings;
        for (let i = 0; i < count; i++) {
          this.sympatheticInput[i] = gain * (this.outBuffer[i] - this.auxBuffer[i]);
        }
      }
    }
  }

  /**
   * Command. One block. `input` is `blockSize` mono samples; `output` is interleaved
   * `[odd, even]` pairs.
   *
   * `controls` carries: structure, brightness, damping, position (0…1 knobs);
   * structureMod, brightnessMod, dampingMod, positionMod, frequencyMod (±1 trims);
   * structureCv, brightnessCv, dampingCv, positionCv, frequencyCv (wires, knob units);
   * frequency (0…60, the FREQUENCY knob); pitch (semitones); strum (gate);
   * internalExciter, internalStrum, internalNote (booleans — deviation R3).
   */
  render(controls, input, output) {
    const size = RINGS_BLOCK_SIZE;
    this.configureResonators();

    const patch = this.patch || (this.patch = { structure: 0, brightness: 0, damping: 0, position: 0 });
    const bind = (knob, trim, cv, ceiling) => {
      const value = knob + 3.3 * quadraticBipolar(trim) * cv;
      return Math.min(Math.max(value, 0), ceiling);
    };
    // `Rings.cpp:148` clamps structure, damping and position to 0.9995 and brightness to
    // 1. The 0.9995 is not cosmetic: structure 1.0 would index one past `lut_stiffness`
    // and damping 1.0 puts the string's crossfade-to-infinite at exactly unity gain.
    patch.structure = bind(controls.structure, controls.structureTrim, controls.structure_mod, 0.9995);
    patch.brightness = bind(controls.brightness, controls.brightnessTrim, controls.brightness_mod, 1);
    patch.damping = bind(controls.damping, controls.dampingTrim, controls.damping_mod, 0.9995);
    patch.position = bind(controls.position, controls.positionTrim, controls.position_mod, 0.9995);

    const performance = this.performance || (this.performance = {
      note: 0, tonic: 0, fm: 0, strum: false,
      internalExciter: true, internalStrum: true, internalNote: true,
    });
    performance.internalExciter = this.internalExciter;
    performance.internalStrum = this.internalStrum;
    performance.internalNote = this.internalNote;
    performance.note = controls.pitch;
    // The FREQUENCY knob is QUANTISED TO SEMITONES when V/oct is in use, so a tracked
    // patch stays in tune while a free-running one can be swept (`Rings.cpp:150`).
    let transpose = controls.frequency;
    if (!performance.internalNote) transpose = Math.round(transpose);
    performance.tonic = 12 + Math.min(Math.max(transpose, 0), 60);
    performance.fm = Math.min(Math.max(
      48 * 3.3 * quarticBipolar(controls.frequencyTrim) * controls.frequency_mod, -48), 48);

    // The wrapper's rising-edge detection on the STRUM gate, then the Strummer's
    // internal-strum override, then the inhibit window. That ORDER is the source's.
    let strum = controls.strum && !this.lastStrum;
    this.lastStrum = controls.strum;
    let inhibitTimer = this.inhibitTimer;
    if (performance.internalStrum) {
      if (!performance.internalNote) {
        strum = Math.abs(performance.note - this.previousNote) > 0.4;
      } else {
        // Deviation R2: this is where `onset_detector` would fire on an audio transient.
        strum = false;
        inhibitTimer *= 4;
      }
    }
    if (this.inhibitCounter) {
      this.inhibitCounter -= 1;
      strum = false;
    } else if (strum) {
      this.inhibitCounter = inhibitTimer;
    }
    this.previousNote = performance.note;
    performance.strum = strum;

    this.noteFilter.process(performance.note, strum);
    if (strum) {
      this.notes[this.activeVoice] = this.noteFilter.stableNote();
      if (this.polyphony > 1 && this.polyphony & 1) {
        this.activeVoice = RINGS_PING_PATTERN[this.stepCounter % 8];
        this.stepCounter = (this.stepCounter + 1) % 8;
      } else {
        this.activeVoice = (this.activeVoice + 1) % this.polyphony;
      }
    }
    this.notes[this.activeVoice] = this.noteFilter.noteValue;

    const outAccum = this.outAccum || (this.outAccum = new Float32Array(size));
    const auxAccum = this.auxAccum || (this.auxAccum = new Float32Array(size));
    outAccum.fill(0);
    auxAccum.fill(0);

    for (let voice = 0; voice < this.polyphony; voice++) {
      const cutoff = patch.brightness * (2 - patch.brightness);
      const note = this.notes[voice] + performance.tonic + performance.fm;
      const frequency = semitonesToRatio(note - A3_MIDI_NOTE) * RINGS_A3;
      // The excitation filter tracks the NOTE when the internal exciter runs and sits at
      // a fixed 0.4 of Nyquist when an external signal is being filtered — two different
      // musical jobs on one control (part.cc:503).
      const filterCutoffRange = performance.internalExciter
        ? frequency * semitonesToRatio((cutoff - 0.5) * 96)
        : 0.4 * semitonesToRatio((cutoff - 1) * 108);
      const filterCutoff = Math.min(
        voice === this.activeVoice ? filterCutoffRange : 10 / RINGS_SAMPLE_RATE, 0.499);
      const filterQ = performance.internalExciter ? 1.5 : 0.8;
      this.excitationFilter[voice].setFQ(filterCutoff, filterQ, tanDirty);

      if (voice === this.activeVoice) {
        this.resonatorInput.set(input.subarray(0, size));
      } else {
        this.resonatorInput.fill(0, 0, size);
      }

      if (this.model === "modal") {
        this.renderModalVoice(voice, patch, performance.internalExciter, strum,
          frequency, filterCutoff, size);
      } else {
        this.renderStringVoice(voice, patch, performance, frequency, filterCutoff, size);
      }

      if (this.polyphony === 1) {
        for (let i = 0; i < size; i++) {
          outAccum[i] += this.outBuffer[i];
          auxAccum[i] += this.auxBuffer[i];
        }
      } else {
        const destination = voice & 1 ? auxAccum : outAccum;
        for (let i = 0; i < size; i++) destination[i] += this.outBuffer[i] - this.auxBuffer[i];
      }
    }

    this.limiter.process(outAccum, auxAccum, size, RINGS_MODEL_GAINS[RINGS_MODELS.indexOf(this.model)]);
    for (let i = 0; i < size; i++) {
      output[i * 2] = outAccum[i];
      output[i * 2 + 1] = auxAccum[i];
    }
  }
}

/**
 * Pure function. `Part::Squash` (part.h:127) — a symmetric eighth-power S-curve on
 * [0,1]: `x < 0.5 → (2x)^16/2`, else `1 − (2−2x)^16/2`. Named because the exponent is
 * built by repeated squaring in the source and the shape is not obvious from that.
 *
 * @param {number} x - in [0, 1]
 * @returns {number} in [0, 1]
 *
 * @example squashRings(0) // 0
 * @example squashRings(1) // 1
 * @example squashRings(0.5) // 0.5
 * @example squashRings(0.25) < 0.0001 // true
 */
export function squashRings(x) {
  if (x < 0.5) {
    let v = x * 2;
    v *= v;
    v *= v;
    v *= v;
    v *= v;
    return v * 0.5;
  }
  let v = 2 - 2 * x;
  v *= v;
  v *= v;
  v *= v;
  v *= v;
  return 1 - 0.5 * v;
}

// ════════════════════════════════════════════════════════════════════════════
// MARBLES — two coupled random generators
// ════════════════════════════════════════════════════════════════════════════
//
// ── DERIVATION RECORD, AND A WARNING ABOUT WHICH SOURCE TO READ ─────────────
// **READ THE FORK, NOT `pichenettes/eurorack`.** `AudibleInstruments`'s `eurorack`
// submodule points at `github.com/VCVRack/pichenettes-eurorack` @9739c022 — a DIFFERENT
// REPOSITORY, whose object is not even reachable from a `pichenettes/eurorack` clone
// (`git cat-file -t` fails). Marbles' files DIFFER between the two, and one of the
// differences is behavioural rather than cosmetic (see M1). Ported from the fork.
//
// ALGORITHM   eurorack_rack (VCVRack/pichenettes-eurorack) @ 9739c022:
//               marbles/random/t_generator.cc      Process(), ConfigureSlaveRamps(),
//                                                  GenerateComplementaryBernoulli(),
//                                                  GenerateDrums(), GenerateMarkov()
//               marbles/random/x_y_generator.cc    Process(), the clock routing
//               marbles/random/output_channel.cc   Process(), GenerateNewVoltage()
//               marbles/random/random_sequence.h   NextValue(), NextVector(), the replay
//               marbles/random/quantizer.cc        Init(), Process()
//               marbles/random/lag_processor.cc    Process()
//               marbles/random/distributions.h     BetaDistributionSample()
//               marbles/ramp/{slave_ramp,ramp_divider}.h
//               marbles/note_filter.h
//               marbles/resources/lookup_tables.py raised_cosine, logit, dist_icdf_*
//             cross-checked against `pichenettes/eurorack` @08460a6 to establish which
//             differences are real; all but M1 are the reset path, which Rack never uses.
// RANGES/CV   AudibleInstruments @ a1cd335e: src/Marbles.cpp — configParam 269…302, the CV
//             arithmetic in `stepBlock()`, the 5-frame block, and the six preset scales.
// HELPERS     stmlib @ d18def81 (`HysteresisQuantizer`, the v1 class this revision uses —
//             NOT `HysteresisQuantizer2`, whose `Init(steps, hysteresis, symmetric)` API
//             the newer eurorack switched to and whose cell mapping differs).
//
// ── WHAT THE MODULE IS ──────────────────────────────────────────────────────
// TWO generators sharing one deja-vu register. The **t** side makes CLOCKS: a master ramp
// (internal or followed from an external clock), two slave ramps whose division pattern one
// of seven models picks, and a jitter multiplier drawn from a Beta distribution. The **X**
// side makes VOLTAGES: three channels clocked from the t side, each drawing from a Beta
// whose shape SPREAD and BIAS set, optionally quantised to one of six scales or slewed by
// a lag processor. **DEJA VU IS THE WHOLE POINT** — see M-DV below.
//
// ── DEVIATIONS THAT ARE MARBLES' OWN ────────────────────────────────────────
// M1. THE DEJA-VU DRAW IS THE FORK'S, WHICH DRAWS TWICE. `pichenettes/eurorack` @08460a6
//     hoists the coin into `const bool mutate = GetFloat() < p` and tests it in both
//     branches; the pinned fork calls `GetFloat() <= p` SEPARATELY in each. That is not a
//     refactor: in the fork, a deja-vu below 0.5 can BOTH write a new value (probability p)
//     AND, failing that, jump randomly (probability p again), so the lower half of the knob
//     mutates the loop AND shuffles it. The newer revision does only the first. Ported as
//     the fork has it, because that is what Rack compiles.
// M2. THE RAMP EXTRACTOR IS SIMPLIFIED, AND THIS IS THE BLOCK'S LARGEST GAP. Mutable's
//     `ramp_extractor.cc` follows an external clock with THIRTEEN concurrent predictors —
//     two one-pole moving averages, a trigram hash and ten periodicity detectors, scored by
//     `1/(1 + 100·error²)` — so it locks to a swung or polyrhythmic clock and predicts the
//     next edge. Ours measures the interval between rising edges and runs the master phase
//     at that rate with the ratio applied. On a STEADY clock the two agree; on a clock that
//     changes tempo ours takes one period to follow where Mutable's anticipates, and on a
//     rhythmically patterned clock ours does not learn the pattern at all. It also carries
//     none of the extractor's hard-coded 32 kHz constants, which in Rack are ~1.4× off at
//     48 kHz. Said plainly: an externally-clocked Marbles is APPROXIMATE here.
// M3. THE BETA ICDF IS EVALUATED, NOT TABULATED. The source bilinearly interpolates four of
//     45 precomputed 387-entry `scipy.stats.beta.ppf` tables over a 5×9 (bias, spread) grid.
//     Generating those needs scipy, so instead the (mu, nu) PARAMETERS are interpolated on
//     the same grid — including the source's own `corrected_mu` warp, which is what makes
//     BIAS behave — and the Beta ICDF is then evaluated exactly by bisecting the regularised
//     incomplete beta. At a grid node the two agree to the table's own 1/128 interpolation
//     error; between nodes ours is smoother. `tests/port_vc1_test.js` validates the ICDF
//     against the three Beta cases with closed forms (B(1,1), B(2,1), B(1,2)) rather than
//     against tables it cannot generate — so the ICDF is proven and the grid warp is
//     transcribed but UNMEASURED. That is the honest split.
// M4. POLYPHONY AND THE `external` REGISTER MODE'S CV. Rack's Marbles is mono, so nothing is
//     lost there. Its register-mode input, however, REUSES the X-spread knob and carries a
//     `// TODO Fix the scaling` in the wrapper: with no CV the register value lands in
//     0.5…0.75, i.e. 0…2.5 V rather than the hardware's full range. Reproduced as written,
//     because a patch made in Rack was made against that.
// M5. THE Y CHANNEL'S QUANTIZER IS NEVER LOADED IN RACK, and its `Scale::Init()` default has
//     one degree — so `Quantizer::Process` at level ≥ 1 reads `voltage_[0xff]` off the end of
//     a 16-float array. Undefined behaviour in C++, reachable from Rack because the wrapper
//     sets `y.steps = x_steps`. Ours loads the SAME scale into channel 3, which is the
//     evident intent (`LoadScale`'s loop stops at `kNumXChannels`) and cannot fault. A
//     deliberate divergence from a bug rather than a reproduction of one.

/** `marbles/cv_reader.cc`'s `ADC_CHANNEL_T_RATE` hard limits, in semitones — the clamp
 *  deviation M6 restores. ±120 is ten octaves either way, i.e. 0.002 Hz to 2 kHz at the 1×
 *  range, which is past any musical use and short of the point where the phase overflows. */
export const MARBLES_RATE_LIMIT = 120;

/** `marbles/io_buffer.h:40` — frames per `stepBlock()`, and therefore per render. */
export const MARBLES_BLOCK_SIZE = 5;

/** `random_sequence.h` — the deja-vu register and the replay history are both 16 deep. */
const MARBLES_LOOP_SIZE = 16;
const MARBLES_HISTORY_SIZE = 16;

/** `t_generator.h` — two t channels, an 8-step drum pattern, 18 patterns, 17 divider
 *  patterns, 9 input ratios, a 16-deep Markov history. */
const MARBLES_T_CHANNELS = 2;
const MARBLES_DRUM_PATTERN_SIZE = 8;
const MARBLES_MARKOV_HISTORY = 16;

/** `ramp/ramp.h` — a slave ramp's own ceiling, one raw step below unity. */
const MARBLES_MAX_RAMP_VALUE = 0.9999;

/** `x_y_generator.h` — three X channels plus Y makes four output channels. */
const MARBLES_X_CHANNELS = 3;
const MARBLES_CHANNELS = 4;

/** `x_y_generator.cc:71` — blocks the X outputs stay muted after switching to an external
 *  clock, a hardware normalisation artefact Rack inherits. */
const MARBLES_EXTERNAL_STABILISATION = 16;

/** `t_generator.h:44` — the seven t models, in the enum's order. The Rack BUTTON only
 *  cycles the first three; the context menu reaches all seven and `set_model` passes the
 *  raw value, so all seven are real and all seven are ported. */
export const MARBLES_T_MODELS = [
  "complementaryBernoulli", "clusters", "drums",
  "independentBernoulli", "divider", "threeStates", "markov",
];

/** The three X control modes (`ControlMode`). */
export const MARBLES_X_MODES = ["identical", "bump", "tilt"];

/** The three t ranges, and their rate multipliers (`t_generator.cc`'s `rate_base`). */
export const MARBLES_T_RANGES = ["0.25x", "1x", "4x"];
const MARBLES_T_RANGE_BASE = [0.5, 2, 8];

/**
 * The three output voltage ranges, as `[scale, offset]` in VOLTS — `x_y_generator.cc:136`.
 *
 * KEPT IN VOLTS, not converted to wire units here, and that is deliberate: the QUANTIZER's
 * base interval is one octave = one volt, so quantising in wire units would put its scale
 * degrees a fifth of an octave apart. `MarblesOutputChannel` therefore works in volts
 * throughout and `MarblesKernel` divides by five exactly once, at the output.
 */
export const MARBLES_X_RANGES = ["narrow", "positive", "full"];
const MARBLES_X_RANGE_SCALE_OFFSET = [[2, 0], [5, 0], [10, -5]];

/** `Marbles.cpp:517` — the twelve Y divider ratios, as `[p, q]`. */
const MARBLES_Y_DIVIDERS = [
  [1, 64], [1, 48], [1, 32], [1, 24], [1, 16], [1, 12],
  [1, 8], [1, 6], [1, 4], [1, 3], [1, 2], [1, 1],
];

/** The Y divider's labels, in the same order — the palette needs the musical name. */
export const MARBLES_Y_DIVIDER_LABELS = [
  "1/64", "1/48", "1/32", "1/24", "1/16", "1/12", "1/8", "1/6", "1/4", "1/3", "1/2", "1",
];

/** The four internal X clock sources plus the external one (`ClockSource`). */
export const MARBLES_CLOCK_SOURCES = ["t1t2t3", "t1", "t2", "t3"];

/** `Marbles.cpp:280` — the 36-entry loop-length ladder the knob indexes. The FIRMWARE has a
 *  73-entry table with a different curve; the Rack one is what a patch's knob value means. */
const MARBLES_LOOP_LENGTHS = [
  1, 1, 1, 2, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 4, 5, 5, 6,
  6, 6, 7, 7, 8, 8, 8, 10, 10, 12, 12, 12, 14, 14, 16, 16,
];

/** `t_generator.cc:43` — the CLUSTERS model's weighted pattern pool, `[[p,q],[p,q]], length`. */
const MARBLES_DIVIDER_PATTERNS = [
  [[[1, 1], [1, 1]], 1], [[[1, 1], [2, 1]], 1], [[[1, 2], [1, 1]], 2],
  [[[1, 1], [4, 1]], 1], [[[1, 2], [2, 1]], 2], [[[1, 1], [3, 2]], 2],
  [[[1, 4], [4, 1]], 4], [[[1, 4], [2, 1]], 4], [[[1, 2], [3, 2]], 2],
  [[[1, 1], [8, 1]], 1], [[[1, 1], [3, 1]], 1], [[[1, 3], [1, 1]], 3],
  [[[1, 1], [5, 4]], 4], [[[1, 2], [5, 4]], 4], [[[1, 1], [6, 1]], 1],
  [[[1, 3], [2, 1]], 3], [[[1, 1], [16, 1]], 1],
];

/** `t_generator.cc:63` — the DIVIDER model's pool, indexed DIRECTLY by BIAS, so it is
 *  ordered rather than weighted and index 8 (unison) sits at knob centre. */
const MARBLES_FIXED_DIVIDER_PATTERNS = [
  [[[8, 1], [1, 8]], 8], [[[6, 1], [1, 6]], 6], [[[4, 1], [1, 4]], 4],
  [[[3, 1], [1, 3]], 3], [[[2, 1], [1, 2]], 2], [[[3, 2], [2, 3]], 6],
  [[[4, 3], [3, 4]], 12], [[[5, 4], [4, 5]], 20],
  [[[1, 1], [1, 1]], 1],
  [[[4, 5], [5, 4]], 20], [[[3, 4], [4, 3]], 12], [[[2, 2], [3, 2]], 6],
  [[[1, 2], [2, 1]], 2], [[[1, 3], [3, 1]], 3], [[[1, 4], [4, 1]], 4],
  [[[1, 6], [6, 1]], 6], [[[1, 8], [8, 1]], 8],
];

/** `t_generator.cc:87` — the nine ratios an external clock can be divided or multiplied by. */
const MARBLES_INPUT_DIVIDER_RATIOS = [
  [1, 4], [1, 3], [1, 2], [2, 3], [1, 1], [3, 2], [2, 1], [3, 1], [4, 1],
];

/** `t_generator.cc:101` — the eighteen drum patterns. 1 fires T1, 2 fires T3, 0 neither;
 *  no entry is 3, so DRUMS never fires both outputs on one tick. */
const MARBLES_DRUM_PATTERNS = [
  [1, 0, 0, 0, 2, 0, 0, 0], [0, 0, 1, 0, 2, 0, 0, 0],
  [1, 0, 1, 0, 2, 0, 0, 0], [0, 0, 1, 0, 2, 0, 0, 2],
  [1, 0, 1, 0, 2, 0, 1, 0], [0, 2, 1, 0, 2, 0, 0, 2],
  [1, 0, 0, 0, 2, 0, 1, 0], [0, 2, 1, 0, 2, 0, 1, 2],
  [1, 0, 0, 1, 2, 0, 0, 0], [0, 2, 1, 1, 2, 0, 1, 2],
  [1, 0, 0, 1, 2, 0, 1, 0], [0, 2, 1, 1, 2, 2, 1, 2],
  [1, 0, 0, 1, 2, 0, 1, 2], [0, 2, 0, 1, 2, 0, 1, 2],
  [0, 2, 0, 1, 2, 0, 1, 2], [1, 0, 1, 1, 2, 0, 1, 2],
  [2, 0, 1, 2, 0, 1, 2, 0], [1, 2, 1, 1, 2, 0, 1, 2],
];

/**
 * `Marbles.cpp:12` — the six preset scales, as `[semitoneFraction, weight]` pairs with an
 * implicit base interval of one octave. A weight of 255 means "always available"; the
 * quantizer's seven levels are thresholds on these, so turning STEPS up removes the
 * lightly-weighted degrees first and ends on the root alone.
 *
 * ONE DIVERGENCE FROM THE FIRMWARE IS PRESERVED HERE DELIBERATELY: C minor's G♯ and A carry
 * weights 16 and 96 in Rack and 96 and 16 in `marbles/settings.cc`. The firmware's is the
 * musically conventional natural minor; Rack's is what every patch in this set was made
 * against, so Rack's is what is ported.
 */
export const MARBLES_SCALES = [
  { name: "major", degrees: [[0, 255], [0.0833, 16], [0.1667, 96], [0.25, 24], [0.3333, 128], [0.4167, 64], [0.5, 8], [0.5833, 192], [0.6667, 16], [0.75, 96], [0.8333, 24], [0.9167, 128]] },
  { name: "minor", degrees: [[0, 255], [0.0833, 16], [0.1667, 96], [0.25, 128], [0.3333, 8], [0.4167, 64], [0.5, 4], [0.5833, 192], [0.6667, 16], [0.75, 96], [0.8333, 128], [0.9167, 16]] },
  { name: "pentatonic", degrees: [[0, 255], [0.0833, 4], [0.1667, 96], [0.25, 4], [0.3333, 4], [0.4167, 140], [0.5, 4], [0.5833, 192], [0.6667, 4], [0.75, 96], [0.8333, 4], [0.9167, 4]] },
  { name: "pelog", degrees: [[0, 255], [0.1275, 128], [0.2625, 32], [0.46, 8], [0.5883, 192], [0.7067, 64], [0.8817, 16]] },
  { name: "bhairav", degrees: [[0, 255], [0.0752, 128], [0.1699, 4], [0.263, 4], [0.3219, 128], [0.415, 64], [0.4918, 4], [0.585, 192], [0.6601, 64], [0.7549, 4], [0.8479, 4], [0.9069, 64]] },
  { name: "shri", degrees: [[0, 255], [0.0752, 4], [0.1699, 128], [0.263, 64], [0.3219, 4], [0.415, 128], [0.4918, 4], [0.585, 192], [0.6601, 4], [0.7549, 64], [0.8479, 128], [0.9069, 4]] },
];

/** The scale names, for the spec's option list. */
export const MARBLES_SCALE_NAMES = MARBLES_SCALES.map((scale) => scale.name);

/** `quantizer.cc` — the seven weight thresholds a quantizer level maps to. */
const MARBLES_THRESHOLDS = [0, 16, 32, 64, 128, 192, 255];

/**
 * Pure function. `lut_raised_cosine` (marbles/resources/lookup_tables.py):
 * `0.5 − 0.5·cos(πx)`. The lag processor warps its ramp through this so a glide eases in
 * and out instead of being linear.
 *
 * @param {number} size - entries minus one
 * @returns {Float32Array}
 *
 * @example buildRaisedCosineTable(4)[0] // 0
 * @example buildRaisedCosineTable(4)[4] // 1
 */
export function buildRaisedCosineTable(size) {
  const table = new Float32Array(size + 1);
  for (let i = 0; i <= size; i++) table[i] = 0.5 - 0.5 * Math.cos((i / size) * Math.PI);
  return table;
}

/**
 * Pure function. `lut_logit`: `p = 2^L/(1 + 2^L)` for `L` spanning ±10, in 257 steps —
 * a logistic in BASE TWO, not e. The Markov model reads it by a bare truncated index, not
 * by interpolation, so the quantisation is part of the behaviour.
 *
 * @param {number} size - entries minus one
 * @returns {Float32Array}
 *
 * @example Math.abs(buildLogitTable(256)[128] - 0.5) < 1e-6 // true
 * @example buildLogitTable(256)[0] < 0.001 // true
 * @example buildLogitTable(256)[256] > 0.999 // true
 */
export function buildLogitTable(size) {
  const table = new Float32Array(size + 1);
  for (let i = 0; i <= size; i++) {
    const logOdds = (i / size) * 20 - 10;
    const odds = Math.pow(2, logOdds);
    table[i] = odds / (1 + odds);
  }
  return table;
}

const MARBLES_TABLE_SIZE = 256;
const MARBLES_RAISED_COSINE = buildRaisedCosineTable(MARBLES_TABLE_SIZE);
const MARBLES_LOGIT = buildLogitTable(MARBLES_TABLE_SIZE);

// ── THE BETA DISTRIBUTION (deviation M3) ────────────────────────────────────

/**
 * Pure function. `ln B(a, b)` by Lanczos — the normaliser the regularised incomplete beta
 * needs. Split out because it is the only place a gamma function appears in this block.
 *
 * @param {number} a
 * @param {number} b
 * @returns {number}
 *
 * @example Math.abs(logBeta(1, 1)) < 1e-12 // true
 * @example Math.abs(logBeta(2, 1) - Math.log(0.5)) < 1e-12 // true
 */
export function logBeta(a, b) {
  return logGamma(a) + logGamma(b) - logGamma(a + b);
}

/**
 * Pure function. `ln Γ(x)` for x > 0, Lanczos g = 7, n = 9. Accurate to about 1e-13
 * relative across the range the Beta parameters here reach (0.02…512).
 *
 * @param {number} x - must be positive
 * @returns {number}
 *
 * @example Math.abs(logGamma(1)) < 1e-10 // true
 * @example Math.abs(logGamma(5) - Math.log(24)) < 1e-10 // true
 */
export function logGamma(x) {
  const coefficients = [
    676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012,
    9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (x < 0.5) {
    // Reflection, so the series' domain assumption holds.
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  }
  const z = x - 1;
  let series = 0.99999999999980993;
  for (let i = 0; i < coefficients.length; i++) series += coefficients[i] / (z + i + 1);
  const t = z + coefficients.length - 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(series);
}

/**
 * Pure function. The regularised incomplete beta `I_x(a, b)` — the Beta CDF — by Lentz's
 * continued fraction with the standard symmetry swap.
 *
 * @param {number} x - in [0, 1]
 * @param {number} a
 * @param {number} b
 * @returns {number} the CDF at x
 *
 * @example incompleteBeta(0.5, 1, 1) // 0.5
 * @example Math.abs(incompleteBeta(0.25, 2, 1) - 0.0625) < 1e-12 // true
 * @example Math.abs(incompleteBeta(0.5, 1, 2) - 0.75) < 1e-12 // true
 */
export function incompleteBeta(x, a, b) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  // The continued fraction converges fast only for x below (a+1)/(a+b+2); above it, use
  // I_x(a,b) = 1 − I_(1−x)(b,a).
  if (x > (a + 1) / (a + b + 2)) return 1 - incompleteBeta(1 - x, b, a);
  const front = Math.exp(a * Math.log(x) + b * Math.log(1 - x) - logBeta(a, b)) / a;
  let f = 1;
  let c = 1;
  let d = 0;
  const tiny = 1e-30;
  for (let i = 0; i <= 300; i++) {
    const m = i >> 1;
    let numerator;
    if (i === 0) {
      numerator = 1;
    } else if (i % 2 === 0) {
      numerator = (m * (b - m) * x) / ((a + 2 * m - 1) * (a + 2 * m));
    } else {
      numerator = -(((a + m) * (a + b + m) * x) / ((a + 2 * m) * (a + 2 * m + 1)));
    }
    d = 1 + numerator * d;
    if (Math.abs(d) < tiny) d = tiny;
    d = 1 / d;
    c = 1 + numerator / c;
    if (Math.abs(c) < tiny) c = tiny;
    const delta = c * d;
    f *= delta;
    if (Math.abs(1 - delta) < 1e-12) break;
  }
  return front * (f - 1);
}

/**
 * Pure function. The Beta ICDF (`scipy.stats.beta.ppf`) by bisection on
 * `incompleteBeta`. Deviation M3: the source interpolates a precomputed table and this
 * evaluates the same distribution exactly, which is why the test can check it against the
 * three Beta cases that have closed forms.
 *
 * @param {number} u - in [0, 1]
 * @param {number} a
 * @param {number} b
 * @returns {number} in [0, 1]
 *
 * @example Math.abs(betaIcdf(0.3, 1, 1) - 0.3) < 1e-6 // true
 * @example Math.abs(betaIcdf(0.25, 2, 1) - 0.5) < 1e-6 // true
 * @example Math.abs(betaIcdf(0.75, 1, 2) - 0.5) < 1e-6 // true
 */
export function betaIcdf(u, a, b) {
  if (u <= 0) return 0;
  if (u >= 1) return 1;
  let low = 0;
  let high = 1;
  // 40 halvings resolves to 1e-12, which is far past what a 12-bit CV can express.
  for (let i = 0; i < 40; i++) {
    const mid = 0.5 * (low + high);
    if (incompleteBeta(mid, a, b) < u) low = mid;
    else high = mid;
  }
  return 0.5 * (low + high);
}

/** `distributions.h` — the (bias, spread) grid the source's 45 tables sit on. Ours
 *  interpolates the PARAMETERS on the same grid; see deviation M3. */
const MARBLES_NU_LOG2 = [9, 5, 3, 2.5, 2, 1.5, 1, 0.5, -1];
const MARBLES_MU = [0.05, 0.125, 0.25, 0.375, 0.5];

/**
 * Pure function. `BetaDistributionSample(uniform, spread, bias)` (distributions.h:48),
 * with the ICDF evaluated rather than looked up.
 *
 * THE `corrected_mu` WARP IS TRANSCRIBED AND IS WHAT MAKES BIAS BEHAVE: without it, a bias
 * near the ends would collapse the distribution to a spike, so the source pushes mu back
 * toward 0.5 by an amount that depends on how PEAKED the spread already is
 * (`error = exp(−(log2(nu) − 1)²/20)`). The `flip` at bias > 0.5 is why only the lower half
 * of the grid exists.
 *
 * @param {number} uniform - in [0, 1)
 * @param {number} spread - 0…1, low is peaked and high is flat
 * @param {number} bias - 0…1, where the mass sits
 * @returns {number} in [0, 1]
 *
 * @example Math.abs(betaDistributionSample(0.5, 0.5, 0.5) - 0.5) < 1e-6 // true
 * @example betaDistributionSample(0.5, 0.99, 0.9) > 0.5 // true
 * @example betaDistributionSample(0.5, 0.99, 0.1) < 0.5 // true
 */
export function betaDistributionSample(uniform, spread, bias) {
  let u = uniform;
  let mu = bias;
  const flip = mu > 0.5;
  if (flip) {
    u = 1 - u;
    mu = 1 - mu;
  }
  const muIndex = Math.min(Math.max(mu * (MARBLES_MU.length - 1) * 2, 0), MARBLES_MU.length - 1);
  const nuIndex = Math.min(Math.max(spread * (MARBLES_NU_LOG2.length - 1), 0), MARBLES_NU_LOG2.length - 1);
  const gridMu = interpolate(MARBLES_MU, muIndex / (MARBLES_MU.length - 1), MARBLES_MU.length - 1);
  const log2Nu = interpolate(MARBLES_NU_LOG2, nuIndex / (MARBLES_NU_LOG2.length - 1),
    MARBLES_NU_LOG2.length - 1);
  const nu = Math.pow(2, log2Nu);
  const error = Math.exp(-((log2Nu - 1) * (log2Nu - 1)) / 20);
  const correctedMu = 0.5 * Math.pow(2 * gridMu, 1 / (1 + 3 * error));
  const alpha = correctedMu * nu;
  const beta = (1 - correctedMu) * nu;
  const y = betaIcdf(u, alpha, beta);
  return flip ? 1 - y : y;
}

/** `distributions.h:75` — the T jitter's fixed distribution, `dist_icdf_4_3`, which is
 *  `mu = 0.5, nu = 2^2.5`, i.e. Beta(2.828, 2.828): "beta(3,3) with a fatter tail". */
const MARBLES_JITTER_NU = Math.pow(2, 2.5);

/**
 * Pure function. `FastBetaDistributionSample` — the T generator's jitter draw.
 *
 * @param {number} uniform - in [0, 1)
 * @returns {number} in [0, 1]
 *
 * @example Math.abs(fastBetaDistributionSample(0.5) - 0.5) < 1e-6 // true
 * @example fastBetaDistributionSample(0.1) < 0.3 // true
 */
export function fastBetaDistributionSample(uniform) {
  const half = MARBLES_JITTER_NU * 0.5;
  return betaIcdf(uniform, half, half);
}

/**
 * `stmlib::HysteresisQuantizer` (hysteresis_quantizer.h:38) — the V1 class, which is the
 * one this revision of Marbles uses. Command: it remembers its last index so a knob
 * sitting on a cell boundary cannot dither between two patterns.
 *
 * NOTE THE V1 CELL MAPPING: `value · (num_steps − 1)`, so the endpoints land on cell
 * CENTRES. `HysteresisQuantizer2` scales by `num_steps` and offsets by −0.5 instead, which
 * puts half-width cells at the ends — a different mapping, and using it would move which
 * divider pattern sits at knob centre.
 */
export class HysteresisQuantizer {
  constructor() {
    this.quantized = 0;
  }

  /** Command. One lookup. `hysteresis` is in index units. */
  process(value, numSteps, hysteresis = 0.25) {
    const scaled = value * (numSteps - 1);
    const feedback = scaled > this.quantized ? -hysteresis : hysteresis;
    let q = Math.trunc(scaled + feedback + 0.5);
    if (q < 0) q = 0;
    if (q > numSteps - 1) q = numSteps - 1;
    this.quantized = q;
    return q;
  }
}

/**
 * `RandomSequence` (random_sequence.h) — THE DEJA-VU REGISTER, which is the whole point of
 * Marbles. Command.
 *
 * ── M-DV: WHAT DEJA VU ACTUALLY IS ──────────────────────────────────────────
 * `loop_[16]` is a circular buffer with a write head. The ACTIVE WINDOW is the `length`
 * most recently written slots, ending just before the write head, and `step` indexes within
 * it. Nothing is ever rewound: the window only slides forward when a new value is written.
 * So SHORTENING the length narrows the window onto the newest values, and LENGTHENING it
 * re-exposes older ones that are still sitting in the buffer — which is why turning LENGTH
 * up after a while reveals material you have already heard rather than fresh noise.
 *
 * The knob is `p = (2·dejaVu − 1)²`, a V with its minimum at 0.5, and it is SYMMETRIC IN
 * PROBABILITY BUT ASYMMETRIC IN EFFECT:
 *   dejaVu 0    → p = 1  → every tick writes a NEW random value. Unrepeating noise.
 *   dejaVu 0.5  → p = 0  → the loop plays back verbatim, forever. THE LOCKED LOOP.
 *   dejaVu 1    → p = 1  → the loop's CONTENT is frozen and its ORDER is randomised.
 * The left half changes WHAT is in the loop; the right half changes the ORDER it is read
 * in. Both ends are maximally random, by different routes. (And per deviation M1, the
 * pinned revision draws the coin TWICE, so the left half also shuffles.)
 *
 * Values are TAGGED, not typed: a random value is stored as `u ∈ [0,1)` and a deterministic
 * one (register/ASR mode) as `1 + value`. The `>= 1` test on read recovers it and
 * simultaneously detects a type mismatch, substituting 0.5.
 *
 * `history_[16]` is what was actually RETURNED, which is how channels 2 and 3 replay
 * channel 1's stream — either hashed (decorrelated but sharing the loop's period) or
 * shifted (a literal analog shift register).
 */
export class MarblesRandomSequence {
  constructor(random) {
    this.random = random;
    this.loop = new Float64Array(MARBLES_LOOP_SIZE);
    for (let i = 0; i < MARBLES_LOOP_SIZE; i++) this.loop[i] = random.float();
    this.history = new Float64Array(MARBLES_HISTORY_SIZE);
    this.loopWriteHead = 0;
    this.length = 8;
    this.step = 0;
    this.recordHead = 0;
    this.replayHead = -1;
    this.replayStart = 0;
    this.replayHash = 0;
    this.replayShift = 0;
    this.dejaVu = 0;
    // Integer indices where the C keeps float pointers, because `Clone` rebases them by
    // pointer arithmetic and JS has no pointers. −1 is the C's NULL.
    this.redoReadIndex = 0;
    this.redoWriteIndex = -1;
    this.redoWriteHistoryIndex = -1;
  }

  /** Command. `set_length` — SILENTLY IGNORED outside 1…16, which is the source's own
   *  guard, and the step is re-wrapped so a shortened window cannot index past its end. */
  setLength(length) {
    if (length < 1 || length > MARBLES_LOOP_SIZE) return;
    this.length = length;
    this.step %= length;
  }

  /** Command. `Record` — snapshot the history head so replaying channels know where this
   *  block's values start. */
  record() {
    this.replayStart = this.recordHead;
    this.replayHead = -1;
  }

  /** Command. `ReplayPseudoRandom` — replay channel 1's stream through one LCG round on the
   *  XOR'd word, so this channel is DECORRELATED from it but repeats with the same period. */
  replayPseudoRandom(hash) {
    this.replayHead = this.replayStart;
    this.replayHash = hash >>> 0;
    this.replayShift = 0;
  }

  /** Command. `ReplayShifted` — replay channel 1's stream verbatim, `shift` steps behind.
   *  This is the ANALOG SHIFT REGISTER: X1 now, X2 one step ago, X3 two steps ago. */
  replayShifted(shift) {
    this.replayHead = this.replayStart;
    this.replayHash = 0;
    this.replayShift = shift;
  }

  /** Query. `GetReplayValue`. */
  getReplayValue() {
    const h = (this.replayHead - 1 - this.replayShift + 2 * MARBLES_HISTORY_SIZE) % MARBLES_HISTORY_SIZE;
    if (!this.replayHash) return this.history[h];
    let word = Math.trunc(this.history[h] * 4294967296) >>> 0;
    word = (Math.imul(word ^ this.replayHash, 1664525) + 1013904223) >>> 0;
    return word / 4294967296;
  }

  /**
   * Command. `NextValue` — see M-DV above, and deviation M1 for why the coin is drawn twice
   * rather than hoisted into one `mutate`.
   */
  nextValue(deterministic, value) {
    if (this.replayHead >= 0) {
      this.replayHead = (this.replayHead + 1) % MARBLES_HISTORY_SIZE;
      return this.getReplayValue();
    }
    const pSqrt = 2 * this.dejaVu - 1;
    const p = pSqrt * pSqrt;

    if (this.random.float() <= p && this.dejaVu <= 0.5) {
      this.redoWriteIndex = this.loopWriteHead;
      this.loop[this.redoWriteIndex] = deterministic ? 1 + value : this.random.float();
      this.loopWriteHead = (this.loopWriteHead + 1) % MARBLES_LOOP_SIZE;
      this.step = this.length - 1;
    } else {
      this.redoWriteIndex = -1;
      if (this.random.float() <= p) {
        this.step = Math.trunc(this.random.float() * this.length);
      } else {
        this.step += 1;
        if (this.step >= this.length) this.step = 0;
      }
    }
    const i = this.loopWriteHead + MARBLES_LOOP_SIZE - this.length + this.step;
    this.redoReadIndex = i % MARBLES_LOOP_SIZE;
    let result = this.loop[this.redoReadIndex];
    if (result >= 1) result -= 1;
    else if (deterministic) result = 0.5;
    this.redoWriteHistoryIndex = this.recordHead;
    this.history[this.redoWriteHistoryIndex] = result;
    this.recordHead = (this.recordHead + 1) % MARBLES_HISTORY_SIZE;
    return result;
  }

  /** Command. `RewriteValue` — what the last `nextValue` WOULD have returned had its second
   *  argument been `value`. Consumes no randomness and advances no head; the register mode's
   *  20-sample CV reacquisition uses it. */
  rewriteValue(value) {
    if (this.replayHead >= 0) return this.getReplayValue();
    if (this.redoWriteIndex >= 0) this.loop[this.redoWriteIndex] = 1 + value;
    let result = this.loop[this.redoReadIndex];
    if (result >= 1) result -= 1;
    else result = 0.5;
    if (this.redoWriteHistoryIndex >= 0) this.history[this.redoWriteHistoryIndex] = result;
    return result;
  }

  /** Command. `NextVector` — one deja-vu draw, then LCG derivatives of it. So `dest[0]` IS
   *  the loop value and everything else follows from it, which is exactly how deja-vu makes
   *  a whole T pattern repeat rather than only one of its parameters. */
  nextVector(destination, size) {
    const seed = this.nextValue(false, 0);
    let word = Math.trunc(seed * 4294967296) >>> 0;
    for (let i = 0; i < size; i++) {
      destination[i] = word / 4294967296;
      word = (Math.imul(word, 1664525) + 1013904223) >>> 0;
    }
  }

  /** Command. `Clone` — deep copy, with the three pointers carried as indices. */
  clone(source) {
    this.loop.set(source.loop);
    this.history.set(source.history);
    this.loopWriteHead = source.loopWriteHead;
    this.length = source.length;
    this.step = source.step;
    this.recordHead = source.recordHead;
    this.replayHead = source.replayHead;
    this.replayStart = source.replayStart;
    this.replayHash = source.replayHash;
    this.replayShift = source.replayShift;
    this.dejaVu = source.dejaVu;
    this.redoReadIndex = source.redoReadIndex;
    this.redoWriteIndex = source.redoWriteIndex;
    this.redoWriteHistoryIndex = source.redoWriteHistoryIndex;
  }
}

/**
 * `SlaveRamp` (ramp/slave_ramp.h) — one T output's ramp, either an adaptive-slope Bernoulli
 * ramp or a fixed division of the master. Command.
 *
 * THE BERNOULLI `Init` READS ITS OWN PREVIOUS `must_complete_`, which is easy to miss and
 * changes the shape: a ramp that DID have to reach 1.0 last tick restarts from zero, and one
 * that did not simply has its slope halved so it will not arrive early.
 */
export class MarblesSlaveRamp {
  constructor() {
    this.init();
  }

  /** Command. `Init()` with no arguments. */
  init() {
    this.phase = 0;
    this.maxPhase = MARBLES_MAX_RAMP_VALUE;
    this.ratio = 1;
    this.pulseWidth = 0;
    this.target = 1;
    this.pulseLength = 0;
    this.bernoulli = false;
    this.mustComplete = false;
  }

  /** Command. `Init(pattern_length, ratio, pulse_width)` — the divider/clusters form. */
  initDivided(patternLength, ratio, pulseWidth) {
    this.bernoulli = false;
    this.phase = 0;
    this.maxPhase = patternLength * MARBLES_MAX_RAMP_VALUE;
    this.ratio = ratio[0] / ratio[1];
    this.pulseWidth = pulseWidth;
    this.target = 1;
    this.pulseLength = 0;
  }

  /** Command. `Init(must_complete, pulse_width, expected_value)` — the Bernoulli form. */
  initBernoulli(mustComplete, pulseWidth, expectedValue) {
    this.bernoulli = true;
    if (this.mustComplete) {
      this.phase = 0;
      this.pulseWidth = pulseWidth;
      this.ratio = 1;
      this.pulseLength = 0;
    }
    this.ratio = mustComplete ? 1 - this.phase : (1 - this.phase) * expectedValue;
    this.mustComplete = mustComplete;
  }

  /** Command. One sample. Returns `{phase, gate}` values through `out`. */
  process(frequency, out) {
    let outputPhase;
    if (this.bernoulli) {
      this.phase += frequency * this.ratio;
      outputPhase = this.phase >= 1 ? 1 : this.phase;
    } else {
      this.phase += frequency;
      if (this.phase >= this.maxPhase) this.phase = this.maxPhase;
      outputPhase = this.phase * this.ratio;
      if (outputPhase > this.target) {
        this.pulseLength = 0;
        this.target += 1;
      }
      outputPhase -= Math.trunc(outputPhase);
    }
    out.phase = outputPhase;
    // A pulse width of exactly 0 is a TRIGGER rather than a gate: 32 samples, then low.
    out.gate = this.pulseWidth === 0
      ? this.pulseLength < 32 && outputPhase <= 0.5
      : outputPhase < this.pulseWidth;
    this.pulseLength += 1;
  }
}

/**
 * `RampDivider` (ramp/ramp_divider.h) — divides a ramp by a rational ratio, waiting for the
 * `q`-th wrap before re-locking so a polyrhythm stays coherent. Command. This is what
 * derives Y from the X2 clock.
 */
export class MarblesRampDivider {
  constructor() {
    this.phase = 0;
    this.trainPhase = 0;
    this.maxTrainPhase = 1;
    this.fRatio = 0.99999;
    this.resetCounter = 1;
  }

  /** Command. Process `count` samples from `input` into `output`. */
  process(ratio, input, output, count) {
    for (let i = 0; i < count; i++) {
      const newPhase = input[i];
      let frequency = newPhase - this.phase;
      if (frequency < 0) {
        frequency += 1;
        this.resetCounter -= 1;
        if (!this.resetCounter) {
          this.trainPhase = newPhase;
          this.resetCounter = ratio[1];
          this.fRatio = (ratio[0] / ratio[1]) * MARBLES_MAX_RAMP_VALUE;
          frequency = 0;
          this.maxTrainPhase = ratio[1];
        }
      }
      this.trainPhase += frequency;
      if (this.trainPhase >= this.maxTrainPhase) this.trainPhase = this.maxTrainPhase;
      let outputPhase = this.trainPhase * this.fRatio;
      outputPhase -= Math.trunc(outputPhase);
      output[i] = outputPhase;
      this.phase = newPhase;
    }
  }
}

/**
 * A PERIOD-MEASURING RAMP FOLLOWER — deviation M2's stand-in for `RampExtractor`. Command.
 *
 * It measures the interval between rising edges and runs a train phase at that rate, then
 * applies the ratio exactly as `RampDivider` does. What it does NOT do is Mutable's
 * thirteen-predictor bank, so it follows a tempo change one period late and does not learn
 * a rhythmic pattern at all. That is the block's largest single gap and it is stated here,
 * in the kernel's deviation list, and in the spec's `help`.
 */
export class MarblesRampFollower {
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    this.reset();
  }

  /** Command. Forget the measured period and re-lock on the next edge. */
  reset() {
    // A tenth of a hertz, which is the source's own initial guess (`ramp_extractor.cc`
    // resets `frequency_` to `0.1f / sample_rate_`).
    this.period = this.sampleRate * 10;
    this.counter = 0;
    this.trainPhase = 0;
    this.maxTrainPhase = 1;
    this.fRatio = 1;
    this.resetCounter = 1;
    this.armed = false;
  }

  /**
   * Command. Follow `count` samples of a gate into `output` as a ramp. Returns true if a
   * re-lock happened in this block, which is what the DRUMS and DIVIDER models need in
   * order to restart their patterns.
   */
  process(ratio, gate, output, count) {
    let relocked = false;
    for (let i = 0; i < count; i++) {
      const high = gate[i];
      this.counter += 1;
      if (high && !this.armed) {
        // A rising edge. Anything under two samples is contact noise, not a clock.
        if (this.counter >= 2) this.period = this.counter;
        this.counter = 0;
        this.resetCounter -= 1;
        if (this.resetCounter <= 0) {
          this.trainPhase = 0;
          this.resetCounter = ratio[1];
          this.fRatio = (ratio[0] / ratio[1]) * MARBLES_MAX_RAMP_VALUE;
          this.maxTrainPhase = ratio[1];
          relocked = true;
        }
      }
      this.armed = high;
      this.trainPhase += 1 / this.period;
      if (this.trainPhase >= this.maxTrainPhase) this.trainPhase = this.maxTrainPhase;
      let phase = this.trainPhase * this.fRatio;
      phase -= Math.trunc(phase);
      output[i] = phase;
    }
    return relocked;
  }
}

/**
 * `Quantizer` (random/quantizer.cc) — snaps a voltage to a scale degree, with SEVEN LEVELS
 * of selectivity built from the degrees' weights. Command (it keeps a hysteresis level).
 *
 * LEVEL 0 IS PASS-THROUGH: `amount = 2·steps − 1`, so STEPS at its centre does not quantise
 * at all. As the knob rises the level rises and the lightly-weighted degrees drop out, until
 * at level 6 (threshold 255) only the root survives and the output is octaves.
 */
export class MarblesQuantizer {
  constructor(scale) {
    this.baseInterval = 1;
    this.voltages = new Float64Array(16);
    this.numDegrees = scale.degrees.length;
    let secondLargest = 0;
    for (let i = 0; i < this.numDegrees; i++) {
      this.voltages[i] = scale.degrees[i][0];
      const weight = scale.degrees[i][1];
      if (weight !== 255 && weight >= secondLargest) secondLargest = weight;
    }
    const thresholds = MARBLES_THRESHOLDS.slice();
    // If the scale's heaviest non-root degree is already above 192, level 5 would be
    // indistinguishable from level 4 — so the source substitutes it (quantizer.cc).
    if (secondLargest > 192) thresholds[MARBLES_THRESHOLDS.length - 2] = secondLargest;
    this.levels = thresholds.map((threshold) => {
      let bitmask = 0;
      let first = 0xff;
      let last = 0;
      for (let i = 0; i < this.numDegrees; i++) {
        if (scale.degrees[i][1] >= threshold) {
          bitmask |= 1 << i;
          if (first === 0xff) first = i;
          last = i;
        }
      }
      return { bitmask, first, last };
    });
    this.levelQuantizer = new HysteresisQuantizer();
  }

  /** Command. Quantise `value` at selectivity `amount` (−1…1). */
  process(value, amount) {
    let level = this.levelQuantizer.process(amount, MARBLES_THRESHOLDS.length + 1);
    if (level <= 0) return value;
    level -= 1;
    const note = value / this.baseInterval;
    let integral = Math.trunc(note);
    let fractional = note - integral;
    if (value < 0) {
      integral -= 1;
      fractional += 1;
    }
    fractional *= this.baseInterval;
    const l = this.levels[level];
    let a = this.voltages[l.last] - this.baseInterval;
    let b = this.voltages[l.first] + this.baseInterval;
    let bitmask = l.bitmask;
    for (let i = 0; i < this.numDegrees; i++) {
      if (bitmask & 1) {
        const v = this.voltages[i];
        if (fractional > v) {
          a = v;
        } else {
          b = v;
          break;
        }
      }
      bitmask >>= 1;
    }
    const quantized = fractional < (a + b) * 0.5 ? a : b;
    return quantized + integral * this.baseInterval;
  }
}

/**
 * `LagProcessor` (random/lag_processor.cc) — the SLEW half of the STEPS knob. Command.
 *
 * It is not a plain one-pole: it crossfades a one-pole against a RAMP whose own shape is
 * warped through the raised-cosine table, so a long glide eases in and out while a short one
 * is nearly linear. That is why turning STEPS below centre sounds like a hand moving a knob
 * rather than like a filter.
 */
export class MarblesLagProcessor {
  constructor() {
    this.previousPhase = 0;
    this.lpState = 0;
    this.rampStart = 0;
    this.rampValue = 0;
  }

  /** Command. `ResetRamp` — called at each new value so the glide starts where it is. */
  resetRamp() {
    this.rampStart = this.rampValue;
  }

  /** Command. One sample. */
  process(value, smoothness, phase) {
    let frequency = phase - this.previousPhase;
    if (frequency < 0) frequency += 1;
    this.previousPhase = phase;
    frequency *= 0.25;
    frequency *= semitonesToRatio(84 * (1 - smoothness));
    if (frequency >= 1) frequency = 1;
    if (smoothness <= 0.05) frequency += 20 * (0.05 - smoothness) * (1 - frequency);
    this.lpState += frequency * (value - this.lpState);
    const interpAmount = Math.min(Math.max((smoothness - 0.6) * 5, 0), 1);
    const interpLinearity = Math.min(Math.max((1 - smoothness) * 5, 0), 1);
    const warpedPhase = interpolate(MARBLES_RAISED_COSINE, phase, MARBLES_TABLE_SIZE);
    const interpPhase = crossfade(warpedPhase, phase, interpLinearity);
    const interp = crossfade(this.rampStart, value, interpPhase);
    this.rampValue = interp;
    return crossfade(this.lpState, interp, interpAmount);
  }
}

/**
 * `TGenerator` (random/t_generator.cc) — the CLOCK half of Marbles: one master ramp, two
 * slave ramps, and one of seven models deciding which of T1/T3 fires at each tick. Command.
 */
export class MarblesTGenerator {
  constructor(sequence, sampleRate) {
    this.sequence = sequence;
    this.oneHertz = 1 / sampleRate;
    this.model = MARBLES_T_MODELS[0];
    this.range = MARBLES_T_RANGES[1];
    this.rate = 0;
    this.bias = 0.5;
    this.jitter = 0;
    this.slaveRamps = [new MarblesSlaveRamp(), new MarblesSlaveRamp()];
    this.follower = new MarblesRampFollower(sampleRate);
    this.biasQuantizer = new HysteresisQuantizer();
    this.rateQuantizer = new HysteresisQuantizer();
    this.useExternalClock = false;
    this.masterPhase = 0;
    this.jitterMultiplier = 1;
    this.phaseDifference = 0;
    this.previousExternalRamp = 0;
    this.dividerPatternLength = 0;
    this.drumPatternStep = MARBLES_DRUM_PATTERN_SIZE;
    this.drumPatternIndex = 0;
    this.markovHistory = new Int32Array(MARBLES_MARKOV_HISTORY);
    this.markovHistoryPointer = 0;
    this.streakCounter = [0, 0];
    // `RandomVector` is a UNION in the C: x[0..1] are the pulse widths, x[2..3] the two `u`
    // values, x[4] is `p` and x[5] is `jitter`. That aliasing is load-bearing — x[0] IS the
    // deja-vu loop value and everything else is an LCG derivative of it, which is how one
    // draw makes the ENTIRE T pattern repeat.
    this.vector = new Float64Array(6);
    this.rampOut = { phase: 0, gate: false };
  }

  /** Query. `pulse_width` — Rack forces mean and deviation to zero (`Marbles.cpp`'s own
   *  TODO), so this is ALWAYS exactly 0.05 and the `pulse_width == 0` trigger branch of
   *  `SlaveRamp::Process` is unreachable except on the first tick after a bare Init. */
  randomPulseWidth() {
    return 0.05;
  }

  /** Command. `GenerateComplementaryBernoulli` — note `u[i >> 1]`, so BOTH channels read
   *  `u[0]` and exactly one of T1/T3 fires every tick. */
  generateComplementaryBernoulli() {
    let bitmask = 0;
    for (let i = 0; i < MARBLES_T_CHANNELS; i++) {
      if ((this.vector[2 + (i >> 1)] > this.bias) !== ((i & 1) !== 0)) bitmask |= 1 << i;
    }
    return bitmask;
  }

  /** Command. `GenerateIndependentBernoulli` — a separate `u` per channel, so both may fire
   *  or neither. */
  generateIndependentBernoulli() {
    let bitmask = 0;
    for (let i = 0; i < MARBLES_T_CHANNELS; i++) {
      if ((this.vector[2 + i] > this.bias) !== ((i & 1) !== 0)) bitmask |= 1 << i;
    }
    return bitmask;
  }

  /** Command. `GenerateThreeStates` — silence, T1 or T3, with `p_none` widest at the knob's
   *  centre. */
  generateThreeStates() {
    let bitmask = 0;
    const pNone = 0.75 - Math.abs(this.bias - 0.5);
    const threshold = pNone + (1 - pNone) * (0.25 + this.bias * 0.5);
    for (let i = 0; i < MARBLES_T_CHANNELS; i++) {
      const u = this.vector[2 + (i >> 1)];
      if (u > pNone && ((u > threshold) !== ((i & 1) !== 0))) bitmask |= 1 << i;
    }
    return bitmask;
  }

  /** Command. `GenerateDrums` — the pattern index is re-picked only at a pattern WRAP, and
   *  below centre only EVEN patterns are reachable, which is what makes the low half of the
   *  knob sound sparse rather than merely different. */
  generateDrums() {
    this.drumPatternStep += 1;
    if (this.drumPatternStep >= MARBLES_DRUM_PATTERN_SIZE) {
      this.drumPatternStep = 0;
      const u = this.vector[2] * 2 * Math.abs(this.bias - 0.5);
      this.drumPatternIndex = Math.trunc(MARBLES_DRUM_PATTERNS.length * u);
      if (this.bias <= 0.5) this.drumPatternIndex -= this.drumPatternIndex % 2;
    }
    return MARBLES_DRUM_PATTERNS[this.drumPatternIndex][this.drumPatternStep];
  }

  /**
   * Command. `GenerateMarkov` — four weighted rules over a 16-tick history. THE HISTORY
   * POINTER WALKS BACKWARDS, so `(p + 8) % 16` means "eight ticks ago", not ahead.
   *
   * The four rules, from the source's own comment: favour repeating what played 8 ticks ago;
   * do NOT favour both channels firing together; favour sparse patterns; favour one channel
   * echoing what the other played 4 ticks before. The `streak_counter > 24` term is a
   * +10 logit escape hatch so a channel cannot go silent forever.
   */
  generateMarkov() {
    let bitmask = 0;
    const b = 1.5 * this.bias - 0.5;
    this.markovHistory[this.markovHistoryPointer] = 0;
    const p = this.markovHistoryPointer;
    for (let i = 0; i < MARBLES_T_CHANNELS; i++) {
      const mask = 1 << i;
      const periodic = (this.markovHistory[(p + 8) % MARBLES_MARKOV_HISTORY] & mask) !== 0;
      const simultaneous = (this.markovHistory[(p + 8) % MARBLES_MARKOV_HISTORY] & ~mask) !== 0;
      const dense = (this.markovHistory[(p + 1) % MARBLES_MARKOV_HISTORY] & mask) !== 0;
      const alternate = (this.markovHistory[(p + 4) % MARBLES_MARKOV_HISTORY] & ~mask) !== 0;

      let logit = -1.5;
      logit += this.streakCounter[i] > 24 ? 10 : 0;
      logit += 8 * Math.abs(b) * (periodic ? b : -b);
      logit -= 2 * (simultaneous ? b : -b);
      logit -= 1 * (dense ? b : 0);
      logit += 1 * (alternate ? b : 0);
      if (logit < -10) logit = -10;
      if (logit > 10) logit = 10;
      // A BARE TRUNCATED INDEX, not an interpolated read — the quantisation is the source's.
      const probability = MARBLES_LOGIT[Math.trunc(logit * 12.8 + 128)];
      let state = this.vector[2 + i] < probability;
      // Deja-vu overrides the model entirely: replay what happened one loop length ago.
      if (this.sequence.dejaVu >= this.vector[4]) {
        state = (this.markovHistory[(p + this.sequence.length) % MARBLES_MARKOV_HISTORY] & mask) !== 0;
      }
      if (state) {
        bitmask |= mask;
        this.streakCounter[i] = 0;
      } else {
        this.streakCounter[i] += 1;
      }
    }
    this.markovHistory[p] |= bitmask;
    this.markovHistoryPointer = (p + MARBLES_MARKOV_HISTORY - 1) % MARBLES_MARKOV_HISTORY;
    return bitmask;
  }

  /** Command. `ScheduleOutputPulses`. */
  scheduleOutputPulses(bitmask) {
    let bits = bitmask;
    for (let i = 0; i < MARBLES_T_CHANNELS; i++) {
      this.slaveRamps[i].initBernoulli((bits & 1) !== 0, this.randomPulseWidth(), 0.5);
      bits >>= 1;
    }
  }

  /** Command. `ConfigureSlaveRamps` — the model dispatch. */
  configureSlaveRamps() {
    switch (this.model) {
      case "complementaryBernoulli":
        this.scheduleOutputPulses(this.generateComplementaryBernoulli());
        break;
      case "independentBernoulli":
        this.scheduleOutputPulses(this.generateIndependentBernoulli());
        break;
      case "threeStates":
        this.scheduleOutputPulses(this.generateThreeStates());
        break;
      case "drums":
        this.scheduleOutputPulses(this.generateDrums());
        break;
      case "markov":
        this.scheduleOutputPulses(this.generateMarkov());
        break;
      default: {
        // clusters and divider share one case, and differ only in HOW the pattern is picked:
        // divider indexes the ordered pool straight off BIAS (so unison sits at centre and
        // the knob is a ratio control), clusters draws from the weighted pool with a
        // strength that is zero at centre (so centre is always unison).
        this.dividerPatternLength -= 1;
        if (this.dividerPatternLength <= 0) {
          let pattern;
          if (this.model === "divider") {
            pattern = MARBLES_FIXED_DIVIDER_PATTERNS[
              this.biasQuantizer.process(this.bias, MARBLES_FIXED_DIVIDER_PATTERNS.length, 0.25)];
            pattern = [pattern[0].slice(), pattern[1]];
          } else {
            const strength = Math.abs(this.bias - 0.5) * 2;
            let u = this.vector[2];
            u *= u + strength * strength * (1 - u);
            u *= strength;
            const picked = MARBLES_DIVIDER_PATTERNS[
              Math.min(Math.trunc(u * MARBLES_DIVIDER_PATTERNS.length), MARBLES_DIVIDER_PATTERNS.length - 1)];
            const ratios = picked[0].slice();
            if (this.bias < 0.5) {
              const swap = ratios[0];
              ratios[0] = ratios[1];
              ratios[1] = swap;
            }
            pattern = [ratios, picked[1]];
          }
          for (let i = 0; i < MARBLES_T_CHANNELS; i++) {
            this.slaveRamps[i].initDivided(pattern[1], pattern[0][i], this.randomPulseWidth());
          }
          this.dividerPatternLength = pattern[1];
        }
        break;
      }
    }
  }

  /**
   * Command. `TGenerator::Process` — render `count` samples of the master ramp, the two slave
   * ramps and the two gates.
   *
   * @param {boolean} useExternalClock
   * @param {Float32Array} externalClock - gate values, 0…1
   * @param {object} ramps - {master, slave0, slave1, external} Float32Arrays
   * @param {Uint8Array} gates - 2·count entries, T1 then T3 per sample
   * @param {number} count
   */
  process(useExternalClock, externalClock, ramps, gates, count) {
    let internalFrequency;
    if (useExternalClock) {
      if (!this.useExternalClock) this.follower.reset();
      const index = this.rateQuantizer.process(
        (1.05 * this.rate) / 96 + 0.5, MARBLES_INPUT_DIVIDER_RATIOS.length, 0.25);
      const base = MARBLES_INPUT_DIVIDER_RATIOS[index];
      let p = base[0];
      let q = base[1];
      if (this.range === "0.25x") q *= 4;
      else if (this.range === "4x") p *= 4;
      while (p % 2 === 0 && q % 2 === 0) {
        p /= 2;
        q /= 2;
      }
      const relocked = this.follower.process([p, q], externalClock, ramps.external, count);
      if (relocked) {
        if (this.model === "drums") {
          this.drumPatternStep = MARBLES_DRUM_PATTERN_SIZE;
          this.sequence.nextVector(this.vector, this.vector.length);
          this.configureSlaveRamps();
        } else if (this.model === "clusters" || this.model === "divider") {
          this.dividerPatternLength = 0;
        }
      }
      internalFrequency = 0;
    } else {
      const rateBase = MARBLES_T_RANGE_BASE[MARBLES_T_RANGES.indexOf(this.range)];
      internalFrequency = rateBase * this.oneHertz * semitonesToRatio(this.rate);
    }
    this.useExternalClock = useExternalClock;

    for (let n = 0; n < count; n++) {
      let frequency = useExternalClock
        ? ramps.external[n] - this.previousExternalRamp
        : internalFrequency;
      frequency += frequency < 0 ? 1 : 0;

      const jitteryFrequency = frequency * this.jitterMultiplier;
      this.masterPhase += jitteryFrequency;
      // `phase_difference_` is NEVER reset: it accumulates how far the jittered clock has
      // drifted from the straight one, and the multiplier below uses it to pull the two back
      // together. That is what stops jitter from becoming a tempo change.
      this.phaseDifference += frequency - jitteryFrequency;

      if (this.masterPhase > 1) {
        this.masterPhase -= 1;
        this.sequence.nextVector(this.vector, this.vector.length);
        const jitterAmount = this.jitter * this.jitter * this.jitter * this.jitter * 36;
        const x = fastBetaDistributionSample(this.vector[5]);
        let multiplier = semitonesToRatio((x * 2 - 1) * jitterAmount);
        multiplier *= this.phaseDifference > 0
          ? 1 + this.phaseDifference
          : 1 / (1 - this.phaseDifference);
        this.jitterMultiplier = multiplier;
        this.configureSlaveRamps();
      }

      if (internalFrequency !== 0) ramps.external[n] = this.masterPhase;
      this.previousExternalRamp = ramps.external[n];
      ramps.master[n] = this.masterPhase;
      const slaveFrequency = frequency * this.jitterMultiplier;
      for (let j = 0; j < MARBLES_T_CHANNELS; j++) {
        this.slaveRamps[j].process(slaveFrequency, this.rampOut);
        (j === 0 ? ramps.slave0 : ramps.slave1)[n] = this.rampOut.phase;
        gates[n * 2 + j] = this.rampOut.gate ? 1 : 0;
      }
    }
  }
}

/**
 * `OutputChannel` (random/output_channel.cc) — one X or Y channel: draw a value at each
 * clock tick, then either quantise it or slew to it. Command.
 *
 * WORKS IN VOLTS, not wire units — see `MARBLES_X_RANGE_SCALE_OFFSET`. The kernel divides by
 * five once, at the output.
 *
 * THE STEPS KNOB IS TWO CONTROLS ABOUT ITS CENTRE: below 0.5 it is a glide amount
 * (`smoothness = 1 − 2·steps`, fully smooth at the bottom); above 0.5 it is a quantiser
 * selectivity (`amount = 2·steps − 1`); and at exactly 0.5 it is NEITHER — level 0 is
 * pass-through, so the value is neither quantised nor slewed.
 */
export class MarblesOutputChannel {
  constructor() {
    this.quantizers = MARBLES_SCALES.map((scale) => new MarblesQuantizer(scale));
    this.lag = new MarblesLagProcessor();
    this.voltage = 0;
    this.previousVoltage = 0;
    this.quantizedVoltage = 0;
    this.previousPhase = 0;
    this.previousSteps = 0;
    this.reacquisitionCounter = 0;
    this.spread = 0.5;
    this.bias = 0.5;
    this.steps = 0.5;
    this.scaleIndex = 0;
    this.registerMode = false;
    this.registerValue = 0;
    this.registerTransposition = 0;
    this.scaleOffset = MARBLES_X_RANGE_SCALE_OFFSET[1];
    this.stepsRamp = new ParamRamp();
  }

  /** Command. `GenerateNewVoltage` — the Beta draw, in volts. */
  generateNewVoltage(sequence) {
    const u = sequence.nextValue(this.registerMode, this.registerValue);
    if (this.registerMode) {
      // Register mode BYPASSES the voltage range entirely and always spans ±5 V.
      return 10 * (u - 0.5) + this.registerTransposition;
    }
    // The two degenerate ends: below spread 0.05 the distribution collapses to a constant at
    // `bias`, above 0.95 it becomes a coin flip with P(1) = bias. Both are crossfaded in
    // rather than switched, which is why the knob's extremes are usable.
    const degenerate = Math.min(Math.max(1.25 - this.spread * 25, 0), 1);
    const bernoulliAmount = Math.min(Math.max(this.spread * 25 - 23.75, 0), 1);
    let value = betaDistributionSample(u, this.spread, this.bias);
    const bernoulliValue = u >= 1 - this.bias ? 0.999999 : 0;
    value += degenerate * (this.bias - value);
    value += bernoulliAmount * (bernoulliValue - value);
    return value * this.scaleOffset[0] + this.scaleOffset[1];
  }

  /** Command. Quantise in volts through this channel's selected scale. */
  quantize(voltage, amount) {
    return this.quantizers[this.scaleIndex].process(voltage, amount);
  }

  /**
   * Command. `OutputChannel::Process` — write `count` values into `output` at `stride`,
   * clocked by the ramp in `phase`.
   */
  process(sequence, phase, output, offset, count, stride) {
    this.stepsRamp.init(this.previousSteps, this.steps, count);

    // Register mode's CV-slew hack: for 20 samples after a new value, keep REWRITING it from
    // the current CV so a moving CV is tracked rather than sampled once.
    if (this.reacquisitionCounter !== 0) {
      this.reacquisitionCounter -= 1;
      const u = sequence.rewriteValue(this.registerValue);
      this.voltage = 10 * (u - 0.5) + this.registerTransposition;
      this.quantizedVoltage = this.quantize(this.voltage, 2 * this.steps - 1);
    }

    for (let n = 0; n < count; n++) {
      const steps = this.stepsRamp.next();
      if (phase[n] < this.previousPhase) {
        this.previousVoltage = this.voltage;
        this.voltage = this.generateNewVoltage(sequence);
        this.lag.resetRamp();
        this.quantizedVoltage = this.quantize(this.voltage, 2 * steps - 1);
        if (this.registerMode) this.reacquisitionCounter = 20;
      }
      if (steps >= 0.5) {
        output[offset + n * stride] = this.quantizedVoltage;
      } else {
        const smoothness = 1 - 2 * steps;
        output[offset + n * stride] = this.lag.process(this.voltage, smoothness, phase[n]);
      }
      this.previousPhase = phase[n];
    }
    this.previousSteps = this.stepsRamp.value;
  }
}

/** `x_y_generator.cc:57` — the two decorrelating hashes for X2 and X3. X1 runs LIVE, so its
 *  slot is never used. */
const MARBLES_HASHES = [0, 0xbeca55e5, 0xf0cacc1a];

/**
 * `XYGenerator` (random/x_y_generator.cc) — the VOLTAGE half: three X channels and Y.
 * Command.
 *
 * ── CHANNEL LOCKING, WHICH IS WHY X2 AND X3 ARE NOT INDEPENDENT ─────────────
 * When all three X channels share one clock, running three independent deja-vu registers
 * would make them repeat in lockstep AND, in register mode, shift identically. So channel 1
 * runs LIVE and channels 2 and 3 REPLAY its history — either through one LCG round on the
 * XOR'd word (decorrelated values, same loop period) or SHIFTED by one and two steps, which
 * is a literal analog shift register. When each channel has its OWN clock
 * (`t1t2t3`) this is skipped entirely and all three registers run independently. The
 * source's own comment says exactly this.
 */
export class MarblesXYGenerator {
  constructor(sequences, sampleRate) {
    this.sequences = sequences;
    this.channels = [];
    for (let i = 0; i < MARBLES_CHANNELS; i++) this.channels.push(new MarblesOutputChannel());
    this.rampDivider = new MarblesRampDivider();
    this.follower = new MarblesRampFollower(sampleRate);
    this.usedShifted = [false, false, false, false];
    this.stabilisationCounter = MARBLES_EXTERNAL_STABILISATION;
    this.clockSource = MARBLES_CLOCK_SOURCES[0];
    this.external = false;
  }

  /**
   * Command. `XYGenerator::Process` — `output` gets `count` frames of four interleaved
   * channels (X1, X2, X3, Y), in VOLTS.
   */
  process(xSettings, ySettings, externalClock, hasExternalClock, ramps, output, count) {
    const source = hasExternalClock ? "external" : this.clockSource;
    if (source !== "external") {
      this.stabilisationCounter = MARBLES_EXTERNAL_STABILISATION;
    } else if (this.stabilisationCounter !== 0) {
      this.stabilisationCounter -= 1;
      if (this.stabilisationCounter === 0) this.follower.reset();
    }

    const channelRamp = [];
    if (source === "external") {
      this.follower.process([1, 1], externalClock, ramps.slave0, count);
      // SIXTEEN BLOCKS OF MUTE after switching to the external X clock — a hardware
      // normalisation-pin artefact Rack inherits, and eighty samples of silence is easier to
      // explain than to debug.
      if (this.stabilisationCounter !== 0) ramps.slave0.fill(0, 0, count);
      channelRamp.push(ramps.slave0, ramps.slave0, ramps.slave0);
    } else if (source === "t1") {
      channelRamp.push(ramps.slave0, ramps.slave0, ramps.slave0);
    } else if (source === "t2") {
      channelRamp.push(ramps.master, ramps.master, ramps.master);
    } else if (source === "t3") {
      channelRamp.push(ramps.slave1, ramps.slave1, ramps.slave1);
    } else {
      channelRamp.push(ramps.slave0, ramps.master, ramps.slave1);
    }

    // Y is clocked by DIVIDING channel 2's ramp, and it writes into the external buffer —
    // safe because the T generator refills that at the top of the next block.
    this.rampDivider.process(ySettings.ratio, channelRamp[1], ramps.external, count);
    channelRamp.push(ramps.external);

    for (let i = 0; i < MARBLES_CHANNELS; i++) {
      const settings = i < MARBLES_X_CHANNELS ? xSettings : ySettings;
      const channel = this.channels[i];
      channel.scaleOffset = MARBLES_X_RANGE_SCALE_OFFSET[MARBLES_X_RANGES.indexOf(settings.range)];

      let amount = 1;
      if (settings.controlMode === "bump") {
        amount = i === (MARBLES_X_CHANNELS >> 1) ? 1 : -1;
      } else if (settings.controlMode === "tilt") {
        amount = (2 * i) / (MARBLES_X_CHANNELS - 1) - 1;
      }
      channel.spread = 0.5 + (settings.spread - 0.5) * amount;
      channel.bias = 0.5 + (settings.bias - 0.5) * amount;
      channel.steps = 0.5 + (settings.steps - 0.5) * (settings.registerMode ? 1 : amount);
      channel.scaleIndex = settings.scaleIndex;
      channel.registerMode = settings.registerMode;
      channel.registerValue = settings.registerValue;
      channel.registerTransposition = 4 * settings.spread * (settings.bias - 0.5) * amount;

      let sequence = this.sequences[i];
      sequence.record();
      sequence.setLength(settings.length);
      sequence.dejaVu = settings.dejaVu;

      let shifted = false;
      if (source !== "t1t2t3" && i > 0 && i < MARBLES_X_CHANNELS) {
        sequence = this.sequences[0];
        if (settings.registerMode) {
          shifted = true;
          if (settings.controlMode === "identical") sequence.replayShifted(i);
          else if (settings.controlMode === "bump") sequence.replayShifted(i === 2 ? 1 : 0);
          else sequence.replayShifted(0);
        } else {
          sequence.replayPseudoRandom(MARBLES_HASHES[i]);
        }
      }
      if (!shifted && this.usedShifted[i]) sequence.clone(this.sequences[0]);
      this.usedShifted[i] = shifted;

      channel.process(sequence, channelRamp[i], output, i, count, MARBLES_CHANNELS);
    }
  }
}

/**
 * THE MARBLES KERNEL — `Marbles.cpp`'s `stepBlock()` plus both generators. Command.
 *
 * ── THE FRAME ORDER IS 1,2,3,4,0 AND THAT IS NOT A BUG ──────────────────────
 * `Marbles.cpp` records each sample's gate flags at the CURRENT block index, then advances
 * it, then reads the OUTPUTS at the NEW index — so four of the five frames a quantum emits
 * come from the previous block and one from the block just computed. Getting it wrong shifts
 * every output by up to four samples. Reproduced by rendering into a five-frame buffer and
 * emitting from a rotating index.
 */
export class MarblesKernel {
  static internalRate = null;
  static blockSize = MARBLES_BLOCK_SIZE;
  static channels = { in: 2, out: 7 };

  constructor(sampleRate, options = {}) {
    this.random = new Lcg(options.seed === undefined ? 1 : options.seed);
    // FIVE sequences, constructed in this order because each consumes sixteen LCG words at
    // construction and the order therefore decides the whole stream: the T generator's, then
    // the four X/Y ones. Matching `Marbles.cpp`'s construction order is what makes a given
    // seed reproduce the same pattern as the reference implementation would.
    this.tSequence = new MarblesRandomSequence(this.random);
    this.xySequences = [];
    for (let i = 0; i < MARBLES_CHANNELS; i++) {
      this.xySequences.push(new MarblesRandomSequence(this.random));
    }
    this.t = new MarblesTGenerator(this.tSequence, sampleRate);
    this.xy = new MarblesXYGenerator(this.xySequences, sampleRate);
    this.noteFilter = new MarblesNoteFilter();

    const n = MARBLES_BLOCK_SIZE;
    this.ramps = {
      master: new Float32Array(n),
      slave0: new Float32Array(n),
      slave1: new Float32Array(n),
      external: new Float32Array(n),
    };
    this.gates = new Uint8Array(n * MARBLES_T_CHANNELS);
    this.voltages = new Float64Array(n * MARBLES_CHANNELS);
    this.tClockGate = new Float32Array(n);
    this.xClockGate = new Float32Array(n);
    this.tArmed = false;
    this.xArmed = false;
    this.xSettings = {
      controlMode: MARBLES_X_MODES[0], range: MARBLES_X_RANGES[1], registerMode: false,
      registerValue: 0, spread: 0.5, bias: 0.5, steps: 0.5, dejaVu: 0, length: 1,
      scaleIndex: 0, ratio: [1, 1],
    };
    this.ySettings = {
      controlMode: "identical", range: MARBLES_X_RANGES[1], registerMode: false,
      registerValue: 0, spread: 0.5, bias: 0.5, steps: 0.5, dejaVu: 0, length: 1,
      scaleIndex: 0, ratio: MARBLES_Y_DIVIDERS[8],
    };
    this.tDejaVu = false;
    this.xDejaVu = false;
    this.external = false;
    this.yDividerIndex = 8;
  }

  /** Command. The `tMode` option — all seven, not just the three the Rack BUTTON cycles. */
  setTMode(value) {
    if (!MARBLES_T_MODELS.includes(value)) {
      throw new Error(`MarblesKernel: tMode must be one of ${MARBLES_T_MODELS.join(", ")}, not ${JSON.stringify(value)}`);
    }
    this.t.model = value;
  }

  /** Command. The `tRange` option. */
  setTRange(value) {
    if (!MARBLES_T_RANGES.includes(value)) {
      throw new Error(`MarblesKernel: tRange must be one of ${MARBLES_T_RANGES.join(", ")}, not ${JSON.stringify(value)}`);
    }
    this.t.range = value;
  }

  /** Command. The `xMode` option. */
  setXMode(value) {
    if (!MARBLES_X_MODES.includes(value)) {
      throw new Error(`MarblesKernel: xMode must be one of ${MARBLES_X_MODES.join(", ")}, not ${JSON.stringify(value)}`);
    }
    this.xSettings.controlMode = value;
  }

  /** Command. The `xRange` option — shared with Y, which is the wrapper's own TODO and is
   *  reproduced rather than fixed. */
  setXRange(value) {
    if (!MARBLES_X_RANGES.includes(value)) {
      throw new Error(`MarblesKernel: xRange must be one of ${MARBLES_X_RANGES.join(", ")}, not ${JSON.stringify(value)}`);
    }
    this.xSettings.range = value;
    this.ySettings.range = value;
  }

  /** Command. The `xScale` option. */
  setXScale(value) {
    const index = MARBLES_SCALE_NAMES.indexOf(value);
    if (index < 0) {
      throw new Error(`MarblesKernel: xScale must be one of ${MARBLES_SCALE_NAMES.join(", ")}, not ${JSON.stringify(value)}`);
    }
    this.xSettings.scaleIndex = index;
    // Deviation M5: Rack never loads a scale into the Y channel, which makes its quantizer
    // read off the end of a 16-float array. Ours loads the same scale, which is the evident
    // intent and cannot fault.
    this.ySettings.scaleIndex = index;
  }

  /** Command. The `yDivider` option — one of twelve musical ratios. */
  setYDivider(value) {
    const index = MARBLES_Y_DIVIDER_LABELS.indexOf(value);
    if (index < 0) {
      throw new Error(`MarblesKernel: yDivider must be one of ${MARBLES_Y_DIVIDER_LABELS.join(", ")}, not ${JSON.stringify(value)}`);
    }
    this.yDividerIndex = index;
    this.ySettings.ratio = MARBLES_Y_DIVIDERS[index];
  }

  /** Command. The `xClockSource` option. */
  setXClockSource(value) {
    if (!MARBLES_CLOCK_SOURCES.includes(value)) {
      throw new Error(`MarblesKernel: xClockSource must be one of ${MARBLES_CLOCK_SOURCES.join(", ")}, not ${JSON.stringify(value)}`);
    }
    this.xy.clockSource = value;
  }

  /** Command. The `clockMode` option — `internal` or `external` for the T side. It stands in
   *  for cable presence exactly as Rings' three source knobs do. */
  setClockMode(value) {
    this.tExternal = vc1SourceIsInternal("clockMode", value) === false;
  }

  /** Command. The `xClockMode` option, same reasoning. */
  setXClockMode(value) {
    this.xExternal = vc1SourceIsInternal("xClockMode", value) === false;
  }

  /** Command. The `registerMode` option — Marbles' `external` JSON flag, which turns the X
   *  side into a shift register fed from a CV rather than a random source. */
  setRegisterMode(value) {
    this.xSettings.registerMode = vc1SourceIsInternal("registerMode", value) === false;
  }

  /**
   * Command. One block of `MARBLES_BLOCK_SIZE` frames. `input` is `[tClock, xClock]`
   * interleaved gates; `output` is `[t1, t2, t3, y_out, x1, x2, x3]` interleaved — the Y port
   * is spelled `y_out` because a bare `y` would shadow the item's stored POSITION.
   */
  render(controls, input, output) {
    const size = MARBLES_BLOCK_SIZE;
    for (let i = 0; i < size; i++) {
      this.tClockGate[i] = input[i * 2] >= 0.5 ? 1 : 0;
      this.xClockGate[i] = input[i * 2 + 1] >= 0.5 ? 1 : 0;
    }

    // KNOB PLUS CV, per D1 clause 2, and each CV port keeps the C++ enum's spelling. Rack
    // writes `clamp(param + volts/5, 0, 1)` and a wire unit IS five volts, so the sum is the
    // whole conversion. Only `t_rate` is scaled (by sixty semitones) and only it is clamped
    // late rather than to 0…1 — see M6.
    const clamp01 = (v) => Math.min(Math.max(v, 0), 1);
    const dejaVu = clamp01(controls.dejaVu + controls.deja_vu);
    // `t_rate` IS THE ONE UNCLAMPED SUM IN THE RACK WRAPPER, and clamping it here is
    // deviation M6 rather than an oversight corrected. The knob alone spans ±60 semitones;
    // CV adds up to ±2 wire units, i.e. ±120 more. Rack passes the sum straight to
    // `SemitonesToRatio`, whose two-table implementation is only valid on ±128 — beyond that
    // it reads out of bounds. Ours would instead compute `2^(180/12)`, and MEASURED: at 1440
    // semitones the master phase reaches 2.2e32 in five samples and every voltage output
    // becomes NaN for the rest of the session. THE HARDWARE ITSELF CLAMPS AT ±120
    // (`marbles/cv_reader.cc`'s `ADC_CHANNEL_T_RATE` hard limits), so clamping is MORE
    // faithful to the instrument than Rack's unbounded path, and an unbounded path that can
    // poison a document with NaN is not a behaviour worth reproducing.
    this.t.rate = Math.min(Math.max(60 * (controls.tRate + controls.t_rate), -MARBLES_RATE_LIMIT), MARBLES_RATE_LIMIT);
    this.t.bias = clamp01(controls.tBias + controls.t_bias);
    this.t.jitter = clamp01(controls.tJitter + controls.t_jitter);
    const xSpread = clamp01(controls.xSpread + controls.x_spread);
    this.xSettings.spread = xSpread;
    this.xSettings.bias = clamp01(controls.xBias + controls.x_bias);
    this.xSettings.steps = clamp01(controls.xSteps + controls.x_steps);
    this.ySettings.spread = this.xSettings.spread;
    this.ySettings.bias = this.xSettings.bias;
    this.ySettings.steps = this.xSettings.steps;

    const lengthIndex = Math.round(controls.dejaVuLength * (MARBLES_LOOP_LENGTHS.length - 1));
    const length = MARBLES_LOOP_LENGTHS[Math.min(Math.max(lengthIndex, 0), MARBLES_LOOP_LENGTHS.length - 1)];
    this.tSequence.dejaVu = controls.tDejaVu >= 0.5 ? dejaVu : 0;
    this.tSequence.setLength(length);
    this.xSettings.dejaVu = controls.xDejaVu >= 0.5 ? dejaVu : 0;
    this.xSettings.length = length;

    // Register mode's CV, with the wrapper's own scaling TODO reproduced (deviation M4).
    const noteCv = 0.5 * (controls.xSpread + controls.x_spread);
    this.xSettings.registerValue = this.noteFilter.process(0.5 * (noteCv + 1));

    this.t.process(this.tExternal === true, this.tClockGate, this.ramps, this.gates, size);
    this.xy.process(this.xSettings, this.ySettings, this.xClockGate,
      this.xExternal === true, this.ramps, this.voltages, size);

    const volt = 1 / RACK_NOMINAL_VOLTS;
    for (let i = 0; i < size; i++) {
      output[i * 7 + 0] = this.gates[i * 2 + 0];
      // T2 IS NOT A SLAVE RAMP: it is a 50 % square taken straight off the MASTER phase, so
      // it is the one T output that never divides and never skips (`Marbles.cpp:352`).
      output[i * 7 + 1] = this.ramps.master[i] < 0.5 ? 1 : 0;
      output[i * 7 + 2] = this.gates[i * 2 + 1];
      output[i * 7 + 3] = this.voltages[i * MARBLES_CHANNELS + 3] * volt;
      output[i * 7 + 4] = this.voltages[i * MARBLES_CHANNELS + 0] * volt;
      output[i * 7 + 5] = this.voltages[i * MARBLES_CHANNELS + 1] * volt;
      output[i * 7 + 6] = this.voltages[i * MARBLES_CHANNELS + 2] * volt;
    }
  }
}

/**
 * `NoteFilter` (marbles/note_filter.h) — a 7-tap median then two one-poles at 0.65.
 * Command. Marbles' own, and NOT Rings' (which is a 4-tap median with an adaptive lag): the
 * two modules have different filters with the same class name, and using one for the other
 * would smear a register-mode CV by ten times too much.
 */
export class MarblesNoteFilter {
  static ORDER = 7;

  constructor() {
    this.previous = new Float64Array(MarblesNoteFilter.ORDER);
    this.sorted = new Float64Array(MarblesNoteFilter.ORDER);
    this.lp1 = 0;
    this.lp2 = 0;
  }

  /** Command. One control tick. */
  process(value) {
    const n = MarblesNoteFilter.ORDER;
    for (let i = 0; i < n - 1; i++) this.previous[i] = this.previous[i + 1];
    this.previous[n - 1] = value;
    this.sorted.set(this.previous);
    this.sorted.sort();
    const median = this.sorted[(n - 1) >> 1];
    this.lp1 += 0.65 * (median - this.lp1);
    this.lp2 += 0.65 * (this.lp1 - this.lp2);
    return this.lp2;
  }
}

// ════════════════════════════════════════════════════════════════════════════
// SUPERCELL — Grayscale's "big Clouds"
// ════════════════════════════════════════════════════════════════════════════
//
// ── DERIVATION RECORD, AND ITS ONE HONEST LIMIT ─────────────────────────────
// **THE SOURCE WAS NOT READ, BECAUSE IT IS NOT PUBLIC.** The `Grayscale` VCV plugin is
// PROPRIETARY: `VCVRack/library`'s manifest for it says `"license": "proprietary"`, the
// VCV Library page renders no "Source code" link (it does for every open plugin),
// `github.com/grayscalemodular` has zero public repositories, and the binary is not
// anonymously downloadable (`403 Plugin not owned or downloadable`). Every candidate
// community Clouds fork was checked and none contains a `Supercell` model.
//
// So this node is a **documented parameter-superset of Clouds**, and that phrase is
// precise rather than a hedge:
//   ALGORITHM — identical to Clouds. Verified from Grayscale's own manual and the VCV
//     Library panel render: Supercell's grain pool and buffer lengths are Clouds' (the
//     TIME switch surfaces the same 1/2/4/8 s quality enum the Clouds context menu
//     hides), and the `data` block it stores — `playbackMode`, `quality`, `inMute`,
//     `outMute`, `randomEnabled`, `randomFreq` — is Clouds' `{playback, quality}` plus
//     the panel features below. **It is NOT a larger grain pool with per-grain reverb;
//     that is a common description and it is wrong.**
//   PANEL — https://library.vcvrack.com/Grayscale/Supercell (render) and
//     https://grayscale.info/manuals/Grayscale_Supercell_manual.pdf, read 2026-08-06.
//     What Supercell adds over Clouds: the ONE blend knob split into four dedicated ones
//     (feedback, pan, mix, space) — which THIS PORT'S CLOUDS ALREADY HAS, see deviation
//     C3 — an attenuverter on each of the nine CV inputs, input and output VCAs with
//     mutes, an internal random CV generator (1…100 Hz) feeding unpatched CV inputs, and
//     split exponential V/OCT and linear PITCH inputs.
//
// S1. THE PARAMETER INDEX MAP IS UNRESOLVED, so a stored Supercell patch's positional
//     `p0…p21` CANNOT be transcribed to these knobs. Two candidate orderings were
//     derived from the panel and each contradicts the patch's own `data` block. Resolving
//     it needs the installed plugin (hover a control for its tooltip, or map it with
//     stoermelder MIDI-CAT, which writes `paramId` in declaration order). Until then a
//     Supercell deck must be re-dialled by ear rather than transcribed. SAID OUT LOUD
//     because a guessed map would look exactly like a working one.
// S2. WHAT IS PORTED IS THE SUPERSET THAT IS DERIVABLE: Clouds' engine, the four blend
//     knobs, the nine attenuverters, the two VCAs and their mutes, and the random CV
//     generator. `randomFreq` drives a seeded sample-and-hold per D3, not a wall clock.

/** The random CV generator's documented rate span, in hertz (Grayscale manual p.3). */
export const SUPERCELL_RANDOM_HZ_MIN = 1;
export const SUPERCELL_RANDOM_HZ_MAX = 100;

/** The generator's documented output span, in our wire units — the changelog describes
 *  it as "stepped 0–5 V", and 5 V is one wire unit (D1 clause 1). */
const SUPERCELL_RANDOM_LEVEL = 1;

/**
 * THE SUPERCELL KERNEL — Clouds' engine with Supercell's control surface. Command.
 *
 * It SUBCLASSES `CloudsKernel` rather than copying it, which is the whole reason
 * deviation C3 removed Clouds' blend multiplexer: with four real knobs on the base
 * class, Supercell's panel is a strict extension and there is one grain engine in this
 * file instead of two that can drift apart.
 */
export class SupercellKernel extends CloudsKernel {
  static internalRate = CLOUDS_SAMPLE_RATE;
  static blockSize = CLOUDS_BLOCK_SIZE;
  static channels = { in: 2, out: 2 };

  constructor(sampleRate, options = {}) {
    super(sampleRate, options);
    this.randomRandom = new Lcg((options.seed === undefined ? 1 : options.seed) ^ 0x5c31);
    this.randomPhase = 0;
    this.randomValue = 0;
    // `clouds::Parameters` again, plus the attenuverted sums Supercell computes.
    this.supercellState = {
      position: 0, size: 0, pitch: 0, density: 0, texture: 0, inGain: 1,
      blend: 0, spread: 0, feedback: 0, reverb: 0,
      freeze: false, trig: false,
    };
  }

  /**
   * Command. One block. Supercell's own controls, then straight into Clouds' engine.
   *
   * Each of the nine CV inputs is `knob + trim · (wire OR the internal random CV)`. The
   * random generator substitutes for an ABSENT cable on the hardware; here it is a knob
   * (`randomEnabled`) because cable presence is not visible to a kernel — the same
   * reasoning as Rings' deviation R3.
   */
  render(controls, input, output) {
    const state = this.supercellState;

    // The random CV: one sample-and-hold per period, seeded (D3), so a document renders
    // the same wash every time. `randomFreq` is in hertz at Clouds' own rate.
    this.randomPhase += (controls.randomFreq / CLOUDS_SAMPLE_RATE) * CLOUDS_BLOCK_SIZE;
    if (this.randomPhase >= 1) {
      this.randomPhase -= Math.trunc(this.randomPhase);
      this.randomValue = this.randomRandom.float() * SUPERCELL_RANDOM_LEVEL;
    }
    const random = controls.randomEnabled >= 0.5 ? this.randomValue : 0;
    const cv = (wire, trim) => trim * (wire + random);

    state.position = controls.position + cv(controls.position_cv, controls.positionTrim);
    state.size = controls.size + cv(controls.size_cv, controls.sizeTrim);
    state.density = controls.density + cv(controls.density_cv, controls.densityTrim);
    state.texture = controls.texture + cv(controls.texture_cv, controls.textureTrim);
    state.blend = controls.mix + cv(controls.mix_cv, controls.mixTrim);
    state.spread = controls.pan + cv(controls.pan_cv, controls.panTrim);
    state.feedback = controls.feedback + cv(controls.feedback_cv, controls.feedbackTrim);
    state.reverb = controls.space + cv(controls.space_cv, controls.spaceTrim);
    for (const key of ["position", "size", "density", "texture", "blend", "spread", "feedback", "reverb"]) {
      state[key] = Math.min(Math.max(state[key], 0), 1);
    }
    // V/OCT is exponential and PITCH is linear — two separate jacks on the panel, both in
    // semitones here, summed before Clouds' own ±48 clamp.
    state.pitch = Math.min(Math.max(
      controls.pitch + controls.v_oct + cv(controls.pitch_cv, controls.pitchTrim) * SEMITONES_PER_VOLT,
      -CLOUDS_PITCH_LIMIT), CLOUDS_PITCH_LIMIT);
    state.freeze = controls.freeze;
    state.trigger = controls.trig;

    // THE INPUT VCA, then Clouds, then the OUTPUT VCA. The mutes are separate from the
    // level knobs because the manual says the output mute silences PRE-space, so a
    // reverb tail is not cut off — reproduced by muting the input to the engine instead
    // of the engine's output.
    const inGain = controls.inMute >= 0.5 ? 0 : controls.inLevel * (1 + controls.in_vca);
    const scaled = this.supercellInput || (this.supercellInput = new Float32Array(CLOUDS_BLOCK_SIZE * 2));
    for (let i = 0; i < CLOUDS_BLOCK_SIZE * 2; i++) scaled[i] = input[i] * inGain;

    super.render(state, scaled, output);

    const outGain = controls.outMute >= 0.5 ? 0 : controls.outLevel * (1 + controls.out_vca);
    for (let i = 0; i < CLOUDS_BLOCK_SIZE * 2; i++) output[i] *= outGain;
  }
}

// ════════════════════════════════════════════════════════════════════════════
// BRANCHES, BLINDS, SHADES — the three Rack-native modules
// ════════════════════════════════════════════════════════════════════════════
//
// ── DERIVATION RECORD, AND WHY IT NAMES NO MUTABLE FILE ─────────────────────
// **THESE THREE HAVE NO FIRMWARE TO PORT.** `eurorack/blinds/` and `eurorack/shades/`
// contain hardware design files only (`.ai`, `.brd`, `.sch`) — both modules are PURELY
// ANALOG, so the Rack module is an original implementation and is the only one there is.
// `eurorack/branches/branches.cc` DOES exist, and the Rack module DISAGREES WITH IT in a
// way that matters (see B1), so the Rack version is what a patch ran and the Rack version
// is what is ported.
//
// SOURCE   AudibleInstruments @ a1cd335e: src/Branches.cpp, src/Blinds.cpp, src/Shades.cpp
//          (verified byte-identical between `pichenettes/eurorack` @08460a6 and the
//          `VCVRack/pichenettes-eurorack` fork @9739c022 that AudibleInstruments actually
//          pins — these three modules import no eurorack code at all.)
// FIRMWARE eurorack @ 08460a69: branches/branches.cc, for the comparison in B1 only.
// None of the three uses a `ClockDivider`, a lookup table, or stmlib. All three run
// per-sample, which is why their kernels declare `blockSize = 1`.
//
// ── D1 CLAUSE 4, WHICH THESE THREE ARE THE REASON FOR ───────────────────────
// **A GATE OR TRIGGER PORT CARRIES 0…1, NOT VOLTS/5.** Branches emits 10 V gates, which
// clause 1 would make 2.0 — outside our audio wire's ±1 and outside every consumer's
// range (AX-2's `gate()` param descriptor is `min 0, max 1`). This project's trigger
// convention predates the port and wins: a gate is 0…1. Only GATES; audio and CV keep
// clause 1's factor.

/** `Branches.cpp:126` — the gate comparator, in volts. Ported as its wire equivalent so
 *  the threshold is stated once. */
const BRANCHES_GATE_VOLTS = 2;

/** Branches' P input is scaled by 1/10, not 1/5 (`Branches.cpp:130`), so one wire unit
 *  is a full sweep of the probability. Named because it is the one place in this block
 *  where a CV's volts-per-wire-unit is 10 rather than 5. */
export const BRANCHES_CV_VOLTS_PER_UNIT = 10;

/**
 * `Branches` (Branches.cpp:104) — a dual Bernoulli gate. Command.
 *
 * PROBABILITY ROUTES TO B: `toss = random < threshold`, and a true toss selects the B
 * output. In LATCH mode the selected output FOLLOWS THE GATE's shape; in TOGGLE mode the
 * selected output is held continuously high and a successful toss FLIPS which one — so
 * toggle mode is a flip-flop, not a gate repeater.
 *
 * B1. THE FIRMWARE'S PROBABILITY POLARITY IS INVERTED RELATIVE TO THIS, and we follow
 *     RACK. `branches.cc` computes `outcome = random >= threshold && threshold != 65535`
 *     — higher knob means LESS often, i.e. its knob is "probability of A" — while
 *     `Branches.cpp:131` computes `toss = uniform() < threshold`. Every patch in the
 *     selected twenty was made in Rack, so Rack's sense is the correct one to reproduce
 *     and the firmware's is a trap for anyone who reads it first.
 * B2. THE FIRMWARE'S FOUR MODES COLLAPSE TO TWO IN RACK, and again we follow Rack.
 *     `branches.cc` has independent `toggle_mode` and `latch_mode` flags (short press vs
 *     long press) giving four combinations; `Branches.cpp:120` has ONE boolean. Rack's
 *     `false` is the firmware's "neither" and its `true` is the firmware's "both"; the
 *     other two combinations are unreachable in Rack and are not offered here.
 * B3. THE RNG IS OUR SEEDED LCG, NOT RACK'S XOROSHIRO128+. A Bernoulli gate's audible
 *     property is its DISTRIBUTION, not its stream, and Rack's stream is not reproducible
 *     across launches anyway — so this is an improvement per D3, not a loss. Porting
 *     Xoroshiro would need 64-bit arithmetic for no audible gain.
 * B4. RACK'S `BooleanTrigger` STARTS `UNINITIALIZED`, so the very first `process(true)`
 *     after construction does NOT fire — `(s == LOW) && in` is false when `s` is neither.
 *     Reproduced with a THREE-state `armed` (null / false / true); starting it at `false`
 *     instead made every Branches fire a spurious trigger at boot, which the test caught.
 * B5. POLYPHONY IS NOT PORTED. Rack's Branches is 16-channel; our audio wire is mono.
 *     Reported to the lead rather than inventing a poly wire type.
 */
export class BranchesKernel {
  static internalRate = null;
  static blockSize = 1;
  static channels = { in: 0, out: 4 };

  constructor(sampleRate, options = {}) {
    this.random = new Lcg(options.seed === undefined ? 1 : options.seed);
    // `null` is Rack's `UNINITIALIZED`, and it is not the same as `false`:
    // `BooleanTrigger::process` fires only on `(s == LOW) && in`, so a node built with its
    // gate ALREADY HIGH does not fire until that gate falls and rises again. Reproduced
    // because otherwise every Branches fires a spurious first trigger at boot.
    this.armed = [null, null];
    this.outcomes = [false, false];
  }

  /**
   * Command. One sample. `controls` carries `p1`, `p2` (the probability knob and its
   * CV summed on one param, which is why both carry the port's name), `mode1`, `mode2` (0 latch, 1 toggle) and `in1`,
   * `in2` (gates, 0…1). `output` gets `[a1, b1, a2, b2]`.
   */
  render(controls, input, output) {
    for (let channel = 0; channel < 2; channel++) {
      const gate = controls[`in${channel + 1}`] >= BRANCHES_GATE_VOLTS / RACK_NOMINAL_VOLTS;
      const toggle = controls[`mode${channel + 1}`] >= 0.5;
      if (this.armed[channel] === false && gate) {
        // Deliberately NOT clamped, per `Branches.cpp:132`'s own comment: the comparison
        // works without it, because the generator's range is [0,1) — so a threshold at or
        // above 1 is always true and at or below 0 always false.
        const threshold = controls[`p${channel + 1}`];
        const toss = this.random.float() < threshold;
        if (!toggle) {
          this.outcomes[channel] = toss;
        } else if (toss) {
          this.outcomes[channel] = !this.outcomes[channel];
        }
      }
      this.armed[channel] = gate;
      const held = toggle ? true : gate;
      output[channel * 2] = !this.outcomes[channel] && held ? 1 : 0;
      output[channel * 2 + 1] = this.outcomes[channel] && held ? 1 : 0;
    }
  }
}

/**
 * `Blinds` (Blinds.cpp:60) — a quad four-quadrant VCA / ring modulator. Command.
 *
 * The whole DSP is `out += clamp(gain + trim·cv, −2, 2) · in`, four times. It is a REAL
 * ring modulator because the gain is bipolar and CV-controllable THROUGH ZERO: patch
 * audio into IN and audio into CV with GAIN at 0 and TRIM at 1 and you get `in·cv`.
 * There is no saturation on the product at all, and no oversampling, so ring-modulating
 * two audio-rate signals ALIASES — in Rack too. Reproduced rather than improved, because
 * that aliasing is what a patch made with it sounds like.
 *
 * BL1. THE CASCADE BECOMES FOUR PRODUCTS PLUS A MIX. Rack accumulates `out` across the
 *      four channels and resets it only when a channel's output jack IS CONNECTED, so
 *      what each jack carries depends on the patch's topology — which a kernel cannot
 *      see. Both useful endpoints are given directly: four individual products, and a
 *      `mix` output carrying all four summed. Any intermediate partial sum is one mixer
 *      away, so nothing is lost and the hidden dependence on cable presence is gone.
 * BL2. THE +5 V INPUT NORMALLING BECOMES AN `offset` KNOB. An unpatched Blinds input
 *      reads a constant +5 V (`getNormalVoltage(5.0)`), which is what makes the module a
 *      bank of DC offset generators. Here each channel has an `offset` knob ADDED to its
 *      input, defaulting to 1.0 — exactly reproducing the unpatched behaviour while
 *      letting an author zero it for a pure VCA. A strict generalisation.
 * BL3. THE ±2 CLAMP IS ON THE GAIN, NOT THE AUDIO. So a full-scale input at gain 2 leaves
 *      at 2.0 — twice our wire's nominal full scale, unclipped. That is Rack's behaviour
 *      (`clamp(g, -2, 2)` and then a bare multiply) and the real module's 6 dB of OTA
 *      overdrive is NOT modelled by either.
 */
export class BlindsKernel {
  static internalRate = null;
  static blockSize = 1;
  static channels = { in: 8, out: 5 };

  /** Command. One sample. `input` is `[in1, cv1, in2, cv2, in3, cv3, in4, cv4]`;
   *  `output` is `[out1, out2, out3, out4, mix]`. */
  render(controls, input, output) {
    let mix = 0;
    for (let channel = 0; channel < 4; channel++) {
      const gain = controls[`gain${channel + 1}`]
        + controls[`mod${channel + 1}`] * input[channel * 2 + 1];
      const clamped = Math.min(Math.max(gain, -2), 2);
      const source = input[channel * 2] + controls[`offset${channel + 1}`];
      const product = clamped * source;
      output[channel] = product;
      mix += product;
    }
    output[4] = mix;
  }
}

// ════════════════════════════════════════════════════════════════════════════
// RIPPLES — a circuit-level model of the analog filter
// ════════════════════════════════════════════════════════════════════════════
//
// ── DERIVATION RECORD ───────────────────────────────────────────────────────
// **THERE IS NO MUTABLE DSP TO PORT.** `eurorack/ripples/` is hardware design files only;
// Ripples is a purely analog 2164-based filter. The Rack module is an ORIGINAL CIRCUIT
// SIMULATION by Tyler Coy (2020, GPLv3) and is the only implementation there is.
//
// SOURCE  AudibleInstruments @ a1cd335e:
//           src/Ripples.cpp            the wrapper, params and CV routing
//           src/Ripples/ripples.hpp    every constant, VtoIConverter, OTAVCA, StepRK2,
//                                      CoreProcess, the 4-cell ladder
//           src/Ripples/aafilter.hpp   the cog/scipy-generated elliptic AA cascades
//           src/Ripples/sos.hpp        the Direct-Form-I biquad cascade
//         Verified byte-identical between `pichenettes/eurorack` @08460a6 and the
//         `VCVRack/pichenettes-eurorack` fork @9739c022 — this module imports no
//         eurorack code at all.
//
// ── WHAT MAKES IT SOUND LIKE A FILTER AND NOT LIKE A FILTER MODEL ───────────
// Four identical integrator cells, each obeying `dv/dt = −A/(RC)·(vin + vout)` — a SUM, not
// a difference, because each cell INVERTS and the four −1s make the loop positive. The
// resonance feedback taps CELL FOUR through an OTA whose transconductance is a Padé
// approximant of tanh, so resonance SELF-LIMITS and self-oscillates instead of blowing up.
// On top of that each cell's slew rate is multiplied by `1 + vsum·0.01`, a 1 %-per-volt
// distortion that generates EVEN harmonics. Solved with midpoint RK2 — two derivative
// evaluations per oversampled step — at 3× oversampling through a 12th-order elliptic
// anti-alias filter.
//
// ── DEVIATIONS THAT ARE RIPPLES' OWN ────────────────────────────────────────
// P1. THE DITHER IS KEPT AND IS SEEDED. `Ripples.cpp:104` adds ±0.5 µV of uniform noise to
//     the input before upsampling, and it is NOT cosmetic: without it a fully-resonant
//     filter will never start self-oscillating from silence, because the ladder's only
//     equilibrium is zero. Ours uses the block's seeded LCG (D3) rather than Rack's global
//     Xoroshiro, so a document renders identically twice.
// P2. THE FREQUENCY KNOB IS STORED IN log2-HERTZ, exactly as Rack stores it
//     (`configParam(FREQ_PARAM, log2(20), log2(20000), log2(20000), …, displayBase = 2)`).
//     Kept rather than converted to hertz so a harvested patch's stored value lands
//     unchanged — its min is 4.321928, its max 14.287712, and its DEFAULT is the max, i.e.
//     wide open.
// P3. POLYPHONY IS NOT PORTED. Rack runs sixteen independent engines; our audio wire is
//     mono. Reported to the lead rather than inventing a poly wire type.
// P4. THE OPAMP AND COLLECTOR CLAMPS ARE REPRODUCED, INCLUDING THEIR ASYMMETRY. The cell
//     voltages clamp at ±10.6 V (`kOpampSatV`) and the V-to-I converter's collector clips
//     at −10 V only (`kVtoICollectorVSat`), with the returned current floored at zero — so
//     a NEGATIVE resonance CV shuts resonance off rather than inverting it. Both are the
//     model's, not tidied.

/** `ripples.hpp` — the knob's span, in hertz. The PARAM is `log2` of these (P2). */
export const RIPPLES_FREQ_MIN_HZ = 20;
export const RIPPLES_FREQ_MAX_HZ = 20000;

/** Every constant of the circuit, resolved from `ripples.hpp`'s resistor and capacitor
 *  values. They are the model's component list, so they are named rather than inlined —
 *  unlike a transcribed tuning coefficient, each of these IS a nameable physical part. */
const RIPPLES_VCA_GAIN_CONSTANT = -33e-3;
const RIPPLES_PLUS_6DB = 20 * Math.log10(2);
const RIPPLES_FREQ_AMP_GAIN = RIPPLES_VCA_GAIN_CONSTANT * RIPPLES_PLUS_6DB;
const RIPPLES_FREQ_INPUT_R = 100e3;
const RIPPLES_FREQ_AMP_R = -RIPPLES_FREQ_AMP_GAIN * RIPPLES_FREQ_INPUT_R;
const RIPPLES_FREQ_AMP_C = 560e-12;
const RIPPLES_RES_INPUT_R = 22e3;
const RIPPLES_RES_KNOB_V = 12;
const RIPPLES_RES_KNOB_R = 62e3;
const RIPPLES_RES_AMP_R = 47e3;
const RIPPLES_RES_AMP_C = 560e-12;
const RIPPLES_GAIN_INPUT_R = 27e3;
const RIPPLES_GAIN_NORMAL_V = 12;
const RIPPLES_GAIN_NORMAL_R = 15e3;
const RIPPLES_GAIN_AMP_R = 47e3;
const RIPPLES_GAIN_AMP_C = 560e-12;
const RIPPLES_CELL_R = 33e3;
const RIPPLES_CELL_RC = 1 / (2 * Math.PI * RIPPLES_FREQ_MAX_HZ);
const RIPPLES_FILTER_INPUT_R = 100e3;
const RIPPLES_FILTER_INPUT_GAIN = RIPPLES_CELL_R / RIPPLES_FILTER_INPUT_R;
const RIPPLES_CELL_SELF_MODULATION = 0.01;
const RIPPLES_FEEDBACK_GAIN = 1e3 / 23e3;
const RIPPLES_FEEDFORWARD_GAIN = 1e3 / 301e3;
const RIPPLES_FEEDFORWARD_C = 220e-9;
const RIPPLES_FEEDFORWARD_R = 301e3;
const RIPPLES_LP2_GAIN = -100e3 / 39e3;
const RIPPLES_LP4_GAIN = -100e3 / 33e3;
const RIPPLES_BP2_GAIN = -100e3 / 39e3;
const RIPPLES_VCA_INPUT_C = 4.7e-6;
const RIPPLES_VCA_INPUT_R = 101e3;
const RIPPLES_VCA_INPUT_GAIN = 1e3 / RIPPLES_VCA_INPUT_R;
const RIPPLES_VCA_OUTPUT_R = 100e3;
const RIPPLES_VTOI_COLLECTOR_VSAT = -10;
const RIPPLES_OPAMP_SAT_V = 10.6;

/** The OTA's thermal voltage at the model's assumed 40 °C junction, and the argument clamp
 *  the Padé approximant needs. `2√3` is where `12z(12+z²)/(36z² + (12+z²)²)` PEAKS at
 *  exactly 1 and then turns back DOWN, so clamping there is what makes it monotone. */
const RIPPLES_VT = 8.617333262145e-5 * (40 + 273.15);
const RIPPLES_Z_LIMIT = 2 * Math.sqrt(3);

/** `Ripples.cpp:104` — the dither's amplitude, in volts. ±0.5 µV, and REQUIRED (P1). */
const RIPPLES_DITHER_VOLTS = 1e-6;

/** The elliptic anti-alias cascades `aafilter.hpp` was cog-generated with: scipy
 *  `ellipord`/`ellip`, 0.1 dB passband ripple, 100 dB stopband, a 20 kHz corner and a
 *  minimum oversampled rate of 120 kHz, converted to second-order sections. Each entry is
 *  the LOWEST host rate it covers, its oversampling factor, and `[[b0,b1,b2],[a1,a2]]` per
 *  section. NOT DERIVABLE WITHOUT SCIPY, so they are transcribed verbatim; the generator's
 *  parameters are recorded above so they could be regenerated.
 *
 *  Only the rates a browser actually runs at are carried. `kFilter12000x10` and
 *  `kFilter8000x15` are bit-identical in the source (same `wc` of 1/3), which is a useful
 *  cross-check on the transcription and is why both are here. */
const RIPPLES_AA_CASCADES = [
  { rate: 768000, factor: 1, sections: [
    [[1.83197956e-2, 3.66063440e-2, 1.83197956e-2], [-1.60702602, 6.80271956e-1]],
  ] },
  { rate: 705600, factor: 1, sections: [
    [[2.13438638e-2, 4.26550556e-2, 2.13438638e-2], [-1.57253460, 6.57877382e-1]],
  ] },
  { rate: 384000, factor: 1, sections: [
    [[6.09620331e-2, 1.21896769e-1, 6.09620331e-2], [-1.22760212, 4.71422957e-1]],
  ] },
  { rate: 352800, factor: 1, sections: [
    [[6.99874107e-2, 1.39948456e-1, 6.99874107e-2], [-1.16347041, 4.43393682e-1]],
  ] },
  { rate: 192000, factor: 1, sections: [
    [[1.74603587e-1, 3.49188678e-1, 1.74603587e-1], [-5.65216145e-1, 2.63611998e-1]],
  ] },
  { rate: 176400, factor: 1, sections: [
    [[1.95938020e-1, 3.91858763e-1, 1.95938020e-1], [-4.62313019e-1, 2.46047822e-1]],
  ] },
  { rate: 96000, factor: 2, sections: [
    [[1.61637850e-4, 2.48564833e-4, 1.61637850e-4], [-1.55379599, 6.19242969e-1]],
    [[1, -3.56106191e-3, 1], [-1.52397985, 7.01779035e-1]],
    [[1, -7.04269454e-1, 1], [-1.49925562, 8.20191196e-1]],
    [[1, -9.36222412e-1, 1], [-1.51854586, 9.39911675e-1]],
  ] },
  { rate: 88200, factor: 2, sections: [
    [[2.14361684e-4, 3.44618768e-4, 2.14361684e-4], [-1.51452462, 5.91486912e-1]],
    [[1, 1.79381294e-1, 1], [-1.47183116, 6.80568376e-1]],
    [[1, -5.38705333e-1, 1], [-1.43146550, 8.07687680e-1]],
    [[1, -7.87002288e-1, 1], [-1.44140131, 9.35689662e-1]],
  ] },
  { rate: 48000, factor: 3, sections: [
    [[1.96007199e-4, 3.15285921e-4, 1.96007199e-4], [-1.49750952, 5.79487424e-1]],
    [[1, 1.64502383e-1, 1], [-1.43900370, 6.63196513e-1]],
    [[1, -5.92180251e-1, 1], [-1.36241892, 7.75058824e-1]],
    [[1, -9.07488127e-1, 1], [-1.30223398, 8.69165582e-1]],
    [[1, -1.04177534, 1], [-1.26951947, 9.34679234e-1]],
    [[1, -1.09276235, 1], [-1.26454687, 9.80322986e-1]],
  ] },
  { rate: 44100, factor: 3, sections: [
    [[2.33467524e-4, 3.85146244e-4, 2.33467524e-4], [-1.46779940, 5.59300587e-1]],
    [[1, 2.84344987e-1, 1], [-1.39743012, 6.47280334e-1]],
    [[1, -4.81735913e-1, 1], [-1.30466696, 7.63828718e-1]],
    [[1, -8.14458422e-1, 1], [-1.22921466, 8.60153843e-1]],
    [[1, -9.63424410e-1, 1], [-1.18164620, 9.24279595e-1]],
    [[1, -1.03102512, 1], [-1.15782377, 9.63657309e-1]],
    [[1, -1.05757483, 1], [-1.15253824, 9.89272846e-1]],
  ] },
  { rate: 24000, factor: 5, sections: [
    [[9.93374792e-4, 1.81504524e-3, 9.93374792e-4], [-1.28123502, 4.43830055e-1]],
    [[1, 9.69736619e-1, 1], [-1.14056361, 5.73274737e-1]],
    [[1, 3.23593812e-1, 1], [-9.84074266e-1, 7.48267989e-1]],
    [[1, 4.69137219e-2, 1], [-9.17508757e-1, 9.16260523e-1]],
  ] },
  { rate: 22050, factor: 6, sections: [
    [[6.47358611e-4, 1.15520581e-3, 6.47358611e-4], [-1.35050917, 4.84676642e-1]],
    [[1, 7.82770646e-1, 1], [-1.24212580, 6.01760550e-1]],
    [[1, 9.46030879e-2, 1], [-1.12297856, 7.63193697e-1]],
    [[1, -1.84341946e-1, 1], [-1.08165394, 9.20980215e-1]],
  ] },
  { rate: 8000, factor: 15, sections: [
    [[3.42306291e-3, 6.53522273e-3, 3.42306291e-3], [-1.13209947, 3.65774415e-1]],
    [[1, 1.42136933, 1], [-9.55595652e-1, 5.55195466e-1]],
    [[1, 1.05842861, 1], [-8.35474882e-1, 8.34840828e-1]],
  ] },
];

/**
 * Pure function. The AA cascade for a host sample rate — `InitFilter`'s descending
 * `else if (RATE <= sample_rate)` chain, and the fallback to the 8 kHz cascade below the
 * lowest entry (which is the source's own `else { InitFilter(8000); }`).
 *
 * @param {number} sampleRate
 * @returns {{rate: number, factor: number, sections: number[][][]}}
 *
 * @example ripplesCascade(48000).factor // 3
 * @example ripplesCascade(44100).sections.length // 7
 * @example ripplesCascade(96000).factor // 2
 * @example ripplesCascade(4000).factor // 15
 */
export function ripplesCascade(sampleRate) {
  for (const cascade of RIPPLES_AA_CASCADES) {
    if (cascade.rate <= sampleRate) return cascade;
  }
  return RIPPLES_AA_CASCADES[RIPPLES_AA_CASCADES.length - 1];
}

/**
 * `SOSFilter` (sos.hpp) — a Direct-Form-I biquad cascade with `a0` implicit at 1. Command.
 *
 * THE SOURCE SHARES ONE `x_[n][3]` ARRAY BETWEEN ADJACENT SECTIONS: `x_[n]` is section n's
 * input history AND section n−1's output history, and within one `Process` call the reads
 * happen before the writes. A per-section `{x1,x2,y1,y2}` port is algebraically equivalent;
 * the shared form is transcribed here so a numeric diff against the C is possible at all.
 */
export class RipplesSos {
  constructor(sections) {
    this.sections = sections;
    this.x = [];
    for (let n = 0; n <= sections.length; n++) this.x.push([0, 0, 0]);
  }

  /** Command. Clear every section's history. */
  reset() {
    for (const row of this.x) {
      row[0] = 0;
      row[1] = 0;
      row[2] = 0;
    }
  }

  /** Command. One sample through the whole cascade. */
  process(input) {
    let value = input;
    for (let n = 0; n < this.sections.length; n++) {
      const row = this.x[n];
      row[2] = row[1];
      row[1] = row[0];
      row[0] = value;
      const [b, a] = this.sections[n];
      const next = this.x[n + 1];
      value = b[0] * row[0] + b[1] * row[1] + b[2] * row[2] - a[0] * next[0] - a[1] * next[1];
    }
    const last = this.x[this.sections.length];
    last[2] = last[1];
    last[1] = last[0];
    last[0] = value;
    return value;
  }
}

/**
 * `dsp::TRCFilter` (Rack's `dsp/filter.hpp`) — a bilinear one-pole. Command.
 *
 * NOTE THE SENSE OF `c`: `setCutoffFreq(f)` gives `c = 1/(π·f)`, so `c` is LARGE for a LOW
 * cutoff — the opposite of most one-pole formulations, and getting it inverted would put
 * every one of Ripples' five RC filters at the wrong corner.
 */
export class RipplesRc {
  constructor() {
    this.c = 0;
    this.xState = 0;
    this.yState = 0;
  }

  /** Command. `setCutoffFreq(f)` where `f` is cutoff / sample rate. */
  setCutoffFreq(f) {
    this.c = 2 / (2 * Math.PI * f);
  }

  /** Command. One sample. Read `lowpass()` and `highpass()` after. */
  process(x) {
    const y = (x + this.xState - this.yState * (1 - this.c)) / (1 + this.c);
    this.xState = x;
    this.yState = y;
  }

  /** Query. The lowpass tap. */
  lowpass() {
    return this.yState;
  }

  /** Query. The highpass tap, as `x − lowpass` off the stored input. */
  highpass() {
    return this.xState - this.yState;
  }
}

/**
 * Pure function. `OTAVCA` (ripples.hpp) — an LM13700 transconductance, as a Padé
 * approximant of `tanh` with its argument clamped at the approximant's own peak.
 *
 * **DO NOT SUBSTITUTE `Math.tanh`.** `2·Vt` is 0.054 V, so `z` reaches the clamp at about
 * 0.187 V of differential input — which means the resonance OTA is in HARD SATURATION for
 * essentially any real signal, and the shape of that saturation is the single most
 * character-defining nonlinearity in the model.
 *
 * ── ITS CEILING IS 0.989743319, NOT 1, AND THAT IS MEASURED ─────────────────
 * `12z(12+z²)/(36z² + (12+z²)²)` peaks at EXACTLY `z = 2√3` — scanned, the maximum lands
 * there to four decimals — and its value at that peak is **0.989743319**, so the OTA
 * saturates one percent BELOW its bias current and the clamp makes it monotone from there
 * on. `Math.tanh(2√3)` is 0.998042399, so substituting tanh would raise the resonance
 * path's ceiling by 0.83 %. Small, and not nothing: it is the ceiling a self-oscillating
 * filter settles against.
 *
 * @param {number} vp - the non-inverting input, volts
 * @param {number} vn - the inverting input, volts
 * @param {number} iAbc - the bias current, amps
 * @returns {number} the output current, amps
 *
 * @example ripplesOtaVca(0, 0, 1e-3) // 0
 * @example Math.abs(ripplesOtaVca(1, 0, 1e-3) - 0.989743319e-3) < 1e-9 // true
 * @example Math.abs(ripplesOtaVca(-1, 0, 1e-3) + 0.989743319e-3) < 1e-9 // true
 */
export function ripplesOtaVca(vp, vn, iAbc) {
  const vi = vp - vn;
  let z = vi / (2 * RIPPLES_VT);
  if (z < -RIPPLES_Z_LIMIT) z = -RIPPLES_Z_LIMIT;
  if (z > RIPPLES_Z_LIMIT) z = RIPPLES_Z_LIMIT;
  const z2 = z * z;
  const q = 12 + z2;
  return iAbc * ((12 * z * q) / (36 * z2 + q * q));
}

/**
 * Pure function. `VtoIConverter` (ripples.hpp) — the nonlinear CV-to-current converter, as
 * a resistor network with a clipped BJT collector.
 *
 * TWO SATURATIONS, BOTH ASYMMETRIC: the collector clips at −10 V only, and the returned
 * current is floored at ZERO. That is why a negative resonance CV shuts resonance off
 * rather than inverting it.
 *
 * @param {number} rfb - the amplifier's feedback resistor
 * @param {number} vc - the CV, volts
 * @param {number} rc - the CV's input resistor
 * @param {number} vp - the knob's voltage
 * @param {number} rp - the knob's resistor
 * @returns {number} a current in amps, at or above zero
 *
 * @example ripplesVtoI(47e3, 0, 22e3, 0, 1e12) // 0
 * @example Math.abs(ripplesVtoI(47e3, 12, 42e3, 0, 1e12) - 2.47191e-4) < 1e-8 // true
 */
export function ripplesVtoI(rfb, vc, rc, vp = 0, rp = 1e12) {
  const vnom = -((vc * rfb) / rc + (vp * rfb) / rp);
  const vout = Math.max(vnom, RIPPLES_VTOI_COLLECTOR_VSAT);
  const nrc = rp * rfb;
  const nrp = rc * rfb;
  const nrfb = rc * rp;
  const vneg = (vc * nrc + vp * nrp + vout * nrfb) / (nrc + nrp + nrfb);
  return Math.max((vneg - vout) / rfb, 0);
}

/**
 * THE RIPPLES KERNEL — `RipplesEngine` (ripples.hpp) plus `Ripples.cpp`'s CV routing.
 * Command. Per-sample, hence `blockSize = 1`.
 */
export class RipplesKernel {
  static internalRate = null;
  static blockSize = 1;
  static channels = { in: 1, out: 4 };

  constructor(sampleRate, options = {}) {
    this.random = new Lcg(options.seed === undefined ? 1 : options.seed);
    this.sampleTime = 1 / sampleRate;
    const cascade = ripplesCascade(sampleRate);
    this.factor = cascade.factor;
    // FOUR LANES through one filter, because the source upsamples the audio AND the three
    // control currents together — so the CVs get the interpolation filter's transient too,
    // which is part of the model.
    this.upFilters = [];
    this.downFilters = [];
    for (let lane = 0; lane < 4; lane++) {
      this.upFilters.push(new RipplesSos(cascade.sections));
      this.downFilters.push(new RipplesSos(cascade.sections));
    }
    const oversampleRate = sampleRate * this.factor;
    this.rcFilters = [new RipplesRc(), new RipplesRc(), new RipplesRc(), new RipplesRc()];
    const ffCut = 1 / (2 * Math.PI * RIPPLES_FEEDFORWARD_R * RIPPLES_FEEDFORWARD_C);
    const freqCut = 1 / (2 * Math.PI * RIPPLES_FREQ_AMP_R * RIPPLES_FREQ_AMP_C);
    const resCut = 1 / (2 * Math.PI * RIPPLES_RES_AMP_R * RIPPLES_RES_AMP_C);
    const gainCut = 1 / (2 * Math.PI * RIPPLES_GAIN_AMP_R * RIPPLES_GAIN_AMP_C);
    this.rcFilters[0].setCutoffFreq(ffCut / oversampleRate);
    this.rcFilters[1].setCutoffFreq(freqCut / oversampleRate);
    this.rcFilters[2].setCutoffFreq(resCut / oversampleRate);
    this.rcFilters[3].setCutoffFreq(gainCut / oversampleRate);
    this.vcaHpf = new RipplesRc();
    this.vcaHpf.setCutoffFreq(1 / (2 * Math.PI * RIPPLES_VCA_INPUT_R * RIPPLES_VCA_INPUT_C) / oversampleRate);
    // `setSampleRate` ZEROES the cell voltages, which is why a sample-rate change or a reset
    // silences the filter rather than leaving it ringing.
    this.cell = [0, 0, 0, 0];
    this.lanes = [0, 0, 0, 0];
    this.stage = [0, 0, 0, 0];
    this.k1 = [0, 0, 0, 0];
    this.derivative = [0, 0, 0, 0];
  }

  /**
   * Command. `f(vout)` — the ladder's derivative, evaluated into `out`. Called TWICE per
   * oversampled step by RK2, with `feedforward`, `iReso`, `radPerS` and `input` frozen.
   */
  ladderDerivative(vout, feedforward, iReso, radPerS, input, out) {
    // `_mm_shuffle_ps(_MM_SHUFFLE(2,1,0,3))` rotates right by one lane, then `_mm_move_ss`
    // replaces lane 0 with the cell-1 input. Written out because the intrinsic is opaque.
    const vp = feedforward * RIPPLES_FEEDFORWARD_GAIN;
    const vn = vout[3] * RIPPLES_FEEDBACK_GAIN;
    const res = RIPPLES_CELL_R * ripplesOtaVca(vp, vn, iReso);
    const cellIn = input * RIPPLES_FILTER_INPUT_GAIN + res;
    const vin = [cellIn, vout[0], vout[1], vout[2]];
    for (let lane = 0; lane < 4; lane++) {
      const vsum = vin[lane] + vout[lane];
      // The self-modulation: a 1 %-per-volt multiplicative distortion of the slew rate,
      // which is what generates the EVEN harmonics the source's comment names.
      out[lane] = radPerS * vsum * (1 + vsum * RIPPLES_CELL_SELF_MODULATION);
    }
  }

  /** Command. `CoreProcess` — one oversampled step, writing four taps into `out`. */
  coreProcess(inputs, timestep, out) {
    for (let lane = 0; lane < 4; lane++) this.rcFilters[lane].process(inputs[lane]);
    const vOct = this.rcFilters[1].lowpass();
    const iReso = this.rcFilters[2].lowpass();
    const iVca = this.rcFilters[3].lowpass();
    const feedforward = this.rcFilters[0].highpass();

    const radPerS = -Math.pow(2, vOct) / RIPPLES_CELL_RC;

    // MIDPOINT RK2, not Euler and not RK4 — `StepRK2` evaluates the derivative twice.
    this.ladderDerivative(this.cell, feedforward, iReso, radPerS, inputs[0], this.k1);
    for (let lane = 0; lane < 4; lane++) {
      this.stage[lane] = this.cell[lane] + (this.k1[lane] * timestep) / 2;
    }
    this.ladderDerivative(this.stage, feedforward, iReso, radPerS, inputs[0], this.derivative);
    for (let lane = 0; lane < 4; lane++) {
      let v = this.cell[lane] + timestep * this.derivative[lane];
      if (v < -RIPPLES_OPAMP_SAT_V) v = -RIPPLES_OPAMP_SAT_V;
      if (v > RIPPLES_OPAMP_SAT_V) v = RIPPLES_OPAMP_SAT_V;
      this.cell[lane] = v;
    }

    const lp1 = this.cell[0];
    let lp2 = this.cell[1];
    let lp4 = this.cell[3];
    // BP2 is the SUM of a 1-pole and a 2-pole lowpass, taken BEFORE lp2's own gain, and it
    // is a bandpass because the cells invert alternately. `cell[2]` is never read at all.
    const bp2 = (lp1 + lp2) * RIPPLES_BP2_GAIN;

    this.vcaHpf.process(lp4);
    let lp4vca = this.vcaHpf.highpass();
    lp4vca = -RIPPLES_VCA_OUTPUT_R * ripplesOtaVca(0, lp4vca * RIPPLES_VCA_INPUT_GAIN, iVca);

    lp2 *= RIPPLES_LP2_GAIN;
    lp4 *= RIPPLES_LP4_GAIN;

    out[0] = bp2;
    out[1] = lp2;
    out[2] = lp4;
    out[3] = lp4vca;
  }

  /**
   * Command. One sample. `controls` carries `resonance`, `frequency` (log2-Hz), `fmTrim`,
   * and the CV params `res`, `freq` (semitones), `fm` (semitones), `gain`, plus
   * `gainPatched`. `input` is one audio sample; `output` gets `[bp2, lp2, lp4, lp4vca]`.
   */
  render(controls, input, output) {
    const volts = RACK_NOMINAL_VOLTS;

    // ── The equivalent frequency CV, in volts per octave RELATIVE TO 20 kHz ──
    const knobSpan = Math.log2(RIPPLES_FREQ_MAX_HZ / RIPPLES_FREQ_MIN_HZ);
    const knobNormalised = (controls.frequency - Math.log2(RIPPLES_FREQ_MIN_HZ)) / knobSpan;
    let vOct = (knobNormalised - 1) * knobSpan;
    vOct += controls.freq / SEMITONES_PER_VOLT;
    vOct += (controls.fm / SEMITONES_PER_VOLT) * controls.fmTrim;
    // A HARD CEILING AND NO FLOOR: the cutoff can never exceed 20 kHz and can go
    // arbitrarily low. That asymmetry is the model's.
    if (vOct > 0) vOct = 0;

    const iReso = ripplesVtoI(RIPPLES_RES_AMP_R, controls.res * volts, RIPPLES_RES_INPUT_R,
      controls.resonance * RIPPLES_RES_KNOB_V, RIPPLES_RES_KNOB_R);

    // GAIN NORMALLING: with nothing patched the VCA sees a fixed 12 V through a larger
    // resistor, which is what makes the LP4VCA output usable without a cable.
    let gainCv = controls.gain * volts;
    let gainInputR = RIPPLES_GAIN_INPUT_R;
    if (controls.gainPatched < 0.5) {
      gainCv = RIPPLES_GAIN_NORMAL_V;
      gainInputR = RIPPLES_GAIN_INPUT_R + RIPPLES_GAIN_NORMAL_R;
    }
    const iVca = ripplesVtoI(RIPPLES_GAIN_AMP_R, gainCv, gainInputR);

    // Zero-stuffed upsampling: the whole quantum's worth of gain compensation goes on the
    // FIRST sub-step and the rest are literal zeros, which the interpolation filter smooths.
    const timestep = this.sampleTime / this.factor;
    const dithered = input * volts + RIPPLES_DITHER_VOLTS * (this.random.float() - 0.5);
    const seeds = [dithered * this.factor, vOct * this.factor, iReso * this.factor, iVca * this.factor];
    for (let step = 0; step < this.factor; step++) {
      for (let lane = 0; lane < 4; lane++) {
        this.lanes[lane] = this.upFilters[lane].process(step === 0 ? seeds[lane] : 0);
      }
      this.coreProcess(this.lanes, timestep, output);
      for (let lane = 0; lane < 4; lane++) {
        output[lane] = this.downFilters[lane].process(output[lane]);
      }
    }
    // Only the LAST sub-step's decimated value is emitted — a naive decimator, as written.
    for (let lane = 0; lane < 4; lane++) output[lane] /= volts;
  }
}

/**
 * `Shades` (Shades.cpp:44) — a triple attenuverter / offset. Command.
 *
 * SH1. THE RACK MODULE HAS TWO SWITCH POSITIONS, NOT THREE. `configSwitch(…, 0.0, 1.0, …,
 *      {"Attenuator", "Attenuverter"})` with a two-frame `CKSS` widget, and `process()`
 *      has exactly two branches. The hardware's third position (a gain range) is absent
 *      from this build, so a patch can only ever store 0 or 1. A third option here would
 *      be a control with nothing behind it.
 * SH2. THE OFFSET IS EMERGENT, NOT A MODE — same `+5 V` normalling as Blinds, and the
 *      same `offset` knob for the same reason (BL2). With offset 1 and no input, a
 *      channel emits `k · 1.0`, which spans ±1 in attenuverter mode and 0…1 in
 *      attenuator mode. That IS Shades' offset facility.
 * SH3. THE CASCADE BECOMES THREE OUTPUTS PLUS A MIX, exactly as BL1.
 *
 * ATTENUVERTER (mode 1, the default) is `k = 2·knob − 1`, so the DEFAULT knob of 0.5 is
 * a gain of ZERO — a fresh Shades is silent, in Rack too.
 */
export class ShadesKernel {
  static internalRate = null;
  static blockSize = 1;
  static channels = { in: 3, out: 4 };

  /** Command. One sample. `input` is `[in1, in2, in3]`; `output` is
   *  `[out1, out2, out3, mix]`. */
  render(controls, input, output) {
    let mix = 0;
    for (let channel = 0; channel < 3; channel++) {
      const knob = controls[`gain${channel + 1}`];
      const attenuverter = controls[`mode${channel + 1}`] >= 0.5;
      const k = attenuverter ? 2 * knob - 1 : knob;
      const product = k * (input[channel] + controls[`offset${channel + 1}`]);
      output[channel] = product;
      mix += product;
    }
    output[3] = mix;
  }
}
