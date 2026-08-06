/**
 * THE VC-3b KERNELS — twelve Bogaudio modules' arithmetic, and nothing else.
 *
 * No AudioNode, no AudioWorklet, no DOM: a plain ES module, so
 * `tests/port_vc3b_test.js` can run every recurrence in BARE NODE against a
 * transcription of the C++. THE ARITHMETIC IS THE DELIVERABLE, so the arithmetic
 * has to be reachable by a test that needs no browser — the reasoning that put
 * AX-2's minBLEP table and AX-3's filter coefficients in a kernels module.
 *
 * `worklets/processors_vc3b.js` imports this and wraps each kernel in an
 * AudioWorkletProcessor; `modules_vc3b.js` wires those into engine modules.
 *
 * ⚠ THE WORKLET URL IS NOT HERE AND MUST NOT BE. `synth/worklet_urls.js` holds
 * every block's `?worker&url` specifier — read its header. A Vite specifier
 * anywhere in this import graph takes the entire bare-node test lane down.
 *
 * ── THE DERIVATION RECORD ───────────────────────────────────────────────────
 * ONE source, cloned read-only and read at this commit on 2026-08-06:
 *
 *   github.com/bogaudio/BogaudioModules @ 656eaae458e045602dc974bae82e15a11e104958
 *   ("Bump version for release.", 2025-05-27)
 *
 * Bogaudio's `src/*.cpp` files are mostly parameter plumbing; the recurrences
 * live in `src/dsp/`. Every kernel below cites BOTH — the module file for the
 * parameter mapping, the `dsp/` header/impl for the recurrence — because a wrong
 * sound is almost always in the first and a wrong ALGORITHM in the second.
 *
 * ── D0. THE VOLTAGE LAW — ONE UNIT, STATED ONCE, APPLIED EVERYWHERE ─────────
 * Rack cables carry volts: ±5 V nominal, ±10 V max, and V/oct is
 * `FREQ_C4 · 2^v` with `FREQ_C4 = 261.6256 Hz`. Our `audio` wires are ±1 and our
 * `number` wires carry real units.
 *
 *   **1.0 on a PowerRP audio wire IS 5 V in Rack.** `RACK_VOLTS_PER_UNIT = 5`.
 *
 * So every kernel below computes IN VOLTS — every transcribed line is directly
 * diffable against the C++ — and the conversion happens at exactly two places,
 * both in `worklets/processors_vc3b.js`: `volts = sample · 5` on the way in,
 * `sample = volts / 5` on the way out. Consequences, stated so nobody has to
 * rediscover them:
 *   - a nominal ±5 V Rack signal is full scale (±1) here, so a ported patch is
 *     as loud as our own modules rather than 5× hotter or quieter;
 *   - Rack's ±10 V headroom is ±2 here, which Web Audio's float buses carry
 *     without clipping (only the OUTPUT module's own limiter sees it);
 *   - a V/oct wire reads 0.2 per octave on our wires. That is the price of one
 *     uniform scale, and the alternative — a second, per-port scale for pitch —
 *     is how a patch ends up 5 octaves out with nothing to say why.
 *
 * ── D1. THE MODULATE DIVIDER IS PORTED, NOT "IMPROVED" ──────────────────────
 * `src/module.cpp:22` sets `_modulationSteps = sampleRate · 2.5/1000` — every
 * Bogaudio module re-reads its knobs and recomputes its coefficients once every
 * ~2.5 ms (120 samples at 48 kHz), NOT per sample. `bogModulateSteps(fs)` is
 * that number and the processor drives the split. Running `control()` per sample
 * would make every filter sweep and every compressor attack a different sound —
 * R7-11's rule, and Bogaudio's slew limiters are TUNED against this rate.
 *
 * ── D2. NOISE IS SEEDED, AND IT IS BIT-FAITHFUL ONCE SEEDED ─────────────────
 * `dsp/noise.hpp` seeds `std::minstd_rand` from `std::random_device`, so THEIR
 * noise is not reproducible even on the same machine. Ours takes a `seed` knob
 * (the AX-2 SEED pattern, and the project's determinism law — a document that
 * renders differently every time is not a document). The GENERATOR itself is
 * ported exactly: minstd_rand is Lehmer `x ← 48271·x mod (2^31 − 1)`, and
 * `48271 · 2^31 ≈ 1.04e14 < 2^53`, so JavaScript numbers reproduce it exactly.
 * What is NOT bit-exact is `std::uniform_real_distribution<float>(-1,1)`, whose
 * mapping is implementation-defined; `bogUniform` uses the obvious affine map.
 *
 * ── D3. CV INPUTS ARE `audio` PORTS, NOT AudioParams ────────────────────────
 * Bogaudio's CV laws branch on `isConnected()`: `level *= clamp(cv/10, 0, 1)`
 * ONLY when a cable is present, and a connected cable sitting at 0 V means
 * SILENCE while no cable means unity. No AudioParam can express that — one
 * number cannot distinguish "absent" from "zero" — so every CV inlet here is an
 * `audio` input at its own worklet input index, and the processor reads
 * connectedness as `inputs[i].length > 0`. That is the only mechanism the
 * AudioWorklet API offers. **What it rests on:** a browser that handed an empty
 * channel array to a CONNECTED-but-silent input would take the unconnected
 * branch. Chrome does not; the kernels take `connected` as an explicit boolean
 * so `tests/port_vc3b_test.js` exercises both branches directly.
 *
 * ── D4. A KNOB THAT ALREADY HAS THE MODULE'S OWN CV INLET GETS NO SECOND ONE ─
 * R7-11's rule is "every param implicitly gets a same-named inlet". These
 * modules already ship that inlet — with their OWN law, which is usually a
 * MULTIPLY rather than the AudioParam sum. Declaring both would give one control
 * two inlets with two different laws, which is worse than either. So: knobs are
 * knobs, and the original's CV inputs are the ports.
 *
 * ── D5. PANEL BUTTONS ARE NOT PORTED ────────────────────────────────────────
 * `SampleHold`'s TRIGGER1/2 buttons and `Switch`'s GATE button are MOMENTARY
 * panel presses. A momentary press is not property state (it is not a function
 * of `[[slide, alpha]]`), and a latching version would be a different control.
 * The trigger INPUTS carry the same signal and are ported.
 *
 * ── D6. POLYPHONY IS NOT PORTED ─────────────────────────────────────────────
 * Rack cables carry up to 16 channels and every module here is `channels()`-aware
 * (`_engines[c]`, `getPolyVoltage(c)`). Our `audio` wire is MONO, so each kernel
 * is the c = 0 engine. Nothing about the per-channel arithmetic differs; what is
 * lost is one cable carrying a chord. Reported to the lead rather than invented
 * around: a poly wire type is a document-model decision, not a port's.
 *
 * ── DEVIATIONS SPECIFIC TO ONE MODULE ARE NAMED IN THAT KERNEL'S DOCBLOCK ───
 * D7 (PEQ's per-band frequency-CV attenuverters), D8 (PEQ's band LEDs),
 * D9 (PEQ's 3-band per-band bandwidth), D10 (the CIC decimator's arithmetic
 * form), D11 (the phase accumulator's one-LSB wrap), D12 (VCM's squared mix
 * knob — THEIR bug, reproduced), D13 (real-unit knobs).
 */

// ── THE TWO LAWS EVERY KERNEL IN THIS FILE OBEYS ────────────────────────────

/** D0: 1.0 on a PowerRP audio wire is this many Rack volts. See the header. */
export const RACK_VOLTS_PER_UNIT = 5;

/**
 * R7-UNITS CLAUSE 3: A V/OCT PITCH PORT CARRIES SEMITONES, NOT VOLTS.
 *
 * `semitones = 12 · volts`, and the ORIGIN IS C4 (a V/oct of 0), which is NOT the
 * Axoloti blocks' E4 — an AX pitch wire into one of these ports is four semitones
 * sharp and that is a real trap the manifest names. Keeping each corpus's own
 * origin is what lets a harvested patch's dial numbers transcribe UNCHANGED.
 *
 * So a pitch port is the ONE exception to D0's ×5: its wire value is already the
 * unit the arithmetic wants, and the processor passes it through unscaled. Every
 * such port is listed in its roster row's `pitchPorts`.
 */
export const BOG_SEMITONES_PER_VOLT = 12;

/** Rack's `dsp::FREQ_C4` — the frequency a V/oct of 0 names (`dsp/pitch.hpp`
 *  spells it 261.626, and that 6-digit value is what their tuning really is). */
export const BOG_REFERENCE_HZ = 261.626;

/** `dsp/pitch.hpp referenceSemitone` — C4 in their semitone domain, chosen to
 *  match MIDI note numbers when rounded. */
export const BOG_REFERENCE_SEMITONE = 60;

/** `src/module.cpp:22`: `_modulationSteps = sampleRate * (2.5f / 1000.0f)`. */
export const BOG_MODULATE_SECONDS = 2.5 / 1000;

/**
 * Pure function. How many samples one `modulate()` period is — D1.
 *
 * @param {number} sampleRate - hertz
 * @returns {number} samples between control ticks, at least 1
 *
 * @example bogModulateSteps(48000) // 120
 * @example bogModulateSteps(44100) // 110
 * @example // a pathological rate still ticks every sample rather than never
 * @example bogModulateSteps(100) // 1
 */
export function bogModulateSteps(sampleRate) {
  return Math.max(1, Math.trunc(sampleRate * BOG_MODULATE_SECONDS));
}

/**
 * Pure function. Rack's `clamp`.
 *
 * @param {number} v
 * @param {number} lo
 * @param {number} hi
 * @returns {number}
 *
 * @example bogClamp(3, 0, 1) // 1
 * @example bogClamp(-3, -1, 1) // -1
 * @example bogClamp(0.5, 0, 1) // 0.5
 */
export function bogClamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

// ── dsp/pitch.hpp — THE TUNING LAWS ─────────────────────────────────────────

/**
 * Pure function. `dsp/pitch.hpp cvToFrequency` — V/oct to hertz.
 *
 * @param {number} cv - volts per octave, 0 = C4
 * @returns {number} hertz
 *
 * @example bogCvToFrequency(0) // 261.626
 * @example bogCvToFrequency(1) // 523.252
 * @example bogCvToFrequency(-1) // 130.813
 */
export function bogCvToFrequency(cv) {
  return Math.pow(2, cv) * BOG_REFERENCE_HZ;
}

/**
 * Pure function. SEMITONES FROM C4 to hertz — the conversion a pitch knob's card
 * readout needs (R7-UNITS: "a pitch knob displays its actual frequency", so the
 * author sees 261.63 Hz rather than a bare `0 st`).
 *
 * ⚠ IT IS NOT `core/audio_nodes.semitonesToHz`, AND MUST NOT BE. That one is
 * E4-origin (Axoloti's), so a card using it here would read four semitones off.
 * The spec file restates this law because core/ may not import synth/;
 * `tests/port_vc3b_test.js` pins the two against each other.
 *
 * @param {number} semitones - semitones from C4, which is 0
 * @returns {number} hertz
 *
 * @example bogSemitonesToHz(0) // 261.626
 * @example bogSemitonesToHz(12) // 523.252
 * @example bogSemitonesToHz(-36) // 32.70325
 */
export function bogSemitonesToHz(semitones) {
  return bogCvToFrequency(semitones / BOG_SEMITONES_PER_VOLT);
}

/**
 * Pure function. `dsp/pitch.hpp frequencyToCV`.
 *
 * @param {number} frequency - hertz
 * @returns {number} volts per octave
 *
 * @example bogFrequencyToCv(261.626) // 0
 * @example bogFrequencyToCv(523.252) // 1
 */
export function bogFrequencyToCv(frequency) {
  return Math.log2(frequency / BOG_REFERENCE_HZ);
}

/**
 * Pure function. `dsp/pitch.hpp frequencyToSemitone` — hertz to their semitone
 * domain, where C4 is 60. The PEQ and VCF frequency slews run in THIS domain, so
 * a slew of "0.5 ms per semitone" is what makes a cutoff sweep sound even.
 *
 * @param {number} frequency - hertz
 * @returns {number} semitones, 60 = C4
 *
 * @example bogFrequencyToSemitone(261.626) // 60
 * @example Math.round(bogFrequencyToSemitone(440)) // 69
 */
export function bogFrequencyToSemitone(frequency) {
  return Math.log(frequency / BOG_REFERENCE_HZ) / Math.log(BOG_TWELFTH_ROOT_TWO) + BOG_REFERENCE_SEMITONE;
}

/** `dsp/pitch.hpp twelfthRootTwo`, to their own 17 digits. */
export const BOG_TWELFTH_ROOT_TWO = 1.0594630943592953;

/**
 * Pure function. `dsp/pitch.hpp semitoneToFrequency`.
 *
 * @param {number} semitone - 60 = C4
 * @returns {number} hertz
 *
 * @example bogSemitoneToFrequency(60) // 261.626
 * @example Math.round(bogSemitoneToFrequency(72)) // 523
 */
export function bogSemitoneToFrequency(semitone) {
  return Math.pow(BOG_TWELFTH_ROOT_TWO, semitone - BOG_REFERENCE_SEMITONE) * BOG_REFERENCE_HZ;
}

// ── dsp/signal.hpp — LEVELS ─────────────────────────────────────────────────

/**
 * Pure function. `dsp/signal.hpp decibelsToAmplitude` — `10^(db/20)`.
 *
 * @param {number} db
 * @returns {number} amplitude, 1 at 0 dB
 *
 * @example bogDecibelsToAmplitude(0) // 1
 * @example bogDecibelsToAmplitude(-6) // 0.5011872336272722
 * @example bogDecibelsToAmplitude(20) // 10
 */
export function bogDecibelsToAmplitude(db) {
  return Math.pow(10, db * 0.05);
}

/**
 * Pure function. `dsp/signal.hpp amplitudeToDecibels`, INCLUDING its floor: an
 * amplitude below 1e-6 reads −120 dB rather than −∞, which is what keeps the
 * compressor's detector arithmetic finite on silence.
 *
 * @param {number} amplitude
 * @returns {number} decibels
 *
 * @example bogAmplitudeToDecibels(1) // 0
 * @example bogAmplitudeToDecibels(0) // -120
 * @example bogAmplitudeToDecibels(0.5) // -6.020599913279624
 */
export function bogAmplitudeToDecibels(amplitude) {
  if (amplitude < 0.000001) return -120;
  return 20 * Math.log10(amplitude);
}

/** `Amplifier::minDecibels` / `maxDecibels` (`dsp/signal.cpp:10-12`). Every level
 *  knob in this block runs on this 80 dB span, and `minDecibels` doubles as
 *  "silence" in the VCA/VCM taper and as the noise gate's floor. */
export const BOG_AMP_MIN_DB = -60;
export const BOG_AMP_MAX_DB = 20;
export const BOG_AMP_DB_RANGE = BOG_AMP_MAX_DB - BOG_AMP_MIN_DB;

/** `Amplifier::LevelTable` is 2^13 entries over that span, looked up with a
 *  TRUNCATED index and no interpolation — so their gain is quantised to
 *  80/8192 dB steps. Reproduced rather than smoothed: it is 0.0098 dB, but it is
 *  also why two Bogaudio level knobs one step apart are bit-identical. */
const BOG_LEVEL_TABLE_LENGTH = 1 << 13;

/** The table's own knee: below `minDecibels + 6` it is a LINEAR ramp to zero
 *  instead of the exponential curve, which is what makes a level knob reach
 *  actual silence instead of asymptotically approaching it. */
const BOG_LEVEL_RAMP_DB = 6;

/**
 * Pure function. `Amplifier::setLevel` + `LevelTable::_generate`
 * (`dsp/signal.cpp:22-50`) — a decibel level as a linear gain, with their table
 * quantisation and their bottom-end linear ramp both reproduced.
 *
 * @param {number} db - level in decibels
 * @returns {number} linear gain
 *
 * @example bogAmplifierLevel(-100) // 0
 * @example bogAmplifierLevel(-60) // 0
 * @example bogAmplifierLevel(30) // 31.622776601683793
 * @example // 0 dB lands exactly on a table entry, so unity is exact
 * @example bogAmplifierLevel(0) // 1
 * @example // the bottom 6 dB is a straight line to zero, not a curve
 * @example bogAmplifierLevel(-57) < bogAmplifierLevel(-54) * 0.51 // true
 */
export function bogAmplifierLevel(db) {
  if (db <= BOG_AMP_MIN_DB) return 0;
  if (db >= BOG_AMP_MAX_DB) return bogDecibelsToAmplitude(db);
  const index = Math.trunc(((db - BOG_AMP_MIN_DB) / BOG_AMP_DB_RANGE) * BOG_LEVEL_TABLE_LENGTH);
  if (index === 0) return 0;
  const quantised = BOG_AMP_MIN_DB + (index / BOG_LEVEL_TABLE_LENGTH) * BOG_AMP_DB_RANGE;
  const kneeDb = BOG_AMP_MIN_DB + BOG_LEVEL_RAMP_DB;
  if (quantised <= kneeDb) {
    return ((quantised - BOG_AMP_MIN_DB) / BOG_LEVEL_RAMP_DB) * bogDecibelsToAmplitude(kneeDb);
  }
  return bogDecibelsToAmplitude(quantised);
}

/**
 * `dsp/signal.hpp SlewLimiter` — a per-sample maximum step, in the units of the
 * signal it limits. `_delta = range/((ms/1000)·fs)`, so "5 ms over a range of 1"
 * means the value can traverse its whole range in 5 ms and no faster.
 *
 * THIS IS THE SINGLE MOST LOAD-BEARING SMALL CLASS IN THE BLOCK. Bogaudio slews
 * nearly every modulated coefficient — a VCA's level, a filter's cutoff IN THE
 * SEMITONE DOMAIN, a compressor's envelope (attack and release ARE two of
 * these), a crossfader's mix. Omit it and every one of those becomes a zipper.
 *
 * Command (mutates `last`). Untested as a class; `bogSlewNext` below carries the
 * arithmetic and the doctests.
 */
export class BogSlewLimiter {
  constructor(sampleRate, milliseconds, range) {
    this.setParams(sampleRate, milliseconds, range);
    this.last = 0;
  }

  /** Command. `SlewLimiter::setParams` (`dsp/signal.cpp:170`). */
  setParams(sampleRate, milliseconds, range) {
    this.delta = range / ((milliseconds / 1000) * sampleRate);
  }

  /** Command. `SlewLimiter::next(sample)` — steps and stores. */
  next(sample) {
    this.last = bogSlewNext(sample, this.last, this.delta);
    return this.last;
  }

  /** Query. `SlewLimiter::next(sample, last)` — the two-argument overload the
   *  compressor uses, which does NOT store (it keeps its own `lastEnv`). */
  nextFrom(sample, last) {
    return bogSlewNext(sample, last, this.delta);
  }
}

/**
 * Pure function. One slew step — `SlewLimiter::next(sample, last)`
 * (`dsp/signal.cpp:177`).
 *
 * @param {number} sample - the target
 * @param {number} last - where the limiter is now
 * @param {number} delta - the per-sample step ceiling
 * @returns {number}
 *
 * @example bogSlewNext(1, 0, 0.25) // 0.25
 * @example bogSlewNext(0.1, 0, 0.25) // 0.1
 * @example bogSlewNext(-1, 0, 0.25) // -0.25
 * @example // a zero-millisecond slew is an infinite delta, i.e. a pass-through
 * @example bogSlewNext(1, 0, Infinity) // 1
 */
export function bogSlewNext(sample, last, delta) {
  if (sample > last) return Math.min(last + delta, sample);
  return Math.max(last - delta, sample);
}

// ── dsp/signal.hpp — THE CROSSFADER ─────────────────────────────────────────

/**
 * Pure function. `CrossFader::setParams` (`dsp/signal.cpp:236`) — the two mix
 * coefficients a mix position and a curve produce.
 *
 * THE CURVE IS THE WHOLE MODULE. At curve −1, A cuts fully by the time the mix
 * reaches centre (so there is a silent middle); at 0 it cuts across the whole
 * sweep (an equal-power-ish blend); at +1 it does not start cutting until the
 * mix is already past centre (so both are at full level in the middle). The
 * breakpoints below are theirs, and they are asymmetric on purpose.
 *
 * @param {number} mix - −1 (all A) … +1 (all B)
 * @param {number} curve - −1 … +1
 * @returns {{a: number, b: number}} the two linear mix coefficients
 *
 * @example bogCrossFaderMix(0, 0) // {a: 0.5, b: 0.5}
 * @example bogCrossFaderMix(-1, 0) // {a: 1, b: 0}
 * @example bogCrossFaderMix(1, 0) // {a: 0, b: 1}
 * @example // at curve +1 both inputs are at FULL level in the middle
 * @example bogCrossFaderMix(0, 1) // {a: 1, b: 1}
 * @example // and at curve −1 the middle is SILENT
 * @example bogCrossFaderMix(0, -1) // {a: 0, b: 0}
 */
export function bogCrossFaderMix(mix, curve) {
  let aMax;
  let aMin;
  let bMax;
  let bMin;
  if (curve < 0) {
    aMax = 0;
    aMin = curve + 2;
    bMax = 2;
    bMin = 0 - curve;
  } else {
    aMax = curve;
    aMin = 2;
    bMax = 2 - curve;
    bMin = 0;
  }
  const m = mix + 1;
  const a = m < aMax ? 1 : m > aMin ? 0 : 1 - (m - aMax) / (aMin - aMax);
  const b = m > bMax ? 1 : m < bMin ? 0 : (m - bMin) / (bMax - bMin);
  return { a, b };
}

/**
 * `CrossFader` — the mix coefficients plus the DECIBEL option, in which each
 * side's coefficient drives an Amplifier at `(1 − mix)·minDecibels` instead of
 * scaling amplitude directly. That is a different fade SHAPE, not a different
 * level: in decibel mode a mix of 0.5 is −30 dB, not −6 dB.
 *
 * Command (holds the two amplifier levels). Untested as a class; the coefficients
 * are `bogCrossFaderMix`'s doctests and the dB mapping is `bogAmplifierLevel`'s.
 */
export class BogCrossFader {
  constructor() {
    this.aMix = 0;
    this.bMix = 0;
    this.linear = true;
    this.aLevel = 0;
    this.bLevel = 0;
  }

  /** Command. Recompute both coefficients. */
  setParams(mix, curve, linear) {
    const { a, b } = bogCrossFaderMix(mix, curve);
    this.aMix = a;
    this.bMix = b;
    this.linear = linear;
    if (!linear) {
      this.aLevel = bogAmplifierLevel((1 - a) * BOG_AMP_MIN_DB);
      this.bLevel = bogAmplifierLevel((1 - b) * BOG_AMP_MIN_DB);
    }
  }

  /** Query. `CrossFader::next(a, b)`. */
  next(a, b) {
    if (this.linear) return this.aMix * a + this.bMix * b;
    return this.aLevel * a + this.bLevel * b;
  }
}

// ── dsp/signal.hpp — THE SATURATOR ──────────────────────────────────────────

/** `Saturator::limit` (`dsp/signal.cpp:325`) — the soft ceiling, in VOLTS. */
export const BOG_SATURATOR_LIMIT = 12;

/** Zavalishin 2018's constants, verbatim from `dsp/signal.cpp:328-329`:
 *  `y1 = (2x − 1)/x²` at x = 0.9, and an offset their comment calls "magic". */
const BOG_SATURATION_Y1 = 0.98765;
const BOG_SATURATION_OFFSET = 0.075 / BOG_SATURATOR_LIMIT;

/**
 * Pure function. `Saturator::next` (`dsp/signal.cpp:334`) — the soft clipper
 * every Bogaudio output stage ends in, from Zavalishin's "The Art of VA Filter
 * Design". Odd-symmetric, so it adds no even harmonics and no DC.
 *
 * ⚠ IT IS NOT A LIMITER AT ±12 V: the curve keeps rising past its own limit, so
 * a 40 V input still comes out above 12. It is a soft KNEE, and the thing that
 * makes a PEQ with fourteen bands summed sound thick instead of clipped.
 *
 * @param {number} volts
 * @returns {number} volts
 *
 * @example // NOT zero at zero: their `offset` term leaves −26.6 µV of DC,
 * @example // which is −5.3 ppm of full scale and is theirs, not ours
 * @example bogSaturate(0) // -0.000026578241279828774
 * @example // small signals pass through essentially untouched
 * @example bogSaturate(1) // 0.9926011074130752
 * @example // and it is odd-symmetric, exactly
 * @example bogSaturate(-7) === -bogSaturate(7) // true
 * @example // 12 V in comes out well under 12 V — the knee starts long before
 * @example bogSaturate(12) // 10.724757863358914
 */
export function bogSaturate(volts) {
  const x = Math.abs(volts) * (1 / BOG_SATURATOR_LIMIT);
  const x1 = (x + 1) * 0.5;
  const out = BOG_SATURATOR_LIMIT
    * (BOG_SATURATION_OFFSET + x1 - Math.sqrt(x1 * x1 - BOG_SATURATION_Y1 * x) * (1 / BOG_SATURATION_Y1));
  return volts < 0 ? -out : out;
}

// ── dsp/signal.hpp — THE DYNAMICS CURVES ────────────────────────────────────

/** `Compressor::maxEffectiveRatio` (`dsp/signal.cpp:353`). */
export const BOG_MAX_EFFECTIVE_RATIO = 1000;

/** `Compressor::compressionDb`'s soft knee width (`dsp/signal.cpp:356`). */
const BOG_COMPRESSOR_KNEE_DB = 3;

/**
 * Pure function. `Compressor::compressionDb` (`dsp/signal.cpp:355`) — how many
 * decibels of gain reduction a detector level calls for.
 *
 * THE SOFT KNEE IS NOT A SMOOTHSTEP. Their construction runs a chord from the
 * knee's start `(threshold − 3 dB)` to the point the hard-knee line would reach
 * 3 dB above threshold, and takes the slope of THAT chord — so the knee is
 * piecewise-linear in the ratio, and its width in the OUTPUT domain grows with
 * the ratio. A textbook quadratic knee here would compress differently at every
 * ratio setting.
 *
 * @param {number} detectorDb - the detector's level in dB
 * @param {number} thresholdDb - the threshold in dB
 * @param {number} ratio - N:1, as a number
 * @param {boolean} softKnee
 * @returns {number} decibels of reduction, never negative
 *
 * @example bogCompressionDb(-20, 0, 4, false) // 0
 * @example // 12 dB over a 4:1 threshold keeps 3 dB: 9 dB of reduction
 * @example bogCompressionDb(12, 0, 4, false) // 9
 * @example // the soft knee has already started 2 dB BELOW the threshold
 * @example bogCompressionDb(-2, 0, 4, true) > 0 // true
 * @example bogCompressionDb(-2, 0, 4, false) // 0
 */
export function bogCompressionDb(detectorDb, thresholdDb, ratio, softKnee) {
  if (softKnee) {
    const sDb = thresholdDb - BOG_COMPRESSOR_KNEE_DB;
    if (detectorDb <= sDb) return 0;
    const ix = BOG_COMPRESSOR_KNEE_DB * Math.min(ratio, BOG_MAX_EFFECTIVE_RATIO) + thresholdDb;
    const iy = BOG_COMPRESSOR_KNEE_DB + thresholdDb;
    const t = (detectorDb - sDb) / (ix - thresholdDb);
    const px = t * (ix - thresholdDb) + thresholdDb;
    const py = t * (iy - thresholdDb) + thresholdDb;
    const s = (py - sDb) / (px - sDb);
    return (detectorDb - sDb) - s * (detectorDb - sDb);
  }
  if (detectorDb <= thresholdDb) return 0;
  const over = detectorDb - thresholdDb;
  return over - over / ratio;
}

/** `NoiseGate::compressionDb`'s knee width (`dsp/signal.cpp:383`). */
const BOG_GATE_KNEE_DB = 6;

/**
 * Pure function. `NoiseGate::compressionDb` (`dsp/signal.cpp:382`) — the same
 * control path run the other way up, so `Pressor`'s Mode switch is one branch
 * rather than two modules.
 *
 * ⚠ THEIR OWN COMMENT ON THE SOFT-KNEE BRANCH IS `// FIXME: this achieves
 * nothing.` It is reproduced anyway, because "the gate's knee switch does
 * nothing audible" IS the module's behaviour and a fixed version would be a
 * different module (R7-11's rule: port the sound, make the label honest — the
 * spec's `help` says so).
 *
 * @param {number} detectorDb
 * @param {number} thresholdDb
 * @param {number} ratio
 * @param {boolean} softKnee
 * @returns {number} decibels of reduction, capped at 60
 *
 * @example bogNoiseGateDb(0, -20, 4, false) // 0
 * @example // 5 dB below a 4:1 threshold costs 15 dB
 * @example bogNoiseGateDb(-25, -20, 4, false) // 15
 * @example // and the reduction never exceeds the amplifier's own floor
 * @example bogNoiseGateDb(-120, -20, 4, false) // 60
 */
export function bogNoiseGateDb(detectorDb, thresholdDb, ratio, softKnee) {
  if (softKnee) {
    const range = thresholdDb - BOG_AMP_MIN_DB;
    const ix = thresholdDb + BOG_GATE_KNEE_DB;
    const iy = 0;
    if (detectorDb >= ix) return 0;
    const ox = thresholdDb - range / ratio;
    if (detectorDb <= ox) return -BOG_AMP_MIN_DB;
    const oy = BOG_AMP_MIN_DB;
    const t = (detectorDb - ox) / (ix - ox);
    const px = t * (ix - thresholdDb) + thresholdDb;
    const py = t * (iy - thresholdDb) + thresholdDb;
    const s = (py - oy) / (px - ox);
    return -(oy + s * (detectorDb - ox));
  }
  if (detectorDb >= thresholdDb) return 0;
  const difference = thresholdDb - detectorDb;
  return Math.min(difference * ratio - difference, -BOG_AMP_MIN_DB);
}

// ── dsp/filters/utility.hpp — THE DETECTORS ─────────────────────────────────

/** `DCBlocker`'s pole (`dsp/filters/utility.cpp:8`). */
const BOG_DC_BLOCKER_R = 0.999;

/**
 * `DCBlocker` — `y = x − x[n−1] + 0.999·y[n−1]` (`dsp/filters/utility.cpp:7`).
 * In front of every RMS detector, because a compressor that reacted to DC would
 * duck a bass note's asymmetry rather than its loudness.
 *
 * Command (mutates two state variables).
 */
export class BogDcBlocker {
  constructor() {
    this.lastIn = 0;
    this.lastOut = 0;
  }

  /** Command. One sample. */
  next(sample) {
    this.lastOut = sample - this.lastIn + BOG_DC_BLOCKER_R * this.lastOut;
    this.lastIn = sample;
    return this.lastOut;
  }
}

/**
 * `RunningAverage` (`dsp/signal.cpp:56`) — a circular-buffer boxcar average, and
 * the thing that makes `Pressor`'s detector an RMS-over-a-WINDOW rather than a
 * one-pole follower. The window is `sensitivity · maxDelayMS` long; Pressor uses
 * the whole 50 ms.
 *
 * ⚠ IT IS A TRUE BOXCAR, not a leaky integrator: the sum has a hard 50 ms
 * memory, so a transient leaves the detector abruptly 50 ms later. That edge is
 * audible on percussive material and is why this is a buffer and not an alpha.
 *
 * Command (mutates the ring buffer and the running sum).
 */
export class BogRunningAverage {
  constructor(sampleRate, sensitivity, maxDelayMilliseconds) {
    this.bufferN = Math.max(1, Math.trunc((maxDelayMilliseconds / 1000) * sampleRate));
    this.buffer = new Float64Array(this.bufferN);
    this.sumN = Math.max(1, Math.trunc(sensitivity * this.bufferN));
    this.invSumN = 1 / this.sumN;
    this.leadI = 0;
    this.trailI = this.bufferN - this.sumN;
    this.sum = 0;
  }

  /** Command. `RunningAverage::next` — one sample in, the window mean out. */
  next(sample) {
    this.sum -= this.buffer[this.trailI];
    this.trailI = (this.trailI + 1) % this.bufferN;
    this.buffer[this.leadI] = sample;
    this.sum += sample;
    this.leadI = (this.leadI + 1) % this.bufferN;
    return this.sum * this.invSumN;
  }
}

/**
 * `FastRootMeanSquare` (`dsp/filters/utility.cpp:16`, typedef'd `RootMeanSquare`)
 * — DC-block, rectify, average. NOT a true RMS and their name says "fast": the
 * mean of |x| is 0.9 dB below the RMS of a sine, which shifts every threshold on
 * `Pressor`'s panel by that much relative to a true-RMS compressor.
 *
 * Command (mutates the blocker and the window).
 */
export class BogRootMeanSquare {
  constructor(sampleRate, sensitivity, maxDelayMilliseconds) {
    this.blocker = new BogDcBlocker();
    this.average = new BogRunningAverage(sampleRate, sensitivity, maxDelayMilliseconds);
  }

  /** Command. One sample. */
  next(sample) {
    return this.average.next(Math.abs(this.blocker.next(sample)));
  }
}

// ── dsp/filters/filter.hpp — THE BIQUAD ─────────────────────────────────────

/**
 * `BiquadFilter` (`dsp/filters/filter.hpp:20`) — a direct-form-I biquad whose
 * `setParams` takes the SIX unnormalised coefficients and divides by b0 itself.
 * Every filter in this block is a bank of these; the interesting part is always
 * WHICH six numbers, not this recurrence.
 *
 *   y = a0·x + a1·x[n−1] + a2·x[n−2] − b1·y[n−1] − b2·y[n−2]
 *
 * Command (mutates the two delay lines).
 */
export class BogBiquad {
  constructor() {
    this.a0 = 0;
    this.a1 = 0;
    this.a2 = 0;
    this.b1 = 0;
    this.b2 = 0;
    this.x1 = 0;
    this.x2 = 0;
    this.y1 = 0;
    this.y2 = 0;
  }

  /** Command. `BiquadFilter::setParams` — normalises by b0. */
  setParams(a0, a1, a2, b0, b1, b2) {
    const ib0 = 1 / b0;
    this.a0 = a0 * ib0;
    this.a1 = a1 * ib0;
    this.a2 = a2 * ib0;
    this.b1 = b1 * ib0;
    this.b2 = b2 * ib0;
  }

  /** Command. Zero the delay lines. */
  reset() {
    this.x1 = 0;
    this.x2 = 0;
    this.y1 = 0;
    this.y2 = 0;
  }

  /** Command. One sample. */
  next(sample) {
    const y = this.a0 * sample + this.a1 * this.x1 + this.a2 * this.x2 - this.b1 * this.y1 - this.b2 * this.y2;
    this.x2 = this.x1;
    this.x1 = sample;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }
}

/**
 * `LowPassFilter` (`dsp/filters/filter.cpp:7`) — the RBJ cookbook lowpass, with
 * their DEFAULT Q OF 0.001, which is not a typo and not resonant: alpha is
 * `sin(w0)/0.002`, so the biquad is enormously damped and behaves as a gentle
 * one-pole-ish smoother. `RandomWalk` is its only user in this block, and that
 * damping is exactly what makes a walk smooth instead of noisy.
 *
 * Command (holds a biquad).
 */
export class BogLowPassFilter {
  constructor(sampleRate, cutoff, q = 0.001) {
    this.biquad = new BogBiquad();
    this.setParams(sampleRate, cutoff, q);
  }

  /** Command. Recompute the RBJ coefficients. */
  setParams(sampleRate, cutoff, q = 0.001) {
    const w0 = 2 * Math.PI * (cutoff / sampleRate);
    const cosw0 = Math.cos(w0);
    const alpha = Math.sin(w0) / (2 * q);
    this.biquad.setParams((1 - cosw0) / 2, 1 - cosw0, (1 - cosw0) / 2, 1 + alpha, -2 * cosw0, 1 - alpha);
  }

  /** Command. Zero the state. */
  reset() {
    this.biquad.reset();
  }

  /** Command. One sample. */
  next(sample) {
    return this.biquad.next(sample);
  }
}

// ── COMPLEX ARITHMETIC, only as much as the pole algebra needs ──────────────

/**
 * Pure function. A complex number as a plain pair. Named rather than inlined
 * because the bandpass pole algebra below is a transcription of C++ that uses
 * `std::complex` operators, and a transcription reads correctly only if each
 * operator has one spelling here too.
 *
 * @param {number} re
 * @param {number} im
 * @returns {{re: number, im: number}}
 *
 * @example cpx(1, 2) // {re: 1, im: 2}
 */
export function cpx(re, im) {
  return { re, im };
}

/** Pure function. Complex product. @example cpxMul(cpx(0, 1), cpx(0, 1)) // {re: -1, im: 0} */
export function cpxMul(a, b) {
  return cpx(a.re * b.re - a.im * b.im, a.re * b.im + a.im * b.re);
}

/** Pure function. Complex sum. @example cpxAdd(cpx(1, 2), cpx(3, -1)) // {re: 4, im: 1} */
export function cpxAdd(a, b) {
  return cpx(a.re + b.re, a.im + b.im);
}

/** Pure function. Complex difference. @example cpxSub(cpx(1, 2), cpx(3, -1)) // {re: -2, im: 3} */
export function cpxSub(a, b) {
  return cpx(a.re - b.re, a.im - b.im);
}

/** Pure function. Scale by a real. @example cpxScale(cpx(1, 2), 3) // {re: 3, im: 6} */
export function cpxScale(a, k) {
  return cpx(a.re * k, a.im * k);
}

/** Pure function. Conjugate. @example cpxConj(cpx(1, 2)) // {re: 1, im: -2} */
export function cpxConj(a) {
  return cpx(a.re, -a.im);
}

/** Pure function. Reciprocal. @example cpxInv(cpx(2, 0)) // {re: 0.5, im: 0} */
export function cpxInv(a) {
  const d = a.re * a.re + a.im * a.im;
  return cpx(a.re / d, -a.im / d);
}

/** Pure function. Modulus. @example cpxAbs(cpx(3, 4)) // 5 */
export function cpxAbs(a) {
  return Math.hypot(a.re, a.im);
}

/**
 * Pure function. The PRINCIPAL square root, matching `std::sqrt(std::complex)`
 * — the branch with non-negative real part, which is the branch the bandpass
 * pole-splitting relies on to keep its two conjugate pairs distinct.
 *
 * @param {{re: number, im: number}} a
 * @returns {{re: number, im: number}}
 *
 * @example cpxSqrt(cpx(-1, 0)) // {re: 0, im: 1}
 * @example cpxSqrt(cpx(4, 0)) // {re: 2, im: 0}
 * @example cpxSqrt(cpx(0, 2)) // {re: 1, im: 1}
 */
export function cpxSqrt(a) {
  const r = cpxAbs(a);
  const re = Math.sqrt((r + a.re) / 2);
  const im = Math.sqrt((r - a.re) / 2);
  return cpx(re, a.im < 0 ? -im : im);
}

// ── dsp/filters/multimode.hpp — THE ONE FILTER DESIGN BOTH PEQ AND VCF USE ──

/**
 * THE MULTIMODE DESIGNER — `MultimodeDesigner<N>::setParams`
 * (`dsp/filters/multimode.cpp:186`), ported ONCE and parameterised, because PEQ
 * and VCF are both nothing but this class with different parameter plumbing.
 *
 * ── WHAT IT IS ──────────────────────────────────────────────────────────────
 * An analogue prototype (Butterworth or Chebyshev), N poles, bilinear-warped to
 * the requested cutoff, factored into biquad sections. Four modes: lowpass,
 * highpass, bandpass, bandreject. 1…16 poles.
 *
 * ── THE THREE THINGS A CHECK WRITTEN FROM A COOKBOOK WOULD MISS ─────────────
 * 1. **`iq` IS APPLIED TO EXACTLY ONE SECTION.** `iq = 0.8 − 0.6·qbw`, and it
 *    multiplies `pole.x` only where `i == nb/2` — the MIDDLE biquad of the
 *    cascade. That is what makes the lowpass/highpass "resonance" knob a real
 *    peak instead of an all-sections Q change, and it is why a 12-pole lowpass
 *    resonates differently from a 4-pole one at the same knob.
 * 2. **BANDPASS SPLITS EACH POLE PAIR INTO TWO.** A bandpass of n poles is
 *    `2·(n/2)` biquads, each conjugate pair solved through
 *    `x = sqrt(p²·w² − 4·w0²)` — genuinely complex arithmetic, which is why the
 *    complex helpers above exist.
 * 3. **BANDWIDTH IS IN OCTAVES BY DEFAULT.** `PITCH_BANDWIDTH_MODE` sets the
 *    edges to `2^±bw · f`, so a bandpass's skirts are geometrically symmetric
 *    around the centre; `LINEAR_BANDWIDTH_MODE` is ±Hz/2 instead. VCF exposes
 *    the choice; PEQ is always pitched.
 *
 * `outGain` is 1 for Butterworth and `1/(e·2^(n−1))` for Chebyshev — the
 * ripple normalisation. A port that dropped it would be up to 30 dB hot.
 *
 * Command (mutates the biquad bank it is handed).
 */
export const BOG_MULTIMODE = Object.freeze({
  BUTTERWORTH: "butterworth",
  CHEBYSHEV: "chebyshev",
  LOWPASS: "lowpass",
  HIGHPASS: "highpass",
  BANDPASS: "bandpass",
  BANDREJECT: "bandreject",
  PITCH_BANDWIDTH: "pitched",
  LINEAR_BANDWIDTH: "linear",
});

/** `MultimodeTypes`' own limits (`dsp/filters/multimode.hpp:78-88`). The 3 Hz
 *  floor and 21 kHz ceiling are the design's, not a UI choice: below 3 Hz the
 *  float bilinear warp loses the pole, and their own comment says so. */
export const BOG_MULTIMODE_MIN_FREQUENCY = 3;
export const BOG_MULTIMODE_MAX_FREQUENCY = 21000;
export const BOG_MULTIMODE_MIN_QBW = 0;
export const BOG_MULTIMODE_MAX_QBW = 1;
export const BOG_MULTIMODE_MIN_BW_LINEAR = 10;
export const BOG_MULTIMODE_MAX_BW_LINEAR = 5000;
export const BOG_MULTIMODE_MIN_BW_PITCH = 1 / ((1 * 12 * 100) / 25);
export const BOG_MULTIMODE_MAX_BW_PITCH = 2;
export const BOG_MULTIMODE_MAX_POLES = 16;

/** The `iq` line, `dsp/filters/multimode.cpp:283`. Their commented-out
 *  alternative was `1/sqrt(2) − 0.65·qbw`; the shipped one is this. */
const BOG_IQ_BASE = 0.8;
const BOG_IQ_SPAN = 0.6;

/** `MultimodeDesigner::effectiveMinimumFrequency` — the 3 Hz floor rises with
 *  the sample rate, in whole multiples of 44100. */
function bogEffectiveMinFrequency(sampleRate) {
  return BOG_MULTIMODE_MIN_FREQUENCY * Math.max(1, Math.round(sampleRate / 44100));
}

/**
 * Pure function. One analogue prototype pole, in the form the designer keeps it:
 * the pole itself plus the two real combinations (`x = 2·Re`, `y = |p|²`) the
 * biquad formulas are written in terms of. `Pole` in
 * `dsp/filters/multimode.hpp:92`.
 *
 * @param {number} re - the pole's real part, already negated by the caller
 * @param {number} im
 * @param {number} x - 2·Re of the ORIGINAL (un-negated) pole
 * @param {number} y - |p|²
 * @returns {object}
 *
 * @example bogPole(0.7071, 0.7071, -1.4142, 1).y // 1
 */
export function bogPole(re, im, x, y) {
  const p = cpx(re, im);
  return { p, x, y, pc: cpxConj(p), p2: cpxMul(p, p), i2p: cpxInv(cpxScale(p, 2)), i2pc: cpxInv(cpxScale(cpxConj(p), 2)), r: cpxAbs(p) };
}

/**
 * Pure function. The analogue prototype poles for a type and order — the
 * `repole` branch of `MultimodeDesigner::setParams`
 * (`dsp/filters/multimode.cpp:222-268`).
 *
 * @param {string} type - BOG_MULTIMODE.BUTTERWORTH | .CHEBYSHEV
 * @param {number} nPoles - 1…16
 * @param {string} mode - a BOG_MULTIMODE mode (Chebyshev's ripple depends on it)
 * @param {number} qbw - 0…1 (Chebyshev lowpass/highpass ripple only)
 * @returns {{poles: object[], outGain: number}}
 *
 * @example // a 2-pole Butterworth's pole pair sits at 45°, so |p|² is 1
 * @example bogPrototypePoles("butterworth", 2, "lowpass", 0).poles[0].y // 1
 * @example bogPrototypePoles("butterworth", 4, "lowpass", 0).poles.length // 2
 * @example bogPrototypePoles("butterworth", 4, "lowpass", 0).outGain // 1
 * @example // Chebyshev normalises for its own ripple, so its gain is not 1
 * @example bogPrototypePoles("chebyshev", 4, "bandpass", 0).outGain // 0.1252971616259501
 */
export function bogPrototypePoles(type, nPoles, mode, qbw) {
  const np = Math.trunc(nPoles / 2) + (nPoles % 2 === 1 ? 1 : 0);
  const poles = new Array(np);
  if (type === BOG_MULTIMODE.BUTTERWORTH) {
    for (let k = 1, j = np - 1; k <= np; ++k, --j) {
      const a = ((2 * k + nPoles - 1) * Math.PI) / (2 * nPoles);
      const re = Math.cos(a);
      const im = Math.sin(a);
      poles[j] = bogPole(-re, im, re + re, re * re + im * im);
    }
    return { poles, outGain: 1 };
  }
  if (type !== BOG_MULTIMODE.CHEBYSHEV) {
    throw new Error(`bogPrototypePoles: unknown filter type ${JSON.stringify(type)}`);
  }
  let ripple = 3;
  if (mode === BOG_MULTIMODE.LOWPASS || mode === BOG_MULTIMODE.HIGHPASS) ripple += Math.max(0, 6 * qbw);
  let e = Math.pow(10, ripple / 10) - 1;
  e = Math.sqrt(e);
  const ef = Math.asinh(1 / e) / nPoles;
  const efr = -Math.sinh(ef);
  const efi = Math.cosh(ef);
  for (let k = 1, j = np - 1; k <= np; ++k, --j) {
    const a = ((2 * k - 1) * Math.PI) / (2 * nPoles);
    const re = efr * Math.sin(a);
    const im = efi * Math.cos(a);
    poles[j] = bogPole(-re, im, re + re, re * re + im * im);
  }
  return { poles, outGain: 1 / (e * Math.pow(2, nPoles - 1)) };
}

/**
 * A BANK of biquads in series, with only the first `n` active —
 * `BiquadBank<T, N>` (`dsp/filters/multimode.cpp:135`, the non-SIMD branch,
 * which is the one whose arithmetic is stated plainly).
 *
 * Command (mutates its biquads).
 */
export class BogBiquadBank {
  constructor(capacity) {
    this.capacity = capacity;
    this.biquads = [];
    for (let i = 0; i < capacity; i++) this.biquads.push(new BogBiquad());
    this.n = capacity;
  }

  /** Command. Set section `i`'s six coefficients. */
  setParams(i, a0, a1, a2, b0, b1, b2) {
    if (i < 0 || i >= this.capacity) throw new Error(`BogBiquadBank: section ${i} is outside 0…${this.capacity - 1}`);
    this.biquads[i].setParams(a0, a1, a2, b0, b1, b2);
  }

  /** Command. `BiquadBank::setN` — RESETS the sections it switches off, so a
   *  slope change cannot leak a stale tail back in when the section returns. */
  setN(n) {
    this.n = n;
    for (let i = n; i < this.capacity; i++) this.biquads[i].reset();
  }

  /** Command. Zero every section. */
  reset() {
    for (const b of this.biquads) b.reset();
  }

  /** Command. One sample through the active cascade. */
  next(sample) {
    let s = sample;
    for (let i = 0; i < this.n; i++) s = this.biquads[i].next(s);
    return s;
  }
}

/**
 * THE MULTIMODE FILTER — `MultimodeBase<N>` plus its designer, as one object.
 *
 * `setParams` is the transcription of `MultimodeDesigner<N>::setParams`; read
 * the BOG_MULTIMODE docblock above for the three things about it that matter.
 * It reproduces their `repole`/`redesign` memoisation, which is not an
 * optimisation here either: `_poles` is only rebuilt when the ORDER or TYPE
 * changes, so a frequency sweep re-solves the bilinear warp and nothing else.
 *
 * Command (mutates the bank and the cached design).
 */
export class BogMultimodeFilter {
  constructor(capacityBiquads) {
    this.biquads = new BogBiquadBank(capacityBiquads);
    this.outGain = 1;
    this.poles = [];
    this.sampleRate = 44100;
    this.type = null;
    this.mode = null;
    this.nPoles = 0;
    this.frequency = -1;
    this.qbw = -1;
    this.bandwidthMode = null;
    this.nBiquads = 0;
  }

  /** Command. Zero every section. */
  reset() {
    this.biquads.reset();
  }

  /** Command. One sample, INCLUDING the type's output gain. */
  next(sample) {
    return this.outGain * this.biquads.next(sample);
  }

  /**
   * Command. Design the filter. Arguments and their meanings are the C++'s.
   *
   * @param {number} sampleRate - hertz
   * @param {string} type - BOG_MULTIMODE.BUTTERWORTH | .CHEBYSHEV
   * @param {number} poles - 1…16
   * @param {string} mode - BOG_MULTIMODE.LOWPASS | .HIGHPASS | .BANDPASS | .BANDREJECT
   * @param {number} frequency - hertz (cutoff, or bandpass centre)
   * @param {number} qbw - 0…1: resonance for LP/HP, bandwidth for BP/BR
   * @param {string} bandwidthMode - BOG_MULTIMODE.PITCH_BANDWIDTH | .LINEAR_BANDWIDTH
   * @returns {void}
   */
  setParams(sampleRate, type, poles, mode, frequency, qbw, bandwidthMode = BOG_MULTIMODE.PITCH_BANDWIDTH) {
    let f = Math.max(frequency, bogEffectiveMinFrequency(sampleRate));
    f = Math.min(f, 0.49 * sampleRate);
    const repole = this.type !== type || this.mode !== mode || this.nPoles !== poles
      || (type === BOG_MULTIMODE.CHEBYSHEV && (mode === BOG_MULTIMODE.LOWPASS || mode === BOG_MULTIMODE.HIGHPASS) && this.qbw !== qbw);
    const redesign = repole || this.frequency !== f || this.qbw !== qbw
      || this.sampleRate !== sampleRate || this.bandwidthMode !== bandwidthMode;
    this.sampleRate = sampleRate;
    this.half2PiST = Math.PI * (1 / sampleRate);
    this.type = type;
    this.nPoles = poles;
    this.mode = mode;
    this.frequency = f;
    this.qbw = qbw;
    this.bandwidthMode = bandwidthMode;
    if (repole) {
      const { poles: p, outGain } = bogPrototypePoles(type, poles, mode, qbw);
      this.poles = p;
      this.outGain = outGain;
    }
    if (!redesign) return;
    if (mode === BOG_MULTIMODE.LOWPASS || mode === BOG_MULTIMODE.HIGHPASS) this.#designPoleMode();
    else this.#designBandMode();
  }

  /** Command. The LOWPASS / HIGHPASS branch (`multimode.cpp:277-330`). */
  #designPoleMode() {
    const nPoles = this.nPoles;
    this.nBiquads = Math.trunc(nPoles / 2) + (nPoles % 2);
    this.biquads.setN(this.nBiquads);
    const iq = BOG_IQ_BASE - BOG_IQ_SPAN * this.qbw;
    const wa = Math.tan(this.frequency * this.half2PiST);
    const wa2 = wa * wa;
    let ni = 0;
    let nb = this.nBiquads;
    if (this.mode === BOG_MULTIMODE.LOWPASS) {
      if (nPoles % 2 === 1) {
        ++ni;
        --nb;
        const wap = wa * this.poles[0].p.re;
        this.biquads.setParams(0, wa, wa, 0, wap + 1, wap - 1, 0);
      }
      const a0 = wa2;
      const a1 = wa2 + wa2;
      const a2 = wa2;
      for (let i = 0; i < nb; ++i) {
        const pole = this.poles[ni + i];
        const ywa2 = pole.y * wa2;
        const ywa21 = ywa2 + 1;
        const x = ((i === Math.trunc(nb / 2) ? 1 : 0) * (iq - 1) + 1) * pole.x;
        const xwa = x * wa;
        this.biquads.setParams(ni + i, a0, a1, a2, ywa21 - xwa, -2 + (ywa2 + ywa2), ywa21 + xwa);
      }
      return;
    }
    if (nPoles % 2 === 1) {
      ++ni;
      --nb;
      const rp = this.poles[0].p.re;
      this.biquads.setParams(0, 1, -1, 0, wa + rp, wa - rp, 0);
    }
    for (let i = 0; i < nb; ++i) {
      const pole = this.poles[ni + i];
      const wa2y = wa2 + pole.y;
      const x = ((i === Math.trunc(nb / 2) ? 1 : 0) * (iq - 1) + 1) * pole.x;
      const xwa = x * wa;
      this.biquads.setParams(ni + i, 1, -2, 1, wa2y - xwa, (wa2 + wa2) - (pole.y + pole.y), wa2y + xwa);
    }
  }

  /** Command. The BANDPASS / BANDREJECT branch (`multimode.cpp:332-455`). */
  #designBandMode() {
    const nPoles = this.nPoles;
    this.nBiquads = Math.trunc(nPoles / 2) * 2 + (nPoles % 2);
    this.biquads.setN(this.nBiquads);
    let wdl = 0;
    let wdh = 0;
    if (this.bandwidthMode === BOG_MULTIMODE.LINEAR_BANDWIDTH) {
      const bandwidth = Math.max(BOG_MULTIMODE_MIN_BW_LINEAR, BOG_MULTIMODE_MAX_BW_LINEAR * this.qbw);
      wdl = Math.max(BOG_MULTIMODE_MIN_FREQUENCY, this.frequency - 0.5 * bandwidth);
      wdh = Math.min(BOG_MULTIMODE_MAX_FREQUENCY, Math.max(wdl + 10, this.frequency + 0.5 * bandwidth));
    } else if (this.bandwidthMode === BOG_MULTIMODE.PITCH_BANDWIDTH) {
      const bandwidth = Math.max(BOG_MULTIMODE_MIN_BW_PITCH, BOG_MULTIMODE_MAX_BW_PITCH * this.qbw);
      wdl = Math.max(BOG_MULTIMODE_MIN_FREQUENCY, Math.pow(2, -bandwidth) * this.frequency);
      wdh = Math.min(BOG_MULTIMODE_MAX_FREQUENCY, Math.max(wdl + 10, Math.pow(2, bandwidth) * this.frequency));
    } else {
      throw new Error(`BogMultimodeFilter: unknown bandwidth mode ${JSON.stringify(this.bandwidthMode)}`);
    }
    const wal = Math.tan(wdl * this.half2PiST);
    const wah = Math.tan(wdh * this.half2PiST);
    const w = wah - wal;
    const w2 = w * w;
    const w02 = wah * wal;
    let ni = 0;
    let nb = this.nBiquads;
    if (this.mode === BOG_MULTIMODE.BANDPASS) {
      const a0 = w;
      const a2 = -w;
      if (nPoles % 2 === 1) {
        ++ni;
        --nb;
        const wp = w * this.poles[0].p.re;
        this.biquads.setParams(0, a0, 0, a2, 1 + wp + w02, -2 + (w02 + w02), 1 - wp + w02);
      }
      for (let i = 0; i < nb; i += 2) {
        const pole = this.poles[ni + Math.trunc(i / 2)];
        let x = cpxScale(pole.p2, w2);
        x = cpxSub(x, cpx(4 * w02, 0));
        x = cpxSqrt(x);
        const xc = cpxConj(x);
        const wp = cpxScale(pole.p, w);
        const wpc = cpxScale(pole.pc, w);
        const y1 = cpxScale(cpxSub(x, wp), 0.5);
        const y1c = cpxScale(cpxSub(xc, wpc), 0.5);
        const y2 = cpxScale(cpxSub(cpxScale(x, -1), wp), 0.5);
        const y2c = cpxScale(cpxSub(cpxScale(xc, -1), wpc), 0.5);
        const f1a = -cpxAdd(y1, y1c).re;
        const f2a = cpxMul(y1, y1c).re;
        const f1b = -cpxAdd(y2, y2c).re;
        const f2b = cpxMul(y2, y2c).re;
        this.biquads.setParams(ni + i, a0, 0, a2, 1 + f1a + f2a, -2 + (f2a + f2a), 1 - f1a + f2a);
        this.biquads.setParams(ni + i + 1, a0, 0, a2, 1 + f1b + f2b, -2 + (f2b + f2b), 1 - f1b + f2b);
      }
      return;
    }
    const a0 = 1 + w02;
    const a1 = -2 + (w02 + w02);
    if (nPoles % 2 === 1) {
      ++ni;
      --nb;
      const rp = this.poles[0].p.re;
      const rpw02 = rp * w02;
      this.biquads.setParams(0, a0, a1, a0, rp + w + rpw02, -2 * rp + (rpw02 + rpw02), rp - w + rpw02);
    }
    for (let i = 0; i < nb; i += 2) {
      const pole = this.poles[ni + Math.trunc(i / 2)];
      let x = cpxScale(pole.p2, -4 * w02);
      x = cpxAdd(x, cpx(w2, 0));
      x = cpxSqrt(x);
      const xc = cpxConj(x);
      const y1 = cpxMul(cpxSub(x, cpx(w, 0)), pole.i2p);
      const y1c = cpxMul(cpxSub(xc, cpx(w, 0)), pole.i2pc);
      const y2 = cpxMul(cpxSub(cpxScale(x, -1), cpx(w, 0)), pole.i2p);
      const y2c = cpxMul(cpxSub(cpxScale(xc, -1), cpx(w, 0)), pole.i2pc);
      const f1a = cpxScale(cpxAdd(y1, y1c), -pole.r).re;
      const f2a = cpxScale(cpxMul(y1, y1c), pole.r).re;
      const f1b = cpxScale(cpxAdd(y2, y2c), -pole.r).re;
      const f2b = cpxScale(cpxMul(y2, y2c), pole.r).re;
      this.biquads.setParams(ni + i, a0, a1, a0, pole.r + f1a + f2a, -2 * pole.r + (f2a + f2a), pole.r - f1a + f2a);
      this.biquads.setParams(ni + i + 1, a0, a1, a0, pole.r + f1b + f2b, -2 * pole.r + (f2b + f2b), pole.r - f1b + f2b);
    }
  }
}

// ── dsp/noise.hpp — SEEDED (D2) ─────────────────────────────────────────────

/** `std::minstd_rand`'s constants — Lehmer / MINSTD. */
const MINSTD_A = 48271;
const MINSTD_M = 2147483647;

/**
 * Pure function. A knob's seed, scrambled — and this is HALF OF D2, not a detail.
 *
 * MEASURED, which is why it exists: seeded raw, `BogMinstd(0)` starts at state 1
 * and its first draw is 48271, i.e. `bogUniform` ≈ −0.99996. So a fresh
 * SampleHold's first held value was always the BOTTOM of its range, and seven of
 * them in one patch all started at the same corner — the sound P2 is made of,
 * ruined by a cold generator.
 *
 * Bogaudio does not have this problem for a reason worth copying: `Seeds::next()`
 * hands each `minstd_rand` a draw from a `mt19937`, so every generator starts from
 * a WELL-DISTRIBUTED state. This is the deterministic stand-in for that mt19937 —
 * a splitmix32 finalising mix, chosen because it is four lines, has no state, and
 * decorrelates adjacent seeds (which matters: the noise trees below seed their
 * eight sub-generators as `seed`, `seed+1`, … and adjacent MINSTD states produce
 * visibly correlated streams).
 *
 * @param {number} seed - any integer, including 0
 * @returns {number} 1 … 2^31 − 2, a valid MINSTD state
 *
 * @example bogScrambleSeed(0) // 1684164659
 * @example bogScrambleSeed(1) // 1580013427
 * @example bogScrambleSeed(2) // 140556410
 * @example // and the FIRST DRAW off seed 0 is mid-range rather than −0.99996
 * @example bogUniform(new BogMinstd(0).nextRaw()) // 0.0908709444443756
 */
export function bogScrambleSeed(seed) {
  let x = Math.trunc(Math.abs(seed)) | 0;
  x = (x + 0x9e3779b9) | 0;
  x = Math.imul(x ^ (x >>> 16), 0x21f0aaad);
  x = Math.imul(x ^ (x >>> 15), 0x735a2d97);
  x = (x ^ (x >>> 15)) >>> 0;
  return (x % (MINSTD_M - 2)) + 1;
}

/**
 * `std::minstd_rand` — `x ← 48271·x mod (2^31 − 1)`, exactly, because
 * `48271·(2^31 − 1) < 2^53`. Their generator, ours only in its seed (D2).
 *
 * Command (advances the state).
 */
export class BogMinstd {
  constructor(seed) {
    // The seed is SCRAMBLED, not taken raw — see bogScrambleSeed for the
    // measurement. A state of 0 is also a fixed point of a multiplicative
    // generator, and the scramble's range excludes it.
    this.state = bogScrambleSeed(seed);
  }

  /** Command. The next raw value, 1…2^31−2. */
  nextRaw() {
    this.state = (MINSTD_A * this.state) % MINSTD_M;
    return this.state;
  }
}

/**
 * Pure function. A raw MINSTD value mapped to `uniform_real_distribution(-1, 1)`
 * — the one part of D2 that is NOT bit-faithful, because libstdc++'s mapping is
 * implementation-defined. This is the obvious affine map over the generator's
 * own 1…m−1 range.
 *
 * @param {number} raw - 1 … 2^31−2
 * @returns {number} −1 … 1
 *
 * @example bogUniform(1) // -1
 * @example bogUniform(2147483646) // 1
 * @example bogUniform(1073741823) // -4.656612873077393e-10
 */
export function bogUniform(raw) {
  return -1 + (2 * (raw - 1)) / (MINSTD_M - 2);
}

/**
 * `WhiteNoiseGenerator` (`dsp/noise.hpp:32`) — uniform in [−1, 1], flat per
 * hertz. Note UNIFORM, not gaussian: the amplitude histogram is a box.
 *
 * Command (advances the generator).
 */
export class BogWhiteNoise {
  constructor(seed) {
    this.rng = new BogMinstd(seed);
    this.current = 0;
  }

  /** Command. One sample. */
  next() {
    this.current = bogUniform(this.rng.nextRaw());
    return this.current;
  }
}

/** `BasePinkNoiseGenerator::_n` — seven octave generators (`dsp/noise.hpp:40`). */
const BOG_PINK_OCTAVES = 7;

/**
 * `BasePinkNoiseGenerator<G>` (`dsp/noise.hpp:38`) — the Voss-McCartney tree,
 * parameterised over the generator it sums. With `G = white` it is PINK
 * (−3 dB/octave); with `G = pink` it is RED (−6 dB/octave), which is exactly how
 * Bogaudio builds red, and the reason this class takes a factory.
 *
 * The trick is the counter: octave generator `i` is only re-drawn when bit `i`
 * of the sample counter is set, so each contributes at half the rate of the one
 * below it. `_count` is SEEDED FROM THE GENERATOR in the original, so the tree's
 * phase is part of what a seed determines.
 *
 * Command (advances eight generators and a counter).
 */
export class BogPinkNoise {
  constructor(seed, makeGenerator = (s) => new BogWhiteNoise(s)) {
    this.g = makeGenerator(seed);
    this.gs = [];
    for (let i = 0; i < BOG_PINK_OCTAVES; i++) this.gs.push(makeGenerator(seed + i + 1));
    this.count = new BogMinstd(seed + BOG_PINK_OCTAVES + 1).nextRaw() >>> 0;
    this.current = 0;
  }

  /** Command. One sample. */
  next() {
    let sum = this.g.next();
    for (let i = 0, bit = 1; i < BOG_PINK_OCTAVES; ++i, bit <<= 1) {
      sum += (this.count & bit) !== 0 ? this.gs[i].next() : this.gs[i].current;
    }
    this.count = (this.count + 1) >>> 0;
    this.current = sum / (BOG_PINK_OCTAVES + 1);
    return this.current;
  }
}

/**
 * `BlueNoiseGenerator` (`dsp/noise.hpp:69`) — the FIRST DIFFERENCE of pink,
 * which is +3 dB/octave. One line, and the reason `current` exists on every
 * generator above.
 *
 * Command (advances the pink tree).
 */
export class BogBlueNoise {
  constructor(seed) {
    this.pink = new BogPinkNoise(seed);
    this.last = 0;
    this.current = 0;
  }

  /** Command. One sample. */
  next() {
    const t = this.last;
    this.last = this.pink.next();
    this.current = this.last - t;
    return this.current;
  }
}

/**
 * Pure function. A noise generator by name — the four `SampleHold::NoiseType`
 * values, built here so the roster and the kernel cannot disagree about which
 * name means which tree.
 *
 * @param {string} kind - "white" | "blue" | "pink" | "red"
 * @param {number} seed
 * @returns {object} a generator with `next()` and `current`
 *
 * @example bogNoiseGenerator("white", 1).next() !== 0 // true
 * @example // red is the pink tree applied to itself — Bogaudio's own definition
 * @example bogNoiseGenerator("red", 1) instanceof BogPinkNoise // true
 */
export function bogNoiseGenerator(kind, seed) {
  if (kind === "white") return new BogWhiteNoise(seed);
  if (kind === "blue") return new BogBlueNoise(seed);
  if (kind === "pink") return new BogPinkNoise(seed);
  if (kind === "red") return new BogPinkNoise(seed, (s) => new BogPinkNoise(s));
  throw new Error(`bogNoiseGenerator: unknown noise type ${JSON.stringify(kind)}`);
}

/** `SampleHold::noise()`'s per-type gain (`SampleHold.cpp:236`) — blue and red
 *  are boosted 2×, pink 1.5×, then all are clamped to ±1. Those factors are
 *  loudness matching for trees whose summed variance differs. */
const BOG_NOISE_GAIN = Object.freeze({ white: 1, blue: 2, pink: 1.5, red: 2 });

/**
 * Pure function. `SampleHold::noise()`'s scaling, split out so the gain table has
 * one home.
 *
 * @param {string} kind - "white" | "blue" | "pink" | "red"
 * @param {number} raw - the generator's output
 * @returns {number} −1 … 1
 *
 * @example bogNoiseScaled("white", 0.5) // 0.5
 * @example bogNoiseScaled("pink", 0.5) // 0.75
 * @example bogNoiseScaled("blue", 0.9) // 1
 */
export function bogNoiseScaled(kind, raw) {
  const gain = BOG_NOISE_GAIN[kind];
  if (gain === undefined) throw new Error(`bogNoiseScaled: unknown noise type ${JSON.stringify(kind)}`);
  return bogClamp(gain * raw, -1, 1);
}

/**
 * `RandomWalk` (`dsp/noise.cpp:34`) — the whole of `Walk`, and a much more
 * interesting generator than "smoothed noise".
 *
 * ── THE RECURRENCE, IN FULL ─────────────────────────────────────────────────
 *   delta = white()                       and delta is NEGATED at a wall, so
 *                                         the walk reflects instead of sticking
 *   last  = damp·last + delta             a leaky integrator: this is what makes
 *                                         it a WALK rather than noise
 *   bias  = bias · biasDamp               a jump's landing point decays away
 *   out   = clamp(bias + lowpass(last))
 *
 * `damp` runs 0.9999 (at rate 0) down to 0.98 (at rate 1) and the lowpass cutoff
 * runs `max(2, rate·0.49·min(44100, fs))` — so the Rate knob moves BOTH the
 * integrator's memory and the smoother, which is why one knob changes the
 * character and not just the speed.
 *
 * Command (four pieces of state).
 */
export class BogRandomWalk {
  constructor(sampleRate, seed, min = -5, max = 5, change = 0.5) {
    this.min = min;
    this.max = max;
    this.last = 0;
    this.lastOut = 0;
    this.bias = 0;
    this.biasDamp = 1;
    this.damp = 0;
    this.noise = new BogWhiteNoise(seed);
    this.filter = new BogLowPassFilter(sampleRate, 2);
    this.setParams(sampleRate, change);
  }

  /** Command. `RandomWalk::setParams` (`dsp/noise.cpp:34`). */
  setParams(sampleRate, change) {
    this.filter.setParams(sampleRate, Math.max(2, change * 0.49 * Math.min(44100, sampleRate)));
    const maxDamp = 0.98;
    const minDamp = 0.9999;
    this.damp = maxDamp + (1 - change) * (minDamp - maxDamp);
    this.biasDamp = 1 - change * (2 / sampleRate);
  }

  /** Command. `RandomWalk::jump` — teleport to a new point in range. */
  jump() {
    this.tell(Math.abs(this.noise.next()) * (this.max - this.min) + this.min);
  }

  /** Command. `RandomWalk::tell` — set the walk's position and clear the filter. */
  tell(v) {
    this.last = v;
    this.bias = v;
    this.filter.reset();
  }

  /** Command. `RandomWalk::_next` — one sample. */
  next() {
    let delta = this.noise.next();
    if ((this.lastOut >= this.max && delta > 0) || (this.lastOut <= this.min && delta < 0)) delta = -delta;
    this.last = this.damp * this.last + delta;
    this.bias *= this.biasDamp;
    this.lastOut = Math.min(Math.max(this.bias + this.filter.next(this.last), this.min), this.max);
    return this.lastOut;
  }
}

// ── EDGE DETECTORS ──────────────────────────────────────────────────────────

/** `bogaudio::Trigger`'s thresholds (`rack_overrides.hpp:13`) — a Schmitt
 *  trigger that fires at 1 V and rearms below 0.1 V. Those are VOLTS, so a gate
 *  that never exceeds 1 V never fires: it is why Bogaudio patches use 10 V gates. */
export const BOG_TRIGGER_HIGH_V = 1;
export const BOG_TRIGGER_LOW_V = 0.1;

/**
 * `bogaudio::Trigger` — `rack::dsp::SchmittTrigger` with those thresholds.
 * `isHigh()` is as load-bearing as `process()`: SampleHold's TRACK mode and
 * Walk's track-and-hold read the LEVEL, while sample-and-hold reads the EDGE.
 *
 * Command (holds one bit).
 */
export class BogTrigger {
  constructor() {
    this.high = false;
  }

  /** Command. Reset to low. */
  reset() {
    this.high = false;
  }

  /** Command. One sample in volts; true exactly on a rising crossing. */
  process(volts) {
    if (this.high) {
      if (volts <= BOG_TRIGGER_LOW_V) this.high = false;
      return false;
    }
    if (volts >= BOG_TRIGGER_HIGH_V) {
      this.high = true;
      return true;
    }
    return false;
  }

  /** Query. Is the gate currently high? */
  isHigh() {
    return this.high;
  }
}

/** `PositiveZeroCrossing`'s constants (`dsp/signal.hpp:71`). */
const BOG_ZC_THRESHOLD = 0.01;
const BOG_ZC_ZEROES_FOR_RESET = 20;

/**
 * `PositiveZeroCrossing` (`dsp/signal.cpp:120`) — the VCO's SYNC detector, and
 * NOT a Schmitt trigger. Its third state exists to handle a sync source that
 * goes to exactly zero and STAYS there: after 20 samples inside the dead band it
 * rearms, so a gate that stops mid-cycle can retrigger. A plain threshold
 * detector would either miss those or fire on every sample of the flat part.
 *
 * Command (a three-state machine).
 */
export class BogPositiveZeroCrossing {
  constructor(triggerable = true) {
    this.triggerable = triggerable;
    this.state = "negative";
    this.zeroCount = 0;
  }

  /** Command. Reset to the negative state. */
  reset() {
    this.state = "negative";
  }

  /** Command. One sample in volts; true on a positive-going crossing. */
  next(volts) {
    if (this.state === "negative") {
      if (volts > BOG_ZC_THRESHOLD) {
        this.state = "positive";
        return true;
      }
      return false;
    }
    if (this.state === "positive") {
      if (volts < -BOG_ZC_THRESHOLD) this.state = "negative";
      else if (volts < BOG_ZC_THRESHOLD && this.triggerable) {
        this.state = "countZeroes";
        this.zeroCount = 1;
      }
      return false;
    }
    if (volts >= -BOG_ZC_THRESHOLD) {
      if (++this.zeroCount >= BOG_ZC_ZEROES_FOR_RESET) this.state = "negative";
    } else {
      this.state = "negative";
    }
    return false;
  }
}

// ── dsp/table.hpp — THE TWO TABLES ──────────────────────────────────────────

/** `StaticSineTable` / `StaticBlepTable` are both `<…, 12>` — 4096 entries. */
const BOG_TABLE_LENGTH = 1 << 12;

/**
 * Pure function. `SineTable::_generate` (`dsp/table.cpp:17`) — one period of
 * sine, built by quarter-wave symmetry exactly as they do it.
 *
 * @param {number} length - table length, a power of two
 * @returns {Float64Array}
 *
 * @example bogSineTable(4096)[0] // 0
 * @example bogSineTable(4096)[1024] // 1
 * @example bogSineTable(4096)[2048] // -0
 */
export function bogSineTable(length) {
  const table = new Float64Array(length);
  const twoPI = 2 * Math.PI;
  const q = length / 4;
  for (let i = 0; i <= q; ++i) table[i] = Math.sin(twoPI * (i / length));
  for (let i = 1; i < q; ++i) table[i + q] = table[q - i];
  for (let i = 0, j = length / 2; i < j; ++i) table[i + j] = -table[i];
  return table;
}

/** `BlepTable::_generate`'s own magic numbers (`dsp/table.cpp:31`), with their
 *  comment intact: `scaledPi` is "some amount of a sinc function" and `norm` is
 *  a normalisation their own FIXME calls magic. Both are reproduced because the
 *  BLEP's SHAPE is what removes the aliasing, and a "cleaner" sinc would be a
 *  different oscillator. */
const BOG_BLEP_SCALED_PI = Math.PI * 10;
const BOG_BLEP_NORM_DIVISOR = 40;

/**
 * Pure function. `BlepTable::_generate` (`dsp/table.cpp:31`) — an integrated,
 * Hamming-windowed sinc: the correction the band-limited saw subtracts at its
 * discontinuity. This is the difference between Bogaudio's VCO and a naive
 * ramp — a naive saw folds its high harmonics back down as inharmonic whistling
 * when you play it high, and this table is what stops that.
 *
 * @param {number} length - table length, a power of two
 * @returns {Float64Array}
 *
 * @example bogBlepTable(4096).length // 4096
 * @example // THE STEP IT CORRECTS is the jump across the centre: +1 to −1
 * @example bogBlepTable(4096)[2047] // 0.9999994587877828
 * @example bogBlepTable(4096)[2048] // -1
 * @example // and it decays to nothing at both ends, which is the windowing
 * @example Math.abs(bogBlepTable(4096)[0]) < 0.003 // true
 */
export function bogBlepTable(length) {
  const table = new Float64Array(length);
  const half = length / 2;
  table[half] = 0;
  for (let i = 1; i < half; ++i) {
    const radians = BOG_BLEP_SCALED_PI * (i / half);
    table[half + i] = Math.sin(radians) / radians;
  }
  const norm = length / BOG_BLEP_NORM_DIVISOR;
  let sum = 0;
  for (let i = half; i < length; ++i) {
    sum += table[i];
    table[i] = sum / norm;
  }
  for (let i = half; i < length; ++i) table[i] -= 1;
  for (let i = 0; i < half; ++i) table[i] = -table[length - 1 - i];
  // HammingWindow (`dsp/analyzer.cpp:16` with alpha 0.54), applied in place.
  const alpha = 0.54;
  const invAlpha = 1 - alpha;
  const twoPIEtc = (2 * Math.PI) / length;
  for (let i = 0; i < length; ++i) table[i] *= invAlpha * Math.cos(twoPIEtc * i + Math.PI) + alpha;
  return table;
}

/** Both tables, built once — they are pure functions of their length, so one
 *  copy is shared by every kernel instance exactly as `StaticTable` shares them. */
export const BOG_SINE_TABLE = bogSineTable(BOG_TABLE_LENGTH);
export const BOG_BLEP_TABLE = bogBlepTable(BOG_TABLE_LENGTH);

// ── dsp/oscillator.hpp — THE PHASOR AND THE WAVEFORMS ───────────────────────

/**
 * `Phasor::cyclePhase` is `UINT32_MAX` — 2^32 − 1, NOT 2^32. Every phase in this
 * section is an integer in [0, cyclePhase), and the off-by-one matters: their
 * `phase % cyclePhase` on a 2^32-periodic accumulator is not a clean modulo.
 */
export const BOG_CYCLE_PHASE = 4294967295;

/**
 * Pure function. A phase value folded into [0, cyclePhase).
 *
 * ── D11, AND IT IS A ONE-LSB DIVERGENCE ─────────────────────────────────────
 * Their `_phase` is a uint64 that accumulates forever; ours is a float kept in
 * range, because a JS number stops being an exact integer past 2^53 — which at
 * 48 kHz is about 78 minutes of a 440 Hz note, i.e. inside a real presentation.
 * The two agree exactly except where their arithmetic goes NEGATIVE: a negative
 * int64 reinterpreted as uint64 is `2^64 − k`, and `2^64 mod (2^32 − 1) = 1`,
 * so their answer is one LSB off a true modulo. One part in 2^32 of a cycle,
 * reachable only in the first cycle after a reset. Named rather than hidden.
 *
 * @param {number} phase - any real
 * @returns {number} 0 … cyclePhase − 1
 *
 * @example bogWrapPhase(0) // 0
 * @example bogWrapPhase(4294967295) // 0
 * @example bogWrapPhase(-1) // 4294967294
 */
export function bogWrapPhase(phase) {
  const p = phase % BOG_CYCLE_PHASE;
  return p < 0 ? p + BOG_CYCLE_PHASE : p;
}

/**
 * Pure function. `Phasor::_update` — the per-sample phase increment.
 * TRUNCATED to an integer, as theirs is, so two oscillators a hair apart in
 * frequency can land on the SAME increment and stop beating. That quantisation
 * is 1/(2^32) of a cycle per sample, i.e. 0.011 Hz at 48 kHz.
 *
 * @param {number} frequency - hertz
 * @param {number} sampleRate - hertz
 * @returns {number} phase units per sample
 *
 * @example bogPhaseDelta(0, 48000) // 0
 * @example bogPhaseDelta(48000, 48000) // 0
 * @example bogPhaseDelta(1, 48000) // 89478
 */
export function bogPhaseDelta(frequency, sampleRate) {
  return Math.trunc((frequency / sampleRate) * BOG_CYCLE_PHASE) % BOG_CYCLE_PHASE;
}

/**
 * Pure function. `SawOscillator::nextForPhase` — a raw ±1 ramp.
 *
 * @param {number} phase - 0 … cyclePhase
 * @returns {number} −1 … 1
 *
 * @example bogSawForPhase(0) // -1
 * @example bogSawForPhase(2147483647) // -2.3283064365386963e-10
 */
export function bogSawForPhase(phase) {
  return (bogWrapPhase(phase) / BOG_CYCLE_PHASE) * 2 - 1;
}

/**
 * Pure function. `BandLimitedSawOscillator::nextForPhase`
 * (`dsp/oscillator.cpp:147`) — the ramp with a BLEP correction subtracted on
 * either side of the wrap.
 *
 * `qd` is `quality · delta`: the correction is spread over `quality` samples of
 * phase, and `quality` is itself clamped to `0.5·fs/f`, so a high note gets a
 * shorter correction rather than one that laps itself.
 *
 * @param {number} phase - 0 … cyclePhase
 * @param {number} qd - the correction's half-width in phase units
 * @param {Float64Array} table - a BLEP table
 * @returns {number} roughly −1 … 1
 *
 * @example // far from the discontinuity it IS the naive saw
 * @example bogBandLimitedSawForPhase(2147483647, 89478, BOG_BLEP_TABLE) === bogSawForPhase(2147483647) // true
 * @example // and at the wrap it is not
 * @example bogBandLimitedSawForPhase(0, 89478, BOG_BLEP_TABLE) !== bogSawForPhase(0) // true
 */
export function bogBandLimitedSawForPhase(phase, qd, table) {
  const p = bogWrapPhase(phase);
  let sample = bogSawForPhase(p);
  const halfTableLen = table.length / 2;
  if (qd > 0) {
    if (p > BOG_CYCLE_PHASE - qd) {
      let i = (BOG_CYCLE_PHASE - p) / qd;
      i = (1 - i) * halfTableLen;
      sample -= table[Math.trunc(i)];
    } else if (p < qd) {
      let i = p / qd;
      i = i * (halfTableLen - 1) + halfTableLen;
      sample -= table[Math.trunc(i)];
    }
  }
  return sample;
}

/**
 * Pure function. `TriangleOscillator::nextForPhase` (`dsp/oscillator.cpp:245`).
 * NOT band-limited — the VCO's triangle relies on oversampling alone, which is
 * defensible because a triangle's harmonics fall at 1/n².
 *
 * @param {number} phase - 0 … cyclePhase
 * @returns {number} −1 … 1
 *
 * @example bogTriangleForPhase(0) // 0
 * @example bogTriangleForPhase(4294967295 * 0.25) // 1
 * @example bogTriangleForPhase(4294967295 * 0.75) // -1
 */
export function bogTriangleForPhase(phase) {
  const p = bogWrapPhase(phase);
  const quarter = Math.trunc(BOG_CYCLE_PHASE * 0.25);
  const threeQuarters = Math.trunc(BOG_CYCLE_PHASE * 0.75);
  const v = (p / BOG_CYCLE_PHASE) * 4;
  if (p < quarter) return v;
  if (p < threeQuarters) return 2 - v;
  return v - 4;
}

/**
 * Pure function. `TablePhasor::nextForPhase` with interpolation ON
 * (`dsp/oscillator.cpp:64`) — the VCO's sine, read from the 4096-entry table
 * with linear interpolation.
 *
 * @param {number} phase - 0 … cyclePhase
 * @param {Float64Array} table
 * @returns {number}
 *
 * @example bogTableForPhase(0, BOG_SINE_TABLE) // 0
 * @example bogTableForPhase(4294967295 * 0.25, BOG_SINE_TABLE) // 1
 */
export function bogTableForPhase(phase, table) {
  const p = bogWrapPhase(phase);
  const length = table.length;
  const fi = (p / BOG_CYCLE_PHASE) * length;
  let i = Math.trunc(fi);
  if (i >= length) i = 0;
  const v1 = table[i];
  const v2 = table[i + 1 === length ? 0 : i + 1];
  return v1 + (fi - i) * (v2 - v1);
}

/**
 * `BandLimitedSquareOscillator` (`dsp/oscillator.cpp:231`) — TWO band-limited
 * saws, one delayed by the pulse width, subtracted. That construction is why the
 * square is anti-aliased at both edges for free, and why its pulse width is
 * LATCHED once per cycle (a mid-cycle change would displace one edge's
 * correction from the edge it corrects).
 *
 * `offset` re-centres the pulse and `dcOffset` removes the DC a non-50% duty
 * introduces — the module's "DC offset correction" menu item. Without it, a
 * narrow pulse pushes a DC step into whatever it feeds.
 *
 * Command (latches per cycle).
 */
export class BogBandLimitedSquare {
  constructor() {
    this.minPulseWidth = BOG_SQUARE_MIN_PULSE_WIDTH;
    this.maxPulseWidth = 1 - BOG_SQUARE_MIN_PULSE_WIDTH;
    this.pulseWidthInput = -1;
    this.dcCorrection = false;
    this.lastCycle = -1;
    this.pulseWidth = 0;
    this.nextPulseWidth = 0;
    this.offset = 0;
    this.nextOffset = 0;
    this.dcOffset = 0;
    this.nextDcOffset = 0;
    this.setPulseWidth(0.5, false);
  }

  /** Command. `setPulseWidth(pw, dcCorrection)` — stores the NEXT cycle's edge. */
  setPulseWidth(pw, dcCorrection) {
    if (this.pulseWidthInput === pw && this.dcCorrection === dcCorrection) return;
    this.pulseWidthInput = pw;
    this.dcCorrection = dcCorrection;
    const w = bogClamp(pw, this.minPulseWidth, this.maxPulseWidth);
    this.nextPulseWidth = BOG_CYCLE_PHASE * w;
    this.nextOffset = w > 0.5 ? 2 * w - 1 : -(1 - 2 * w);
    this.nextDcOffset = dcCorrection ? 1 - 2 * w : 0;
  }

  /** Command. One sample for a given absolute phase and cycle number. */
  forPhase(phase, cycle, qd, table) {
    if (this.lastCycle !== cycle) {
      this.lastCycle = cycle;
      this.pulseWidth = this.nextPulseWidth;
      this.offset = this.nextOffset;
      this.dcOffset = this.nextDcOffset;
    }
    const a = -bogBandLimitedSawForPhase(phase, qd, table);
    const b = bogBandLimitedSawForPhase(phase - this.pulseWidth, qd, table);
    return a + b + this.offset + this.dcOffset;
  }
}

/** `SquareOscillator::minPulseWidth` (`dsp/oscillator.hpp:213`) — 3%, and the
 *  reason the PW knob's own display range is 3…97% rather than 0…100. */
export const BOG_SQUARE_MIN_PULSE_WIDTH = 0.03;

/**
 * `CICDecimator` (`dsp/filters/resample.cpp:49`), in the ONE form JavaScript can
 * carry — D10.
 *
 * ── WHY IT IS NOT A LITERAL TRANSCRIPTION ───────────────────────────────────
 * Theirs is four int64 integrators and four combs, and it is CORRECT ONLY
 * BECAUSE int64 WRAPS: the integrators grow without bound (like n⁴) and the
 * combs cancel the growth. A JS number stops being an exact integer at 2^53,
 * which at 384 kHz oversampled is reached in MILLISECONDS — so a literal
 * transcription would drift and then break.
 *
 * ── THE IDENTITY USED INSTEAD ───────────────────────────────────────────────
 * A CIC of N stages and rate R is exactly `((1 − z^-R)/(1 − z^-1))^N`, i.e. N
 * cascaded length-R boxcars, decimated by R, scaled by `1/R^N`. So the kernel
 * here is that cascade's impulse response — length `N·(R−1)+1 = 29` for N = 4,
 * R = 8 — applied as a dot product. Same transfer function, same group delay,
 * no unbounded state. `tests/port_vc3b_test.js` proves it against a BigInt
 * integrator/comb reference, which is the only honest way to claim "same".
 *
 * What IS dropped: their `buf[i] * scale` truncation to int64 quantises the
 * input at 2^-32 (−192 dBFS). Measured in the test rather than asserted.
 *
 * Command (mutates the delay line).
 */
export class BogCicDecimator {
  constructor(stages = 4, factor = 8) {
    this.stages = stages;
    this.factor = factor;
    this.kernel = bogCicKernel(stages, factor);
    this.history = new Float64Array(this.kernel.length);
    this.gainCorrection = 1 / Math.pow(factor, stages);
  }

  /** Command. One decimated output from `factor` oversampled inputs. */
  next(buffer) {
    const h = this.history;
    const k = this.kernel;
    for (let i = 0; i < this.factor; i++) {
      h.copyWithin(1, 0, h.length - 1);
      h[0] = buffer[i];
    }
    let sum = 0;
    for (let i = 0; i < k.length; i++) sum += k[i] * h[i];
    return this.gainCorrection * sum;
  }
}

/**
 * Pure function. The impulse response of `stages` cascaded length-`factor`
 * boxcars — the CIC's equivalent FIR (D10).
 *
 * @param {number} stages - N
 * @param {number} factor - R
 * @returns {Float64Array} length N·(R−1)+1, summing to R^N
 *
 * @example bogCicKernel(1, 4) // Float64Array [1, 1, 1, 1]
 * @example bogCicKernel(2, 2) // Float64Array [1, 2, 1]
 * @example bogCicKernel(4, 8).length // 29
 * @example bogCicKernel(4, 8).reduce((a, b) => a + b, 0) // 4096
 */
export function bogCicKernel(stages, factor) {
  let h = new Float64Array(1);
  h[0] = 1;
  for (let s = 0; s < stages; s++) {
    const next = new Float64Array(h.length + factor - 1);
    for (let i = 0; i < h.length; i++) for (let j = 0; j < factor; j++) next[i + j] += h[i];
    h = next;
  }
  return h;
}

// ═══════════════════════════════════════════════════════════════════════════
// THE TWELVE MODULE KERNELS
// ═══════════════════════════════════════════════════════════════════════════
//
// EVERY KERNEL BELOW PRESENTS THE SAME TWO-METHOD SHAPE, and the split IS D1:
//
//   control(knobs, signals, wired)   once every `bogModulateSteps(fs)` samples
//                                    — Bogaudio's `modulate()` / `modulateChannel()`
//   sample(knobs, signals, frame)    once per sample — their `processChannel()`
//
// `knobs` is the AudioParam values by name; `signals` is the CURRENT SAMPLE of
// every audio input, IN VOLTS (D0); `wired` answers `isConnected()` per input
// (D3); `frame` is written with one VOLTAGE per output, in output-index order.
// The processor owns the ±1 ⇄ volts conversion and nothing here knows about it.
//
// Every kernel is a COMMAND (it advances filter and envelope state) and none
// allocates after construction.

/** PEQ's own limits (`parametric_eq.cpp:5-10`). `maxDecibels` is +6, not the
 *  amplifier's +20: a parametric band that could add 20 dB would be a distortion
 *  pedal. `minDecibels` IS the amplifier's floor, so a band can reach silence. */
export const BOG_PEQ_MAX_DB = 6;
export const BOG_PEQ_MIN_DB = BOG_AMP_MIN_DB;
export const BOG_PEQ_MAX_FREQUENCY = 20000;
export const BOG_PEQ_MIN_FREQUENCY = BOG_MULTIMODE_MIN_FREQUENCY;

/** `PEQChannel::setFilterMode` (`parametric_eq.cpp:20`) — a BANDPASS band is 4
 *  poles and a shelving (LP/HP) band is TWELVE. That 3× is the whole reason the
 *  end bands sound like shelves rather than like wide bands. */
const BOG_PEQ_BANDPASS_POLES = 4;
const BOG_PEQ_SHELF_POLES = 12;

/** How many bands the collapsed family supports. TWO is the floor because
 *  `PEQEngine::next` reads `_channels[1]->bandwidth` and the first and last band
 *  take different modes; FOURTEEN is `PEQ14`, the widest they ship. */
export const BOG_PEQ_MIN_BANDS = 2;
export const BOG_PEQ_MAX_BANDS = 14;

/** Their `_levelSL` / `_frequencySL` slew times (`parametric_eq.cpp:14-16`). The
 *  frequency one runs in the SEMITONE domain, which is what makes a swept band
 *  move at a musically even rate instead of crawling low and racing high. */
const BOG_PEQ_LEVEL_SLEW_MS = 0.05;
const BOG_PEQ_FREQUENCY_SLEW_MS = 0.5;

/** `PEQChannel::modulate`'s non-full frequency-CV span, in semitones. */
const BOG_PEQ_OCTAVE_SEMITONES = 12;

/**
 * `Bogaudio-PEQ` — THE PARAMETRIC EQ FAMILY, COLLAPSED TO ONE NODE.
 *
 * ── SOURCE ──────────────────────────────────────────────────────────────────
 *   plumbing   `src/PEQ6.cpp` (the 6-band shape, which is the canonical one) and
 *              `src/PEQ.hpp` / `src/PEQ14.hpp` for the 3- and 14-band widths
 *   engine     `src/parametric_eq.cpp` — `PEQChannel::modulate` / `::next`,
 *              `PEQEngine::next`
 *   recurrence `src/dsp/filters/multimode.cpp` — see BogMultimodeFilter
 *   commit     656eaae458e045602dc974bae82e15a11e104958
 *
 * ── WHAT IT IS: A BANK, NOT AN EQ CURVE ─────────────────────────────────────
 * N Butterworth bands in PARALLEL, each with its own level, summed and softly
 * saturated. The first band may be a 12-pole LOWPASS and the last a 12-pole
 * HIGHPASS (shelves); everything between is a 4-pole BANDPASS whose width is one
 * shared Bandwidth control in OCTAVES. That parallel-sum topology is why it is a
 * formant shaper rather than a tone control: pull five bands to silence and you
 * hear only the sixth, which is exactly what P12 does with it.
 *
 * ── THE COLLAPSE: `bands` IS A PARAMETER, NOT A FORK ────────────────────────
 * Bogaudio ships PEQ (3), PEQ6, PEQ14, PEQ14XF and EQS as five modules over ONE
 * engine. Here `bands` is a construct knob, 2…14, and the engine is that one
 * engine. The per-width DEFAULTS could not be collapsed with it — a knob's
 * default is one static number — so the frequency knobs default to PEQ14's
 * geometric spread and a 3- or 6-band patch states its own. Both lists are in
 * `core/audio_specs_vc3b.js`'s PEQ help so nobody has to re-derive them.
 *
 * ── THE RECURRENCE, IN FLOAT, PER BAND ──────────────────────────────────────
 *   level   dB ← slew(knobDb · cvAtten01, 0.05 ms over 66 dB)
 *   f       Hz ← semitoneToFrequency(slew(frequencyToSemitone(knobHz) + fcv))
 *           fcv = clamp(globalCv/5, −1, 1) · atten · (12 or the full span)
 *   bw      0…1, BANDPASS BANDS ONLY (a shelf is always minQbw)
 *   out     ← amplifierLevel(dB) · multimode(BUTTERWORTH, poles, mode, f, bw)
 *   mix     ← saturate(Σ out)
 *
 * ── DEVIATIONS ──────────────────────────────────────────────────────────────
 * D7. THE PER-BAND FREQUENCY-CV ATTENUVERTERS AND INLETS ARE DROPPED. Fourteen
 *     bands × (a CV inlet + an attenuverter knob) is 28 more controls on a card
 *     that already carries 31, and in PEQ6/PEQ14 those attenuverters DEFAULT TO
 *     1.0 with the inlets unwired — which is what both patches that need this
 *     node use. So the global frequency CV survives (with its own attenuverter,
 *     default 0 as theirs is) and the per-band ones do not. WHAT IS LOST: a
 *     patch that sweeps ONE band's centre, which P17's vocoder does on band 8.
 * D8. THE PER-BAND RMS LEDs ARE NOT PORTED. `PEQChannel::next` runs a
 *     `RootMeanSquare` per band purely to light a panel LED; we have no per-band
 *     light, and 14 running averages for a lamp is real CPU. Nothing audible
 *     depends on it — `out` never reads `rms`.
 * D9. THE 3-BAND WIDTH'S PER-BAND BANDWIDTH IS DROPPED. `PEQ` (3-band) gives
 *     each band its own bandwidth knob; `PEQ6`/`PEQ14` share one. The shared one
 *     is ported, because it is the shape the two patches use and because a
 *     per-band bandwidth would be 14 more knobs for D7's reason.
 * D-BE. `band_exclude` IS NOT PORTED. Their context-menu option drops a band
 *     from the mix WHEN THAT BAND'S OWN OUTPUT IS CONNECTED — a decision that
 *     needs to see output connectedness, which an AudioWorklet cannot. The band
 *     outputs are all present and always live.
 * D-DEADSLEW. `PEQChannel` builds a `_bandwidthSL` and never calls it. Their
 *     dead code; not resurrected, because adding a slew they do not run would
 *     make a bandwidth sweep smoother than the module really is.
 *
 * Command. Holds N filters, N slew limiters and N amplifier levels.
 */
export class PeqKernel {
  constructor(sampleRate, options = {}) {
    this.sampleRate = sampleRate;
    this.bands = Math.trunc(bogClamp(options.bands ?? 6, BOG_PEQ_MIN_BANDS, BOG_PEQ_MAX_BANDS));
    this.lowMode = BOG_MULTIMODE.LOWPASS;
    this.highMode = BOG_MULTIMODE.HIGHPASS;
    this.fullFrequencyMode = false;
    this.minSemitone = bogFrequencyToSemitone(BOG_PEQ_MIN_FREQUENCY);
    this.maxSemitone = bogFrequencyToSemitone(BOG_PEQ_MAX_FREQUENCY);
    // `_frequencySL`'s range argument is `frequencyToSemitone(maxF − minF)`, NOT
    // the span between the two semitones — theirs, and it is a different number
    // (135.2 rather than 75.2). Reproduced: it sets the slew RATE.
    const semitoneRange = bogFrequencyToSemitone(BOG_PEQ_MAX_FREQUENCY - BOG_PEQ_MIN_FREQUENCY);
    this.channels = [];
    for (let i = 0; i < this.bands; i++) {
      const isEnd = i === 0 || i === this.bands - 1;
      this.channels.push({
        // An end band may be a 12-pole shelf — 6 biquads — so it gets their
        // `MultimodeFilter8`; a middle band is always a 4-pole bandpass.
        filter: new BogMultimodeFilter(isEnd ? 8 : 4),
        levelSL: new BogSlewLimiter(sampleRate, BOG_PEQ_LEVEL_SLEW_MS, BOG_PEQ_MAX_DB - BOG_PEQ_MIN_DB),
        frequencySL: new BogSlewLimiter(sampleRate, BOG_PEQ_FREQUENCY_SLEW_MS, semitoneRange),
        level: 0,
        mode: BOG_MULTIMODE.BANDPASS,
        poles: BOG_PEQ_BANDPASS_POLES,
      });
    }
  }

  /** Command. The first band's LP/BP choice. */
  setLowMode(mode) {
    if (mode !== BOG_MULTIMODE.LOWPASS && mode !== BOG_MULTIMODE.BANDPASS) {
      throw new Error(`PeqKernel.setLowMode: ${JSON.stringify(mode)} is not lowpass or bandpass`);
    }
    this.lowMode = mode;
  }

  /** Command. The last band's HP/BP choice. */
  setHighMode(mode) {
    if (mode !== BOG_MULTIMODE.HIGHPASS && mode !== BOG_MULTIMODE.BANDPASS) {
      throw new Error(`PeqKernel.setHighMode: ${JSON.stringify(mode)} is not highpass or bandpass`);
    }
    this.highMode = mode;
  }

  /** Command. `FMOD_PARAM` — whether the frequency CV spans one octave or the
   *  filter's whole range. */
  setFmodRange(range) {
    if (range !== "octave" && range !== "full") {
      throw new Error(`PeqKernel.setFmodRange: ${JSON.stringify(range)} is not octave or full`);
    }
    this.fullFrequencyMode = range === "full";
  }

  /** Command. `PEQ6::modulate` + `PEQChannel::modulate`. */
  control(knobs, signals, wired) {
    for (let i = 0; i < this.bands; i++) {
      const c = this.channels[i];
      c.mode = i === 0 ? this.lowMode : i === this.bands - 1 ? this.highMode : BOG_MULTIMODE.BANDPASS;
      c.poles = c.mode === BOG_MULTIMODE.BANDPASS ? BOG_PEQ_BANDPASS_POLES : BOG_PEQ_SHELF_POLES;

      // LEVEL. The knob is in dB (D13); their arithmetic is on the 0…1 position,
      // so it is converted back before the CV multiply and forward after.
      let level01 = bogClamp((knobs[`level${i + 1}`] - BOG_PEQ_MIN_DB) / (BOG_PEQ_MAX_DB - BOG_PEQ_MIN_DB), 0, 1);
      if (wired[`level${i + 1}_cv`]) level01 *= bogClamp(signals[`level${i + 1}_cv`] / 10, 0, 1);
      const levelDb = level01 * (BOG_PEQ_MAX_DB - BOG_PEQ_MIN_DB) + BOG_PEQ_MIN_DB;
      c.level = bogAmplifierLevel(c.levelSL.next(levelDb));

      // FREQUENCY. D7: one global CV, through the global attenuverter.
      let fcv = 0;
      if (wired.frequency_cv) fcv += bogClamp(signals.frequency_cv / 5, -1, 1) * knobs.frequencyCvAtten;
      fcv *= this.fullFrequencyMode ? this.maxSemitone - this.minSemitone : BOG_PEQ_OCTAVE_SEMITONES;
      let frequency = bogClamp(knobs[`frequency${i + 1}`], BOG_PEQ_MIN_FREQUENCY, BOG_PEQ_MAX_FREQUENCY);
      frequency = bogClamp(bogFrequencyToSemitone(frequency) + fcv, this.minSemitone, this.maxSemitone);
      frequency = bogSemitoneToFrequency(c.frequencySL.next(frequency));

      // BANDWIDTH. A shelf band has none — their `minQbw`, not the knob.
      let bandwidth = BOG_MULTIMODE_MIN_QBW;
      if (c.mode === BOG_MULTIMODE.BANDPASS) {
        bandwidth = bogClamp(knobs.bandwidth, 0, 1);
        if (wired.bandwidth_cv) bandwidth *= bogClamp(signals.bandwidth_cv / 10, 0, 1);
        bandwidth = BOG_MULTIMODE_MIN_QBW + bandwidth * (BOG_MULTIMODE_MAX_QBW - BOG_MULTIMODE_MIN_QBW);
      }
      c.filter.setParams(this.sampleRate, BOG_MULTIMODE.BUTTERWORTH, c.poles, c.mode, frequency, bandwidth, BOG_MULTIMODE.PITCH_BANDWIDTH);
    }
  }

  /** Command. `PEQEngine::next` — frame[0] is the mix, frame[1+i] is band i. */
  sample(knobs, signals, wired, frame) {
    const input = signals.in;
    let mix = 0;
    for (let i = 0; i < BOG_PEQ_MAX_BANDS; i++) {
      if (i >= this.bands) {
        frame[1 + i] = 0;
        continue;
      }
      const c = this.channels[i];
      const out = c.level * c.filter.next(input);
      frame[1 + i] = out;
      mix += out;
    }
    frame[0] = bogSaturate(mix);
  }
}

/** `VCOBase`'s own constants (`vco_base.hpp:52-54`, `Engine::oversample`). The
 *  amplitude is 5 V — a Bogaudio oscillator is ±5 V, i.e. FULL SCALE on our
 *  wires (D0) — and `slowModeOffset` is −7 octaves, which puts the Slow-mode
 *  range at roughly 0.02…50 Hz. */
const BOG_VCO_AMPLITUDE_V = 5;
const BOG_VCO_SLOW_OFFSET_OCTAVES = -7;
const BOG_VCO_OVERSAMPLE = 8;

/** `Engine()`'s `setQuality(12)` — the BLEP correction spans up to 12 samples. */
const BOG_VCO_BLEP_QUALITY = 12;

/** `VCOBase::sampleRateChange`: oversampling fades in over 100 Hz starting at
 *  6% of the sample rate (2880 Hz at 48 k). Below that the naive path is already
 *  clean enough and 8× cheaper; the CROSSFADE is what keeps the switch inaudible. */
const BOG_VCO_OVERSAMPLE_THRESHOLD_RATIO = 0.06;
const BOG_VCO_OVERSAMPLE_WIDTH_HZ = 100;

/** `Engine::setFrequency`'s guard — a frequency at or above 47.5% of the sample
 *  rate is REFUSED (the previous one is kept), which is their anti-aliasing
 *  backstop and is why a through-zero FM sweep does not scream. */
const BOG_VCO_MAX_FREQUENCY_RATIO = 0.475;

/** `VCOBase::modulateChannel` clamps its pitch inlet to ±5 V, i.e. ±60 semitones
 *  under R7-UNITS clause 3 — five octaves either way, which is the whole V/oct range. */
const BOG_VCO_PITCH_CLAMP_SEMITONES = 5 * BOG_SEMITONES_PER_VOLT;

/** `VCOBase::processChannel`'s FM gate: FM is skipped entirely below this depth,
 *  so a depth knob at zero costs nothing AND a hair of depth is snapped to none. */
const BOG_VCO_FM_DEPTH_FLOOR = 0.01;

/** `linearModeVoltsToHertz` — 1 V is 1000 Hz in linear mode, or 1 Hz in slow. */
const BOG_VCO_LINEAR_HZ_PER_VOLT = 1000;

/**
 * `Bogaudio-VCO` — the anti-aliased analogue-modelled oscillator.
 *
 * ── SOURCE ──────────────────────────────────────────────────────────────────
 *   plumbing   `src/VCO.cpp` + `src/vco_base.cpp` (`VCOBase::processChannel`)
 *   recurrence `src/dsp/oscillator.cpp` (`Phasor`, `BandLimitedSawOscillator`,
 *              `BandLimitedSquareOscillator`, `TriangleOscillator`,
 *              `TablePhasor`), `src/dsp/filters/resample.cpp` (`CICDecimator`),
 *              `src/dsp/table.cpp` (the BLEP table)
 *   commit     656eaae458e045602dc974bae82e15a11e104958
 *
 * ── FOUR WAVEFORMS FROM ONE PHASE, AND WHY THAT MATTERS ─────────────────────
 * Square, saw, triangle and sine all read the SAME phase accumulator, so they
 * are phase-locked forever and can be mixed without beating. The square is two
 * BLEP saws subtracted (see BogBandLimitedSquare); the triangle and sine are
 * naive and rely on the oversampling alone.
 *
 * ── THE ANTI-ALIASING IS TWO MECHANISMS, NOT ONE ────────────────────────────
 * 1. A BLEP correction at each discontinuity (the saw and the square).
 * 2. 8× OVERSAMPLING with a 4-stage CIC decimator, faded in above 2.88 kHz.
 * Both, because the BLEP alone leaves the triangle and the square's own
 * pulse-width edge aliasing. A port with only one of them sounds fine on a bass
 * note and grainy two octaves up — which is precisely the failure a listener
 * blames on "digital".
 *
 * ── THE RECURRENCE, IN FLOAT ────────────────────────────────────────────────
 *   baseVOct ← frequencyKnob + fine/12 + clamp(pitchIn, −5, 5)   [+ slowOffset]
 *   baseHz   ← FREQ_C4 · 2^baseVOct                (or volts·1000 in linear mode)
 *   fm       ← fmIn · fmDepth, applied as EITHER a phase offset of 2·fm radians
 *              (linear FM, through-zero) OR an octave shift of the pitch
 *   φ        ← φ + delta, delta = trunc((baseHz/8/fs) · (2^32 − 1))
 *   out      ← 5 V · (oMix·decimate(8 oversamples) + mix·wave(φ))
 *
 * ── DEVIATIONS ──────────────────────────────────────────────────────────────
 * D10 (the CIC decimator's arithmetic form) and D11 (the phase wrap) apply here;
 * both are stated on the classes that carry them.
 * D-ACTIVE. THEY SKIP UNCONNECTED OUTPUTS; we compute all four. Their
 *     `squareActive`/`sawActive`/… flags read output connectedness, which an
 *     AudioWorklet cannot see. It is a CPU difference and nothing else: an
 *     unread waveform's state does not feed any other waveform.
 * D-POLY. `poly_input` (which inlet sets the channel count) is meaningless at
 *     one channel — D6.
 *
 * Command. Holds a phase accumulator, three decimators and a pulse-width latch.
 */
export class VcoKernel {
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    this.phase = 0;
    // The CYCLE COUNTER, tracked beside the phase because their `_lastCycle`
    // latch reads `phase / cyclePhase` off an unbounded accumulator (D11) and
    // ours is wrapped. Same latch, no unbounded number.
    this.cycle = 0;
    this.delta = 0;
    this.frequency = Infinity;
    this.qd = 0;
    this.baseVOct = 0;
    this.baseHz = 0;
    this.slowMode = false;
    this.linearMode = false;
    this.fmLinearMode = true;
    this.dcCorrection = true;
    this.square = new BogBandLimitedSquare();
    this.syncTrigger = new BogPositiveZeroCrossing();
    this.squarePulseWidthSL = new BogSlewLimiter(sampleRate, 0.1, 2);
    this.squareDecimator = new BogCicDecimator(4, BOG_VCO_OVERSAMPLE);
    this.sawDecimator = new BogCicDecimator(4, BOG_VCO_OVERSAMPLE);
    this.triangleDecimator = new BogCicDecimator(4, BOG_VCO_OVERSAMPLE);
    this.squareBuffer = new Float64Array(BOG_VCO_OVERSAMPLE);
    this.sawBuffer = new Float64Array(BOG_VCO_OVERSAMPLE);
    this.triangleBuffer = new Float64Array(BOG_VCO_OVERSAMPLE);
    this.oversampleThreshold = BOG_VCO_OVERSAMPLE_THRESHOLD_RATIO * sampleRate;
  }

  /** Command. Slow mode — the frequency knob drops seven octaves. */
  setSlow(value) {
    this.slowMode = vc3bOnOff(value, "VcoKernel.setSlow");
  }

  /** Command. `LINEAR_PARAM` — is the frequency knob volts-per-octave or hertz? */
  setTuning(value) {
    if (value !== "voct" && value !== "hertz") {
      throw new Error(`VcoKernel.setTuning: ${JSON.stringify(value)} is not voct or hertz`);
    }
    this.linearMode = value === "hertz";
  }

  /** Command. `FM_TYPE_PARAM` — through-zero phase FM, or exponential. */
  setFmMode(value) {
    if (value !== "linear" && value !== "exponential") {
      throw new Error(`VcoKernel.setFmMode: ${JSON.stringify(value)} is not linear or exponential`);
    }
    this.fmLinearMode = value === "linear";
  }

  /** Command. The square's DC-offset correction. */
  setDcCorrection(value) {
    this.dcCorrection = vc3bOnOff(value, "VcoKernel.setDcCorrection");
  }

  /** Command. `Engine::setFrequency` — including its Nyquist refusal. */
  #setFrequency(f) {
    if (this.frequency === f || f >= BOG_VCO_MAX_FREQUENCY_RATIO * this.sampleRate) return;
    this.frequency = f;
    this.delta = bogPhaseDelta(f / BOG_VCO_OVERSAMPLE, this.sampleRate);
    // THE BLEP WIDTH IS COMPUTED AT THE FULL FREQUENCY, not the oversampled
    // one: `square.setFrequency(frequency)` while the phasor gets frequency/8.
    // Their `_qd = min(quality, 0.5·fs/f) · delta_at_f`.
    const q = Math.min(BOG_VCO_BLEP_QUALITY, Math.trunc(0.5 * (this.sampleRate / Math.max(f, 1e-9))));
    this.qd = q * bogPhaseDelta(f, this.sampleRate);
  }

  /** Command. Advance the phase by n increments, keeping the cycle count. */
  #advance(n) {
    const next = this.phase + n * this.delta;
    this.cycle += Math.floor(next / BOG_CYCLE_PHASE);
    this.phase = bogWrapPhase(next);
  }

  /** Command. `VCO::modulate` + `VCOBase::modulateChannel` + `VCO::modulateChannel`. */
  control(knobs, signals, wired) {
    // R7-UNITS clause 3: the knob, the fine trim and the inlet are all SEMITONES,
    // so they sum in the pitch domain exactly as Rack's volts do — one division
    // by 12 at the end is the whole of the conversion.
    this.baseVOct = (knobs.frequency + knobs.fine) / BOG_SEMITONES_PER_VOLT;
    if (wired.pitch) {
      // Their clamp is ±5 V, which is ±60 semitones.
      this.baseVOct += bogClamp(signals.pitch, -BOG_VCO_PITCH_CLAMP_SEMITONES, BOG_VCO_PITCH_CLAMP_SEMITONES) / BOG_SEMITONES_PER_VOLT;
    }
    if (this.linearMode) {
      this.baseHz = this.#linearHz(this.baseVOct);
    } else {
      if (this.slowMode) this.baseVOct += BOG_VCO_SLOW_OFFSET_OCTAVES;
      this.baseHz = bogCvToFrequency(this.baseVOct);
    }
    let pw = knobs.pw;
    if (wired.pw_cv) pw *= bogClamp(signals.pw_cv / 5, -1, 1);
    pw *= 1 - 2 * BOG_SQUARE_MIN_PULSE_WIDTH;
    pw *= 0.5;
    pw += 0.5;
    this.square.setPulseWidth(this.squarePulseWidthSL.next(pw), this.dcCorrection);
  }

  /** Query. `linearModeVoltsToHertz`. */
  #linearHz(v) {
    return this.slowMode ? v : BOG_VCO_LINEAR_HZ_PER_VOLT * v;
  }

  /** Command. `VCOBase::processChannel` — frame is [square, saw, triangle, sine]. */
  sample(knobs, signals, wired, frame) {
    if (this.syncTrigger.next(signals.sync)) {
      this.phase = 0;
      this.cycle = 0;
    }
    let frequency = this.baseHz;
    let phaseOffset = 0;
    if (wired.fm && knobs.fmDepth > BOG_VCO_FM_DEPTH_FLOOR) {
      const fm = signals.fm * knobs.fmDepth;
      if (this.fmLinearMode) phaseOffset = (2 * fm / (2 * Math.PI)) * BOG_CYCLE_PHASE;
      else if (this.linearMode) frequency += this.#linearHz(fm);
      else frequency = bogCvToFrequency(this.baseVOct + fm);
    }
    this.#setFrequency(frequency);

    let mix;
    let oMix;
    if (frequency > this.oversampleThreshold) {
      if (frequency > this.oversampleThreshold + BOG_VCO_OVERSAMPLE_WIDTH_HZ) {
        mix = 0;
        oMix = 1;
      } else {
        oMix = (frequency - this.oversampleThreshold) / BOG_VCO_OVERSAMPLE_WIDTH_HZ;
        mix = 1 - oMix;
      }
    } else {
      mix = 1;
      oMix = 0;
    }

    let square = 0;
    let saw = 0;
    let triangle = 0;
    if (oMix > 0) {
      for (let i = 0; i < BOG_VCO_OVERSAMPLE; i++) {
        this.#advance(1);
        const p = this.phase + phaseOffset;
        this.squareBuffer[i] = this.square.forPhase(p, this.cycle, this.qd, BOG_BLEP_TABLE);
        this.sawBuffer[i] = bogBandLimitedSawForPhase(p, this.qd, BOG_BLEP_TABLE);
        this.triangleBuffer[i] = bogTriangleForPhase(p);
      }
      square += oMix * BOG_VCO_AMPLITUDE_V * this.squareDecimator.next(this.squareBuffer);
      saw += oMix * BOG_VCO_AMPLITUDE_V * this.sawDecimator.next(this.sawBuffer);
      triangle += oMix * BOG_VCO_AMPLITUDE_V * this.triangleDecimator.next(this.triangleBuffer);
    } else {
      this.#advance(BOG_VCO_OVERSAMPLE);
    }
    if (mix > 0) {
      const p = this.phase + phaseOffset;
      square += mix * BOG_VCO_AMPLITUDE_V * this.square.forPhase(p, this.cycle, this.qd, BOG_BLEP_TABLE);
      saw += mix * BOG_VCO_AMPLITUDE_V * bogBandLimitedSawForPhase(p, this.qd, BOG_BLEP_TABLE);
      triangle += mix * BOG_VCO_AMPLITUDE_V * bogTriangleForPhase(p);
    }
    frame[0] = square;
    frame[1] = saw;
    frame[2] = triangle;
    frame[3] = BOG_VCO_AMPLITUDE_V * bogTableForPhase(this.phase + phaseOffset, BOG_SINE_TABLE);
  }
}

/** `VCF::Engine`'s parallel filter count (`VCF.hpp:41`) — TWELVE filters, one per
 *  pole count from 1 to 12, all running, crossfaded by the Slope knob. That is
 *  what makes Slope continuous instead of a four-position switch. */
const BOG_VCF_FILTERS = 12;

/** `VCF::Engine::sampleRateChange` — the fixed 2-pole 80 Hz highpass every mode
 *  ends in, and the 50 ms slew on each parallel filter's gain. The final HP is
 *  not cosmetic: a 12-pole bandreject at 40 Hz would otherwise pass a DC step. */
const BOG_VCF_FINAL_HP_HZ = 80;
const BOG_VCF_GAIN_SLEW_MS = 50;
const BOG_VCF_FREQUENCY_SLEW_MS = 0.5;
const BOG_VCF_MAX_FREQUENCY = 20000;

/** Their pitch inlet's ±5 V clamp, in semitones (R7-UNITS clause 3). */
const BOG_VCF_PITCH_CLAMP_SEMITONES = 5 * BOG_SEMITONES_PER_VOLT;

/**
 * `Bogaudio-VCF` — the multimode filter, with a CONTINUOUS slope.
 *
 * ── SOURCE ──────────────────────────────────────────────────────────────────
 *   plumbing   `src/VCF.cpp` (`VCF::modulateChannel`, `VCF::Engine::setParams`)
 *   recurrence `src/dsp/filters/multimode.cpp` — see BogMultimodeFilter
 *   commit     656eaae458e045602dc974bae82e15a11e104958
 *
 * ── WHAT MAKES IT UNUSUAL: TWELVE FILTERS IN PARALLEL ───────────────────────
 * Slope is not a switch between 1-pole and 4-pole. Twelve independent filters
 * exist — 1 pole through 12 — and the knob CROSSFADES between the two nearest,
 * with a 50 ms slew on each gain so a slope sweep is a smooth change of skirt
 * steepness. Nothing else in this library does that, and it is expensive on
 * purpose: it is why the module can sit anywhere between a gentle tilt and a
 * 72 dB/octave brick wall.
 *
 * ── THE RECURRENCE, IN FLOAT ────────────────────────────────────────────────
 *   slope  ← (knob · cvAtten01)² ; i = ⌊slope·11⌋, gains i and i+1 split by frac
 *   f01    ← sqrt(knobHz/20000) + clamp(fcv/5, ±1)·atten     (the CV is on the
 *            SQUARE-ROOT scale — theirs, and it is what makes a CV sweep sound
 *            even rather than crawling at the bottom)
 *   f      ← f01² · 20000 ; + FREQ_C4·2^pitch ; then FM as an octave shift
 *   f      ← semitoneToFrequency(slew(frequencyToSemitone(f), 0.5 ms))
 *   out    ← finalHP( Σ_i slew(gain_i) · multimode(BUTTERWORTH, i+1, mode, f, q) )
 *
 * ── DEVIATIONS ──────────────────────────────────────────────────────────────
 * D-MINDELAY. `MINIMUM_DELAY_MODE` on the final highpass is a NO-OP in the
 *     scalar C++ too — it only picks an output index in their SIMD `Biquad4`.
 *     Ours matches the scalar path, which is the one whose arithmetic is stated.
 * D13 (the frequency knob is in hertz) applies; the conversion back to their
 *     0…1 position is explicit below so the CV lands on the same scale.
 *
 * Command. Holds twelve filters, twelve gain slews and a frequency slew.
 */
export class VcfKernel {
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    this.filters = [];
    this.gains = new Float64Array(BOG_VCF_FILTERS);
    this.gainSLs = [];
    for (let i = 0; i < BOG_VCF_FILTERS; i++) {
      // `MultimodeFilter16` — a 12-pole BANDPASS is 12 biquads, so 16 is the
      // capacity every one of them needs.
      this.filters.push(new BogMultimodeFilter(16));
      this.gainSLs.push(new BogSlewLimiter(sampleRate, BOG_VCF_GAIN_SLEW_MS, 1));
    }
    this.frequencySL = new BogSlewLimiter(sampleRate, BOG_VCF_FREQUENCY_SLEW_MS, bogFrequencyToSemitone(BOG_VCF_MAX_FREQUENCY - BOG_MULTIMODE_MIN_FREQUENCY));
    this.finalHP = new BogMultimodeFilter(4);
    this.finalHP.setParams(sampleRate, BOG_MULTIMODE.BUTTERWORTH, 2, BOG_MULTIMODE.HIGHPASS, BOG_VCF_FINAL_HP_HZ, BOG_MULTIMODE_MIN_QBW, BOG_MULTIMODE.LINEAR_BANDWIDTH);
    this.mode = BOG_MULTIMODE.LOWPASS;
    this.bandwidthMode = BOG_MULTIMODE.PITCH_BANDWIDTH;
  }

  /** Command. `MODE_PARAM` — and it RESETS every filter, as theirs does: a mode
   *  change re-poles the cascade, so a stale tail would ring in the wrong mode. */
  setMode(mode) {
    const allowed = [BOG_MULTIMODE.LOWPASS, BOG_MULTIMODE.HIGHPASS, BOG_MULTIMODE.BANDPASS, BOG_MULTIMODE.BANDREJECT];
    if (!allowed.includes(mode)) throw new Error(`VcfKernel.setMode: unknown mode ${JSON.stringify(mode)}`);
    if (this.mode === mode) return;
    this.mode = mode;
    for (const f of this.filters) f.reset();
  }

  /** Command. `bandwidthMode` — octaves (pitched) or hertz (linear). */
  setBandwidthMode(value) {
    if (value !== BOG_MULTIMODE.PITCH_BANDWIDTH && value !== BOG_MULTIMODE.LINEAR_BANDWIDTH) {
      throw new Error(`VcfKernel.setBandwidthMode: ${JSON.stringify(value)} is not pitched or linear`);
    }
    this.bandwidthMode = value;
  }

  /** Command. `VCF::modulateChannel` + `VCF::Engine::setParams`. */
  control(knobs, signals, wired) {
    let slope = bogClamp(knobs.slope, 0, 1);
    if (wired.slope_cv) slope *= bogClamp(signals.slope_cv / 10, 0, 1);
    slope *= slope;

    let q = bogClamp(knobs.q, 0, 1);
    if (wired.q_cv) q *= bogClamp(signals.q_cv / 10, 0, 1);

    // D13: the knob is hertz, their arithmetic is the square-root position.
    let f = bogClamp(Math.sqrt(bogClamp(knobs.frequency, 0, BOG_VCF_MAX_FREQUENCY) / BOG_VCF_MAX_FREQUENCY), 0, 1);
    if (wired.frequency_cv) {
      const fcv = bogClamp(signals.frequency_cv / 5, -1, 1) * bogClamp(knobs.frequencyCvAtten, -1, 1);
      f = Math.max(0, f + fcv);
    }
    f *= f;
    f *= BOG_VCF_MAX_FREQUENCY;
    // R7-UNITS clause 3: the inlet is SEMITONES; their clamp is ±5 V = ±60 of them.
    if (wired.pitch) f += bogSemitonesToHz(bogClamp(signals.pitch, -BOG_VCF_PITCH_CLAMP_SEMITONES, BOG_VCF_PITCH_CLAMP_SEMITONES));
    if (wired.fm) {
      const fm = signals.fm * bogClamp(knobs.fmDepth, 0, 1);
      f = bogCvToFrequency(bogFrequencyToCv(Math.max(BOG_MULTIMODE_MIN_FREQUENCY, f)) + fm);
    }
    f = bogClamp(f, BOG_MULTIMODE_MIN_FREQUENCY, BOG_VCF_MAX_FREQUENCY);
    f = bogClamp(bogSemitoneToFrequency(this.frequencySL.next(bogFrequencyToSemitone(f))), BOG_MULTIMODE_MIN_FREQUENCY, BOG_VCF_MAX_FREQUENCY);

    this.gains.fill(0);
    let i = -1;
    let j = -1;
    if (slope >= 1) {
      i = BOG_VCF_FILTERS - 1;
      this.gains[i] = 1;
    } else {
      const s = slope * (BOG_VCF_FILTERS - 1);
      const r = s % 1;
      i = Math.trunc(s);
      j = i + 1;
      this.gains[i] = 1 - r;
      this.gains[j] = r;
    }
    this.filters[i].setParams(this.sampleRate, BOG_MULTIMODE.BUTTERWORTH, i + 1, this.mode, f, q, this.bandwidthMode);
    if (j >= 0) this.filters[j].setParams(this.sampleRate, BOG_MULTIMODE.BUTTERWORTH, j + 1, this.mode, f, q, this.bandwidthMode);
  }

  /** Command. `VCF::Engine::next`. */
  sample(knobs, signals, wired, frame) {
    let out = 0;
    for (let i = 0; i < BOG_VCF_FILTERS; i++) {
      const g = this.gainSLs[i].next(this.gains[i]);
      if (g > 0) out += g * this.filters[i].next(signals.in);
    }
    frame[0] = this.finalHP.next(out);
  }
}

/** `SampleHold::maxSmoothMS` (`SampleHold.hpp:47`) and the range its output slew
 *  spans — 10 V, so a "glide" of 1000 ms takes a full second to cross ±5 V. */
export const BOG_SH_MAX_SMOOTH_MS = 10000;
const BOG_SH_SLEW_RANGE_V = 10;

/**
 * `SampleHold::contextMenu`'s eight ranges (`SampleHold.cpp:301-310`), as
 * `{offset, scale}` — the pair `(noise + offset) · scale` needs. An offset of 1
 * makes the range UNIPOLAR, which is what a pitch CV wants.
 */
export const BOG_SH_RANGES = Object.freeze({
  "+/-10V": Object.freeze({ offset: 0, scale: 10 }),
  "+/-5V": Object.freeze({ offset: 0, scale: 5 }),
  "+/-3V": Object.freeze({ offset: 0, scale: 3 }),
  "+/-1V": Object.freeze({ offset: 0, scale: 1 }),
  "0V-10V": Object.freeze({ offset: 1, scale: 5 }),
  "0V-5V": Object.freeze({ offset: 1, scale: 2.5 }),
  "0V-3V": Object.freeze({ offset: 1, scale: 1.5 }),
  "0V-1V": Object.freeze({ offset: 1, scale: 0.5 }),
});

/**
 * `Bogaudio-SampleHold` — TWO sample-and-holds with a built-in noise source.
 *
 * ── SOURCE ──────────────────────────────────────────────────────────────────
 *   plumbing   `src/SampleHold.cpp` (`processSection`, `noise`)
 *   recurrence `src/dsp/noise.hpp` (white / pink / red / blue), `dsp/signal.cpp`
 *              (`SlewLimiter`), `rack_overrides.cpp` (`Trigger`)
 *   commit     656eaae458e045602dc974bae82e15a11e104958
 *
 * ── THE THREE THINGS THAT MAKE THIS MODULE, NOT A ONE-LINER ─────────────────
 * 1. **AN UNCONNECTED `in` IS A NOISE SOURCE.** That is not a fallback, it is
 *    the feature: seven of these with nothing patched into their inputs ARE the
 *    entire pitch and timbre memory of P2 (Omri Cohen's self-playing patch).
 *    Four noise colours and eight output ranges, so one module is "a random
 *    pitch in 0…10 V" or "a slow drift in ±1 V".
 * 2. **TRACK vs SAMPLE ARE DIFFERENT READS OF THE SAME TRIGGER.** Sample reads
 *    the rising EDGE; track reads the LEVEL, so it follows while the gate is
 *    high. And the output slew (their "Glide") is applied in SAMPLE MODE ONLY —
 *    slewing a tracked signal would just be a lowpass.
 * 3. **SECTION 2 FALLS BACK TO SECTION 1'S TRIGGER.** With one clock patched
 *    into Trigger 1, both halves fire together — which is how a patch gets a
 *    correlated pitch/velocity pair out of one 3 HP module.
 *
 * ── THE RECURRENCE, IN FLOAT (per section) ──────────────────────────────────
 *   fire  ← track ? trigger.isHigh() : trigger.risingEdge(triggerIn)
 *   value ← fire ? (inWired ? inVolts : (noise() + rangeOffset)·rangeScale)
 *                : value
 *   out   ← track ? ±value : slew(±value, smoothMs over 10 V)
 *
 * ── DEVIATIONS ──────────────────────────────────────────────────────────────
 * D2 (the noise is seeded), D5 (the panel trigger buttons are not ported) and
 * D6 (`poly_input` is meaningless at one channel) all apply.
 *
 * Command. Two triggers, two held values, two output slews, four noise trees.
 */
export class SampleHoldKernel {
  constructor(sampleRate, options = {}) {
    this.sampleRate = sampleRate;
    const seed = Math.trunc(options.seed ?? 0);
    // All four trees exist because the colour knob is LIVE: switching colour
    // must not rebuild the module, and a tree that only started generating when
    // selected would produce a different sequence than one that had been running.
    this.noises = {
      white: bogNoiseGenerator("white", seed),
      blue: bogNoiseGenerator("blue", seed + 1),
      pink: bogNoiseGenerator("pink", seed + 2),
      red: bogNoiseGenerator("red", seed + 3),
    };
    this.noiseType = "white";
    this.range = BOG_SH_RANGES["0V-10V"];
    this.sections = [0, 1].map(() => ({
      trigger: new BogTrigger(),
      value: 0,
      slew: new BogSlewLimiter(sampleRate, 0, BOG_SH_SLEW_RANGE_V),
      track: false,
      invert: false,
    }));
  }

  /** Command. The noise colour an unconnected `in` samples. */
  setNoiseType(value) {
    if (!(value in this.noises)) throw new Error(`SampleHoldKernel.setNoiseType: unknown colour ${JSON.stringify(value)}`);
    this.noiseType = value;
  }

  /** Command. One of `BOG_SH_RANGES`' eight named ranges. */
  setRange(value) {
    const range = BOG_SH_RANGES[value];
    if (!range) throw new Error(`SampleHoldKernel.setRange: unknown range ${JSON.stringify(value)}`);
    this.range = range;
  }

  /** Command. Section 1: sample the edge, or track the level. */
  setTrack1(value) {
    this.sections[0].track = vc3bTrackMode(value, "SampleHoldKernel.setTrack1");
  }

  /** Command. Section 2's mode. */
  setTrack2(value) {
    this.sections[1].track = vc3bTrackMode(value, "SampleHoldKernel.setTrack2");
  }

  /** Command. Section 1's output inversion. */
  setInvert1(value) {
    this.sections[0].invert = vc3bOnOff(value, "SampleHoldKernel.setInvert1");
  }

  /** Command. Section 2's output inversion. */
  setInvert2(value) {
    this.sections[1].invert = vc3bOnOff(value, "SampleHoldKernel.setInvert2");
  }

  /** Command. `SampleHold::modulateSection` — the glide time, per section. */
  control(knobs) {
    for (const section of this.sections) section.slew.setParams(this.sampleRate, knobs.smoothMs, BOG_SH_SLEW_RANGE_V);
  }

  /** Command. `SampleHold::processSection`, twice. */
  sample(knobs, signals, wired, frame) {
    for (let i = 0; i < 2; i++) {
      const section = this.sections[i];
      const triggerKey = i === 0 ? "trigger1" : "trigger2";
      const inKey = i === 0 ? "in1" : "in2";
      // SECTION 2 FALLS BACK TO SECTION 1'S TRIGGER — theirs, and load-bearing.
      let triggerIn = 0;
      if (wired[triggerKey]) triggerIn = signals[triggerKey];
      else if (i === 1 && wired.trigger1) triggerIn = signals.trigger1;
      const triggered = section.trigger.process(triggerIn);
      if (section.track ? section.trigger.isHigh() : triggered) {
        section.value = wired[inKey]
          ? signals[inKey]
          : (bogNoiseScaled(this.noiseType, this.noises[this.noiseType].next()) + this.range.offset) * this.range.scale;
      }
      let out = section.invert ? -section.value : section.value;
      if (!section.track) out = section.slew.next(out);
      frame[i] = out;
    }
  }
}

/** `Walk`'s own shaping (`Walk.cpp:88-101`). The rate knob is raised to the FIFTH
 *  power and scaled by 0.2, so the bottom nine-tenths of its travel is a very slow
 *  drift and the top tenth opens right up — that curve IS the knob's feel. */
const BOG_WALK_RATE_EXPONENT = 5;
const BOG_WALK_RATE_SCALE = 0.2;

/** `Walk::sampleRateChange` — a 100 ms slew over 10 V on the OUTPUT, which is
 *  what keeps a jump from being a click. */
const BOG_WALK_SLEW_MS = 100;
const BOG_WALK_SLEW_RANGE_V = 10;

/** `Walk::modulateChannel` — the offset knob spans ±5 V. */
const BOG_WALK_OFFSET_V = 5;

/**
 * `Bogaudio-Walk` — a SMOOTH random walker, and the modulation source eight of
 * P5's voices ride on.
 *
 * ── SOURCE ──────────────────────────────────────────────────────────────────
 *   plumbing   `src/Walk.cpp` (`modulateChannel`, `processChannel`)
 *   recurrence `src/dsp/noise.cpp` (`RandomWalk`) — see BogRandomWalk for the
 *              four-line recurrence and why one knob changes the character
 *   commit     656eaae458e045602dc974bae82e15a11e104958
 *
 * ── WHY IT IS NOT "SMOOTHED NOISE" ──────────────────────────────────────────
 * A leaky integrator over white noise, REFLECTED at ±5 V, lowpassed by a filter
 * whose cutoff the same knob moves, plus a decaying bias term that only a jump
 * sets. Smoothed noise returns to its mean; this WANDERS and stays where it
 * wanders, which is what makes eight of them sound like eight hands on eight
 * knobs rather than like eight LFOs.
 *
 * ── THE JUMP INPUT HAS THREE MEANINGS ──────────────────────────────────────
 * `jump` teleports the walk somewhere new; `track_and_hold` freezes it while the
 * gate is LOW; `sample_and_hold` freezes it between rising edges. All three are
 * one `jump_mode` field in their patch JSON, i.e. property state (R7-11), so it
 * is a knob here.
 *
 * ── DEVIATIONS ──────────────────────────────────────────────────────────────
 * D2 (seeded) and D6 (`poly_input`) apply. `Walk2` — the two-axis version with
 * an X/Y scope — is NOT this node: it is two of these plus a display, and the
 * registry folds it here. A patch needing X and Y uses two.
 *
 * Command. Holds the walker, a trigger and an output slew.
 */
export class WalkKernel {
  constructor(sampleRate, options = {}) {
    this.sampleRate = sampleRate;
    this.walk = new BogRandomWalk(sampleRate, Math.trunc(options.seed ?? 0));
    this.jumpTrigger = new BogTrigger();
    this.slew = new BogSlewLimiter(sampleRate, BOG_WALK_SLEW_MS, BOG_WALK_SLEW_RANGE_V);
    this.lastOut = 0;
    this.offset = 0;
    this.scale = 1;
    this.jumpMode = "jump";
  }

  /** Command. What the `jump` input does. */
  setJumpMode(value) {
    if (!["jump", "track_and_hold", "sample_and_hold"].includes(value)) {
      throw new Error(`WalkKernel.setJumpMode: unknown mode ${JSON.stringify(value)}`);
    }
    this.jumpMode = value;
  }

  /** Command. `Walk::modulateChannel`. */
  control(knobs, signals, wired) {
    let rate = knobs.rate;
    if (wired.rate_cv) rate *= bogClamp(signals.rate_cv / 10, 0, 1);
    rate = BOG_WALK_RATE_SCALE * Math.pow(rate, BOG_WALK_RATE_EXPONENT);
    this.walk.setParams(this.sampleRate, rate);

    this.offset = knobs.offset;
    if (wired.offset_cv) this.offset *= bogClamp(signals.offset_cv / 5, -1, 1);
    this.offset *= BOG_WALK_OFFSET_V;

    this.scale = knobs.scale;
    if (wired.scale_cv) this.scale *= bogClamp(signals.scale_cv / 10, 0, 1);
  }

  /** Command. `Walk::processChannel`. */
  sample(knobs, signals, wired, frame) {
    const triggered = this.jumpTrigger.process(signals.jump);
    let out = this.walk.next();
    if (this.jumpMode === "jump") {
      if (triggered) this.walk.jump();
    } else if (this.jumpMode === "track_and_hold") {
      if (this.jumpTrigger.isHigh()) this.lastOut = out;
      else out = this.lastOut;
    } else {
      if (triggered) this.lastOut = out;
      else out = this.lastOut;
    }
    out = this.slew.next(out);
    out *= this.scale;
    out += this.offset;
    frame[0] = out;
  }
}

/** `Pressor::modulateChannel`'s parameter spans (`Pressor.cpp:105-175`). */
const BOG_PRESSOR_THRESHOLD_SPAN_DB = 30;
const BOG_PRESSOR_THRESHOLD_OFFSET_DB = -24;
const BOG_PRESSOR_ATTACK_MAX_MS = 500;
const BOG_PRESSOR_RELEASE_MAX_MS = 2000;
const BOG_PRESSOR_IN_GAIN_MAX_DB = 12;
const BOG_PRESSOR_OUT_GAIN_MAX_DB = 24;

/** `Engine() : detectorRMS(1000.0f, 1.0f, 50.0f)` — a 50 ms window at full
 *  sensitivity. That window IS the compressor's character: it is long enough to
 *  ignore a single cycle of a bass note and short enough to catch a snare. */
const BOG_PRESSOR_RMS_WINDOW_MS = 50;
const BOG_PRESSOR_RMS_SENSITIVITY = 1;

/** `Pressor::modulateChannel`'s ratio curve — `1/tan((1 − r^1.5)·π/4)`. Named
 *  because a linear ratio knob would put every useful setting in the bottom
 *  fifth: r = 0 is 1:1, r ≈ 0.55 is 2:1, and r = 1 is ∞:1 (a limiter). */
const BOG_PRESSOR_RATIO_EXPONENT = 1.5;

/**
 * Pure function. `Pressor::modulateChannel`'s ratio mapping.
 *
 * @param {number} knob - 0…1
 * @returns {number} the compression ratio, N:1
 *
 * @example bogPressorRatio(0) // 1
 * @example // their own default knob position is exactly 2:1
 * @example Math.round(bogPressorRatio(0.55159) * 1000) / 1000 // 2
 * @example bogPressorRatio(1) // Infinity
 */
export function bogPressorRatio(knob) {
  return 1 / Math.tan((1 - Math.pow(knob, BOG_PRESSOR_RATIO_EXPONENT)) * Math.PI * 0.25);
}

/**
 * `Bogaudio-Pressor` — a real stereo compressor/limiter/noise-gate with a
 * sidechain.
 *
 * ── SOURCE ──────────────────────────────────────────────────────────────────
 *   plumbing   `src/Pressor.cpp` (`modulateChannel`, `processChannel`)
 *   recurrence `src/dsp/signal.cpp` (`Compressor::compressionDb`,
 *              `NoiseGate::compressionDb`, `SlewLimiter`, `Amplifier`,
 *              `Saturator`, `CrossFader`), `dsp/filters/utility.cpp`
 *              (`FastRootMeanSquare`, `DCBlocker`)
 *   commit     656eaae458e045602dc974bae82e15a11e104958
 *
 * ── WHY THIS IS NOT "A GAIN CURVE" ──────────────────────────────────────────
 * Four pieces, and a port missing any one of them is a different device:
 * 1. **THE DETECTOR IS AN RMS OVER A 50 ms WINDOW**, DC-blocked and rectified
 *    (`FastRootMeanSquare`) — a true boxcar, not a one-pole. Its Peak mode is
 *    `|x|` instead, and the two sound nothing alike on percussion.
 * 2. **ATTACK AND RELEASE ARE SLEW LIMITERS ON THE ENVELOPE**, chosen per
 *    sample by whether the envelope is rising. Attack spans 0…500 ms, release
 *    0…2 s, both as the SQUARE of their knob.
 * 3. **THE KNEE IS A CHORD CONSTRUCTION, NOT A POLYNOMIAL** — see
 *    `bogCompressionDb`. It starts 3 dB BELOW the threshold.
 * 4. **THE SIDECHAIN HAS ITS OWN CROSSFADER** into the detector path
 *    (`detectorMix`, linear, curve 0), so the detector can hear any blend of
 *    the programme and the sidechain rather than one or the other.
 * The output stage is `saturate(amplifier · in · outLevel)`, so hitting it hard
 * distorts softly rather than clipping — which is why it is used as a MASTER
 * bus processor in P5 and P9 and not just as a ducker.
 *
 * ── THE RECURRENCE, IN FLOAT ────────────────────────────────────────────────
 *   env ← |L·inLevel + R·inLevel|, crossfaded with the sidechain if wired
 *   env ← rms ? rms50ms(env) : |env|
 *   env ← env > lastEnv ? attackSlew(env, lastEnv) : releaseSlew(env, lastEnv)
 *   dB  ← amplitudeToDecibels(env / 5)
 *   red ← compressor ? compressionDb(dB, thresholdDb, ratio, softKnee)
 *                    : noiseGateDb(dB, thresholdDb, ratio, softKnee)
 *   out ← saturate(amplifierLevel(−red) · in · inLevel · outLevel)
 *
 * ── DEVIATIONS ──────────────────────────────────────────────────────────────
 * D13 (threshold and both gains are knobs in dB rather than 0…1 positions).
 * `_thresholdRange` is a context-menu multiplier in Rack and is a knob here,
 * because their `dataToJson` stores it — R7-11's rule that a saved field is
 * property state.
 * THEIR `NoiseGate` SOFT-KNEE BRANCH IS A DOCUMENTED NO-OP (their own FIXME)
 * and is reproduced; `bogNoiseGateDb` says so.
 *
 * Command. Holds the detector, two slews, a crossfader and the gain state.
 */
export class PressorKernel {
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    this.attackSL = new BogSlewLimiter(sampleRate, 0, 1);
    this.releaseSL = new BogSlewLimiter(sampleRate, 0, 1);
    this.detectorMix = new BogCrossFader();
    this.detectorRMS = new BogRootMeanSquare(sampleRate, BOG_PRESSOR_RMS_SENSITIVITY, BOG_PRESSOR_RMS_WINDOW_MS);
    this.lastEnv = 0;
    this.thresholdDb = 0;
    this.ratio = 1;
    this.ratioKnob = -1;
    this.inLevel = 1;
    this.outLevel = 1;
    this.compressorMode = true;
    this.rmsDetector = true;
    this.softKnee = true;
  }

  /** Command. Compressor or noise gate — the same control path, run either way up. */
  setMode(value) {
    if (value !== "compressor" && value !== "noise_gate") {
      throw new Error(`PressorKernel.setMode: ${JSON.stringify(value)} is not compressor or noise_gate`);
    }
    this.compressorMode = value === "compressor";
  }

  /** Command. RMS-over-50 ms or peak detection. */
  setDetector(value) {
    if (value !== "rms" && value !== "peak") {
      throw new Error(`PressorKernel.setDetector: ${JSON.stringify(value)} is not rms or peak`);
    }
    this.rmsDetector = value === "rms";
  }

  /** Command. Soft or hard knee. */
  setKnee(value) {
    if (value !== "soft" && value !== "hard") {
      throw new Error(`PressorKernel.setKnee: ${JSON.stringify(value)} is not soft or hard`);
    }
    this.softKnee = value === "soft";
  }

  /** Command. `Pressor::modulate` + `::modulateChannel`. */
  control(knobs, signals, wired) {
    // D13: the knob is dB; their arithmetic runs on the 0…1 position, so the CV
    // multiply must happen there or a CV would scale an OFFSET dB value.
    let threshold01 = bogClamp((knobs.threshold - BOG_PRESSOR_THRESHOLD_OFFSET_DB) / BOG_PRESSOR_THRESHOLD_SPAN_DB, 0, 1);
    if (wired.threshold_cv) threshold01 *= bogClamp(signals.threshold_cv / 10, 0, 1);
    this.thresholdDb = (threshold01 * BOG_PRESSOR_THRESHOLD_SPAN_DB + BOG_PRESSOR_THRESHOLD_OFFSET_DB) * knobs.thresholdRange;

    let ratio = bogClamp(knobs.ratio, 0, 1);
    if (wired.ratio_cv) ratio *= bogClamp(signals.ratio_cv / 10, 0, 1);
    if (this.ratioKnob !== ratio) {
      this.ratioKnob = ratio;
      this.ratio = bogPressorRatio(ratio);
    }

    let attack = Math.sqrt(bogClamp(knobs.attack, 0, BOG_PRESSOR_ATTACK_MAX_MS) / BOG_PRESSOR_ATTACK_MAX_MS);
    if (wired.attack_cv) attack *= bogClamp(signals.attack_cv / 10, 0, 1);
    attack *= attack;
    this.attackSL.setParams(this.sampleRate, attack * BOG_PRESSOR_ATTACK_MAX_MS, 1);

    let release = Math.sqrt(bogClamp(knobs.release, 0, BOG_PRESSOR_RELEASE_MAX_MS) / BOG_PRESSOR_RELEASE_MAX_MS);
    if (wired.release_cv) release *= bogClamp(signals.release_cv / 10, 0, 1);
    release *= release;
    this.releaseSL.setParams(this.sampleRate, release * BOG_PRESSOR_RELEASE_MAX_MS, 1);

    // THE TWO GAINS SUM THEIR CV RATHER THAN MULTIPLYING IT — theirs, and the
    // asymmetry with everything above is deliberate in the original too.
    let inGain = bogClamp(knobs.inputGain, -BOG_PRESSOR_IN_GAIN_MAX_DB, BOG_PRESSOR_IN_GAIN_MAX_DB) / BOG_PRESSOR_IN_GAIN_MAX_DB;
    if (wired.input_gain_cv) inGain = bogClamp(inGain + signals.input_gain_cv / 5, -1, 1);
    this.inLevel = bogDecibelsToAmplitude(inGain * BOG_PRESSOR_IN_GAIN_MAX_DB);

    let outGain = bogClamp(knobs.outputGain, 0, BOG_PRESSOR_OUT_GAIN_MAX_DB) / BOG_PRESSOR_OUT_GAIN_MAX_DB;
    if (wired.output_gain_cv) outGain = bogClamp(outGain + signals.output_gain_cv / 5, 0, 1);
    this.outLevel = bogDecibelsToAmplitude(outGain * BOG_PRESSOR_OUT_GAIN_MAX_DB);

    this.detectorMix.setParams(bogClamp(knobs.detectorMix, -1, 1), 0, true);
  }

  /** Command. `Pressor::processChannel` — frame is [envelope, left, right]. */
  sample(knobs, signals, wired, frame) {
    const leftInput = signals.left * this.inLevel;
    const rightInput = signals.right * this.inLevel;
    let env = leftInput + rightInput;
    if (wired.sidechain) env = this.detectorMix.next(env, signals.sidechain);
    env = this.rmsDetector ? this.detectorRMS.next(env) : Math.abs(env);
    env = env > this.lastEnv ? this.attackSL.nextFrom(env, this.lastEnv) : this.releaseSL.nextFrom(env, this.lastEnv);
    this.lastEnv = env;

    const detectorDb = bogAmplitudeToDecibels(env / RACK_VOLTS_PER_UNIT);
    const compressionDb = this.compressorMode
      ? bogCompressionDb(detectorDb, this.thresholdDb, this.ratio, this.softKnee)
      : bogNoiseGateDb(detectorDb, this.thresholdDb, this.ratio, this.softKnee);
    const level = bogAmplifierLevel(-compressionDb);
    frame[0] = env;
    frame[1] = bogSaturate(level * leftInput * this.outLevel);
    frame[2] = bogSaturate(level * rightInput * this.outLevel);
  }
}

/** `VCA::sampleRateChange` — a 5 ms slew over a range of 1 on each level, which
 *  is what makes a stepped CV into a VCA a fade rather than a click. */
const BOG_VCA_LEVEL_SLEW_MS = 5;

/**
 * Pure function. The DECIBEL taper Bogaudio's VCA, VCM and PEQ level knobs share
 * (`VCA.cpp:36`): a 0…1 knob becomes `(1 − knob) · minDecibels` dB. So 1 is
 * unity, 0.5 is −30 dB and 0 is silence — which is why these knobs feel like
 * faders rather than like linear multipliers.
 *
 * @param {number} knob - 0…1
 * @returns {number} the linear gain
 *
 * @example bogLevelTaper(1) // 1
 * @example bogLevelTaper(0) // 0
 * @example // half-way up is −30 dB, not −6 dB — that is the whole point
 * @example bogLevelTaper(0.5) // 0.031622776601683784
 */
export function bogLevelTaper(knob) {
  return bogAmplifierLevel((1 - knob) * BOG_AMP_MIN_DB);
}

/**
 * `Bogaudio-VCA` — two independent VCAs sharing one linear/decibel switch.
 *
 * ── SOURCE ──────────────────────────────────────────────────────────────────
 *   plumbing   `src/VCA.cpp` (`channelStep`)
 *   recurrence `dsp/signal.cpp` (`Amplifier`, `SlewLimiter`)
 *   commit     656eaae458e045602dc974bae82e15a11e104958
 *
 * ── THE TWO TAPERS ARE THE MODULE ───────────────────────────────────────────
 * In LINEAR mode the level multiplies amplitude directly; in DECIBEL mode it
 * runs through `bogLevelTaper`, where half-way up is −30 dB. Wire an envelope
 * into a VCA in each mode and you get two audibly different envelopes from the
 * same envelope — which is why the switch exists and why a port that picked one
 * would be wrong half the time. `Bogaudio-VCAmp` (the single, panel-metered
 * version) is the same arithmetic and folds into this row.
 *
 * ── THE RECURRENCE, IN FLOAT (per section) ──────────────────────────────────
 *   level ← slew(knob · clamp(cv/10, 0, 1), 5 ms)
 *   out   ← linear ? level · in : amplifierLevel((1 − level)·(−60 dB)) · in
 *
 * ── DEVIATION ───────────────────────────────────────────────────────────────
 * D-IDLE. THEIRS RETURNS EARLY when the input or output is unconnected, which
 *     leaves the output port holding its LAST voltage forever and freezes the
 *     level slew. Ours outputs silence and keeps slewing. A held stale DC on an
 *     unpatched output is not behaviour worth reproducing, and output
 *     connectedness is invisible to a worklet anyway (D3).
 *
 * Command. Two amplifier levels and two slews.
 */
export class VcaKernel {
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    this.linear = false;
    this.levelSLs = [
      new BogSlewLimiter(sampleRate, BOG_VCA_LEVEL_SLEW_MS, 1),
      new BogSlewLimiter(sampleRate, BOG_VCA_LEVEL_SLEW_MS, 1),
    ];
  }

  /** Command. Linear or decibel taper, for BOTH sections (theirs is one switch). */
  setTaper(value) {
    this.linear = vc3bTaper(value, "VcaKernel.setTaper");
  }

  /** Command. Nothing to do at control rate — their `channelStep` runs per sample. */
  control() {}

  /** Command. `VCA::processAll` — frame is [out1, out2]. */
  sample(knobs, signals, wired, frame) {
    for (let i = 0; i < 2; i++) {
      const n = i + 1;
      if (!wired[`in${n}`]) {
        frame[i] = 0;
        continue;
      }
      let level = knobs[`level${n}`];
      if (wired[`cv${n}`]) level *= bogClamp(signals[`cv${n}`] / 10, 0, 1);
      level = this.levelSLs[i].next(level);
      frame[i] = this.linear ? level * signals[`in${n}`] : bogLevelTaper(level) * signals[`in${n}`];
    }
  }
}

/** `DisableOutputLimitModule`'s ceiling (`Offset.cpp:44`, `VCM.cpp:31`) — ±12 V,
 *  the same number `Saturator::limit` uses, but a HARD clamp rather than a knee. */
const BOG_OUTPUT_LIMIT_V = 12;

/** VCM's four channels (`VCM.hpp:15-18`). */
const BOG_VCM_CHANNELS = 4;

/**
 * `Bogaudio-VCM` — a four-channel voltage-controlled mixer.
 *
 * ── SOURCE ──────────────────────────────────────────────────────────────────
 *   plumbing   `src/VCM.cpp` (`processChannel`, `channelStep`)
 *   recurrence `dsp/signal.cpp` (`Amplifier`)
 *   commit     656eaae458e045602dc974bae82e15a11e104958
 *
 * ── THE RECURRENCE, IN FLOAT ────────────────────────────────────────────────
 *   per channel: level ← knob · clamp(cv/10, 0, 1)   [if the CV is wired]
 *                sum  += linear ? level·in : amplifierLevel((1−level)·−60)·in
 *   mix   ← knob · clamp(mixCv/10, 0, 1)
 *   out   ← clamp(sum · mix · mix, ±12 V)            ← see D12
 *
 * ── D12. THE MIX KNOB IS APPLIED TWICE, AND IT IS THEIR BUG ─────────────────
 * `VCM.cpp:30-33`, verbatim:
 *     out *= level;
 *     …
 *     outputs[MIX_OUTPUT].setVoltage(level * out, c);
 * So the master level is SQUARED. At the default 0.8 that is 0.64 — 3.9 dB
 * quieter than the panel claims, and the taper is twice as steep as it looks.
 * REPRODUCED, because R7-11's ruling is to port the SOUND faithfully and make
 * the LABEL honest: the spec's `help` states it, and a patch mixed on this
 * module in Rack has been balanced against the squared curve.
 *
 * ── DEVIATION ───────────────────────────────────────────────────────────────
 * D-NOSLEW. VCM has no level slew where VCA has one (theirs, not ours), so a
 *     stepped CV into a VCM channel DOES click. Not smoothed: adding a slew
 *     would make it a different module from the one the patch was mixed on.
 *
 * Command. Nothing but the output limit switch is state.
 */
export class VcmKernel {
  constructor() {
    this.linear = false;
    this.outputLimit = true;
  }

  /** Command. Linear or decibel taper on all four channels and the mix. */
  setTaper(value) {
    this.linear = vc3bTaper(value, "VcmKernel.setTaper");
  }

  /** Command. Their `disableOutputLimit` context-menu item, as a knob. */
  setOutputLimit(value) {
    this.outputLimit = vc3bOnOff(value, "VcmKernel.setOutputLimit");
  }

  /** Command. Nothing at control rate — theirs runs per sample. */
  control() {}

  /** Command. `VCM::processChannel`. */
  sample(knobs, signals, wired, frame) {
    let out = 0;
    for (let n = 1; n <= BOG_VCM_CHANNELS; n++) {
      if (!wired[`in${n}`]) continue;
      let level = knobs[`level${n}`];
      if (wired[`cv${n}`]) level *= bogClamp(signals[`cv${n}`] / 10, 0, 1);
      out += this.linear ? level * signals[`in${n}`] : bogLevelTaper(level) * signals[`in${n}`];
    }
    let level = knobs.mix;
    if (wired.mix_cv) level *= bogClamp(signals.mix_cv / 10, 0, 1);
    // D12: once here and once at the write, exactly as theirs does it.
    out *= level;
    if (this.outputLimit) out = bogClamp(out, -BOG_OUTPUT_LIMIT_V, BOG_OUTPUT_LIMIT_V);
    frame[0] = level * out;
  }
}

/** `XFade::sampleRateChange` — a 10 ms slew over the mix's ±1 range (i.e. 2). */
const BOG_XFADE_MIX_SLEW_MS = 10;
const BOG_XFADE_MIX_RANGE = 2;

/** `XFade::processChannel`'s curve warp in DECIBEL mode — `pow(knob, 0.082)`,
 *  which crushes almost the whole knob against 1.0. Theirs; it is what makes the
 *  decibel crossfade's constant-power region wide. */
const BOG_XFADE_CURVE_EXPONENT = 0.082;

/**
 * `Bogaudio-XFade` — a crossfader with a CURVE control.
 *
 * ── SOURCE ──────────────────────────────────────────────────────────────────
 *   plumbing   `src/XFade.cpp` (`processChannel`)
 *   recurrence `dsp/signal.cpp` (`CrossFader::setParams` / `::next`) — see
 *              `bogCrossFaderMix` for what the curve actually does
 *   commit     656eaae458e045602dc974bae82e15a11e104958
 *
 * ── THE RECURRENCE, IN FLOAT ────────────────────────────────────────────────
 *   mix   ← slew(knob · clamp(mixCv/5, ±1), 10 ms over 2)
 *   curve ← (linear ? knob : knob^0.082) · 2 − 1
 *   out   ← crossFader(mix, curve, linear).next(a, b)
 *
 * Note that `setParams` runs PER SAMPLE here (XFade has no `modulate` override),
 * behind their own change guard — so a moving mix CV re-solves the curve every
 * sample. Reproduced, guard and all.
 *
 * Command. Holds the mix slew and the fader's cached coefficients.
 */
export class XFadeKernel {
  constructor(sampleRate) {
    this.mixSL = new BogSlewLimiter(sampleRate, BOG_XFADE_MIX_SLEW_MS, BOG_XFADE_MIX_RANGE);
    this.fader = new BogCrossFader();
    this.linear = false;
    this.lastMix = NaN;
    this.lastCurve = NaN;
    this.lastLinear = null;
  }

  /** Command. Amplitude-linear or decibel-linear cut. */
  setTaper(value) {
    this.linear = vc3bTaper(value, "XFadeKernel.setTaper");
  }

  /** Command. Nothing at control rate — theirs runs per sample. */
  control() {}

  /** Command. `XFade::processChannel`. */
  sample(knobs, signals, wired, frame) {
    let mix = bogClamp(knobs.mix, -1, 1);
    if (wired.mix_cv) mix *= bogClamp(signals.mix_cv / 5, -1, 1);
    mix = this.mixSL.next(mix);
    const curveIn = bogClamp(knobs.curve, 0, 1);
    if (this.lastLinear !== this.linear || this.lastMix !== mix || this.lastCurve !== curveIn) {
      this.lastLinear = this.linear;
      this.lastMix = mix;
      this.lastCurve = curveIn;
      const warped = (this.linear ? curveIn : Math.pow(curveIn, BOG_XFADE_CURVE_EXPONENT)) * 2 - 1;
      this.fader.setParams(mix, warped, this.linear);
    }
    frame[0] = this.fader.next(signals.a, signals.b);
  }
}

/** `Offset::processChannel`'s spans — the offset knob is ±10 V and the scale knob
 *  is a SIGNED SQUARE times ten, so ±10× with fine control near unity. */
const BOG_OFFSET_MAX_V = 10;
const BOG_OFFSET_MAX_SCALE = 10;

/**
 * `Bogaudio-Offset` — scale then offset (or offset then scale).
 *
 * ── SOURCE ──────────────────────────────────────────────────────────────────
 *   plumbing   `src/Offset.cpp` (`processChannel`, `knobValue`)
 *   commit     656eaae458e045602dc974bae82e15a11e104958
 *
 * ── THE RECURRENCE, IN FLOAT ────────────────────────────────────────────────
 *   offset ← knob · clamp(cv/10, ±1) · 10 V
 *   scale  ← sign(knob) · knob² · 10          (a SIGNED square: an attenuverter
 *                                             with fine control near zero)
 *   out    ← offsetFirst ? (in + offset)·scale : in·scale + offset
 *   out    ← clamp(out, ±12 V)                unless the limit is disabled
 *
 * ── WHY THE ORDER SWITCH MATTERS ────────────────────────────────────────────
 * `(in + offset)·scale` and `in·scale + offset` are different instruments: the
 * first moves a signal's CENTRE before amplifying (so the offset is amplified
 * too), the second amplifies then re-centres. P8 uses it as a polyphonic
 * attenuverter on a chord bus, where only the second is what you want.
 *
 * Command. Only the two switches are state.
 */
export class OffsetKernel {
  constructor() {
    this.offsetFirst = false;
    this.outputLimit = true;
  }

  /** Command. Which operation happens first. */
  setOrder(value) {
    if (value !== "scale_first" && value !== "offset_first") {
      throw new Error(`OffsetKernel.setOrder: ${JSON.stringify(value)} is not scale_first or offset_first`);
    }
    this.offsetFirst = value === "offset_first";
  }

  /** Command. Their `disableOutputLimit` context-menu item, as a knob. */
  setOutputLimit(value) {
    this.outputLimit = vc3bOnOff(value, "OffsetKernel.setOutputLimit");
  }

  /** Command. Nothing at control rate — theirs runs per sample. */
  control() {}

  /** Command. `Offset::processChannel`. */
  sample(knobs, signals, wired, frame) {
    let offset = bogClamp(knobs.offset, -1, 1);
    if (wired.offset_cv) offset *= bogClamp(signals.offset_cv / 10, -1, 1);
    offset *= BOG_OFFSET_MAX_V;

    let scale = bogClamp(knobs.scale, -1, 1);
    if (wired.scale_cv) scale *= bogClamp(signals.scale_cv / 10, -1, 1);
    scale = scale < 0 ? -(scale * scale) : scale * scale;
    scale *= BOG_OFFSET_MAX_SCALE;

    let out = signals.in;
    if (this.offsetFirst) {
      out += offset;
      out *= scale;
    } else {
      out *= scale;
      out += offset;
    }
    if (this.outputLimit) out = bogClamp(out, -BOG_OUTPUT_LIMIT_V, BOG_OUTPUT_LIMIT_V);
    frame[0] = out;
  }
}

/**
 * `Bogaudio-Switch` — TWO 2-way signal routers on one gate.
 *
 * ── SOURCE ──────────────────────────────────────────────────────────────────
 *   plumbing   `src/Switch.cpp` (`processChannel`)
 *   recurrence `rack_overrides.cpp` (`Trigger`)
 *   commit     656eaae458e045602dc974bae82e15a11e104958
 *
 * ── THE RECURRENCE, IN FLOAT ────────────────────────────────────────────────
 *   triggered ← trigger.risingEdge(gateVolts)
 *   high      ← latch ? (triggered ? !high : high) : trigger.isHigh()
 *   out1      ← high ? high1 : low1
 *   out2      ← high ? high2 : low2
 *
 * ── LATCH IS A DIFFERENT MODULE, NOT A CONVENIENCE ──────────────────────────
 * Ungated it is a MULTIPLEXER (the gate's level chooses); latched it is a
 * FLIP-FLOP (each rising edge toggles), so one clock alternates two sources
 * forever. P25's subharmonic patch uses the latched form to swap sequencer
 * outputs on a clock, and P19's MS-20 the unlatched form as a manual A/B.
 *
 * ── DEVIATION ───────────────────────────────────────────────────────────────
 * D5 (the panel Gate button is not ported) applies. Their `_latchedHigh` is
 * saved to the patch (`SaveLatchToPatchModule`); ours is not, because a latch's
 * position after N clock edges is HISTORY, not property state — reloading a
 * document must not depend on where the flip-flop was left.
 *
 * Command. Holds one trigger and one latch bit.
 */
export class SwitchKernel {
  constructor() {
    this.trigger = new BogTrigger();
    this.latchedHigh = false;
    this.latch = false;
  }

  /** Command. Gate-following or edge-latching. */
  setLatch(value) {
    this.latch = vc3bOnOff(value, "SwitchKernel.setLatch");
  }

  /** Command. Nothing at control rate — theirs runs per sample. */
  control() {}

  /** Command. `Switch::processChannel` — frame is [out1, out2]. */
  sample(knobs, signals, wired, frame) {
    const triggered = this.trigger.process(signals.gate);
    if (this.latch) {
      if (triggered) this.latchedHigh = !this.latchedHigh;
    } else {
      this.latchedHigh = false;
    }
    const high = this.latchedHigh || (!this.latch && this.trigger.isHigh());
    frame[0] = high ? signals.high1 : signals.low1;
    frame[1] = high ? signals.high2 : signals.low2;
  }
}

/** `Stack`'s output range (`Stack.hpp:35-36`) — C1 to C9, as ABSOLUTE semitones in
 *  their domain where 60 is C4. */
const BOG_STACK_MIN_SEMITONE = 24;
const BOG_STACK_MAX_SEMITONE = 120;

/** `Stack::modulateChannel` clamps its CV inlet to ±5 V and reads it at TEN
 *  SEMITONES PER VOLT — so ±50 semitones. NOT one volt per octave: this inlet is a
 *  transposition amount, which is why it becomes a semitone port here rather than
 *  keeping a volt scale nothing else in the block uses (deviation D-STACKUNITS). */
const BOG_STACK_CV_CLAMP_SEMITONES = 50;

/**
 * Pure function. `dsp/pitch.hpp semitoneToCV`.
 *
 * @param {number} semitone - 60 = C4
 * @returns {number} volts per octave
 *
 * @example bogSemitoneToCv(60) // 0
 * @example bogSemitoneToCv(72) // 1.0000000000000004
 */
export function bogSemitoneToCv(semitone) {
  return bogFrequencyToCv(bogSemitoneToFrequency(semitone));
}

/**
 * Pure function. `dsp/pitch.hpp cvToSemitone`.
 *
 * @param {number} cv - volts per octave
 * @returns {number} semitones, 60 = C4
 *
 * @example bogCvToSemitone(0) // 60
 * @example bogCvToSemitone(1) // 72.00000000000003
 */
export function bogCvToSemitone(cv) {
  return bogFrequencyToSemitone(bogCvToFrequency(cv));
}

/**
 * `Bogaudio-Stack` — a V/oct transposer, for stacking a second voice on a pitch.
 *
 * ── SOURCE ──────────────────────────────────────────────────────────────────
 *   plumbing   `src/Stack.cpp` (`modulateChannel`, `processChannel`)
 *   recurrence `src/dsp/pitch.hpp`
 *   commit     656eaae458e045602dc974bae82e15a11e104958
 *
 * ── THE RECURRENCE, IN FLOAT (ALL FOUR PORTS IN SEMITONES — SEE D-STACKUNITS) ─
 *   semis ← round(octave)·12 + round(semitones) + clamp(cvIn, ±50)
 *           then rounded to a whole semitone if Quantize is on
 *   pitch ← clamp(inIn, C1…C9 as semitones from C4)
 *   out   ← clamp(pitch + semis + fine, C1…C9)
 *   thru  ← in wired ? pitch : semis
 *
 * ── THE TWO DETAILS A ONE-LINER WOULD MISS ──────────────────────────────────
 * 1. **AN INPUT OF EXACTLY 0 IS TREATED AS C4, NOT AS "no input"** — their
 *    `inCV != 0 ? cvToSemitone(inCV) : referenceSemitone`, which is the SAME
 *    number. The branch only matters because 0 is also what an unwired input
 *    reads, so an unpatched Stack still emits a valid pitch — which is why it
 *    doubles as a fixed-interval CV source.
 * 2. **`thru` BECOMES A TRANSPOSITION OUTPUT WHEN NOTHING IS PATCHED IN**, ready
 *    to drive another Stack's `cv` inlet. That is how they chain.
 *
 * ── D-STACKUNITS. ALL FOUR PORTS ARE SEMITONES, INCLUDING `cv` AND `thru` ────
 * R7-UNITS clause 3 makes `in` and `out` semitone ports because they are V/oct.
 * Their `cv` inlet is TEN SEMITONES PER VOLT and their `thru`, when unpatched,
 * emits `semitones/10` to feed it — two ports carrying a *transposition* on a
 * scale that is neither V/oct nor a level. Under one uniform law that pair would
 * chain wrong by 2.4×, silently and in a tune-shaped way. So both are SEMITONES
 * here: `cv` transposes by the semitones it carries, and unpatched `thru` emits
 * the transposition itself. `thru → cv` is then EXACT and in one unit, where in
 * Rack it is exact only because both sides agree on an arbitrary 10 st/V. This is
 * the only deviation in the block that changes a number a patch would type, and
 * it is here rather than in the patch because a hidden 10 st/V scale is the exact
 * class of bug R7-UNITS was written to end.
 *
 * Command. Holds the modulated transposition.
 */
export class StackKernel {
  constructor() {
    this.semitones = 0;
    this.quantize = true;
    // The output range, as semitones FROM C4 — the domain the ports carry.
    this.minPitch = BOG_STACK_MIN_SEMITONE - BOG_REFERENCE_SEMITONE;
    this.maxPitch = BOG_STACK_MAX_SEMITONE - BOG_REFERENCE_SEMITONE;
  }

  /** Command. Snap the transposition to whole semitones. */
  setQuantize(value) {
    this.quantize = vc3bOnOff(value, "StackKernel.setQuantize");
  }

  /** Command. `Stack::modulateChannel`. */
  control(knobs, signals, wired) {
    let semitones = Math.round(knobs.octave) * BOG_SEMITONES_PER_VOLT + Math.round(knobs.semitones);
    if (wired.cv) semitones += bogClamp(signals.cv, -BOG_STACK_CV_CLAMP_SEMITONES, BOG_STACK_CV_CLAMP_SEMITONES);
    this.semitones = this.quantize ? Math.round(semitones) : semitones;
  }

  /** Command. `Stack::processChannel` — frame is [thru, out]. */
  sample(knobs, signals, wired, frame) {
    const pitch = bogClamp(signals.in, this.minPitch, this.maxPitch);
    frame[0] = wired.in ? pitch : this.semitones;
    frame[1] = bogClamp(pitch + this.semitones + knobs.fine, this.minPitch, this.maxPitch);
  }
}

// ── THE THREE DISCRETE-KNOB VOCABULARIES, SPELLED ONCE ──────────────────────

/**
 * Pure function. An on/off discrete knob's value as a boolean. Named so eight
 * setters do not each spell the same two-string check, and so an unknown value
 * is LOUD everywhere rather than in seven places out of eight.
 *
 * @param {string} value - "on" | "off"
 * @param {string} where - the setter's name, for the error
 * @returns {boolean}
 *
 * @example vc3bOnOff("on", "x") // true
 * @example vc3bOnOff("off", "x") // false
 */
export function vc3bOnOff(value, where) {
  if (value !== "on" && value !== "off") throw new Error(`${where}: ${JSON.stringify(value)} is not on or off`);
  return value === "on";
}

/**
 * Pure function. A level taper knob's value as "is it linear?".
 *
 * @param {string} value - "linear" | "decibels"
 * @param {string} where - the setter's name, for the error
 * @returns {boolean}
 *
 * @example vc3bTaper("linear", "x") // true
 * @example vc3bTaper("decibels", "x") // false
 */
export function vc3bTaper(value, where) {
  if (value !== "linear" && value !== "decibels") throw new Error(`${where}: ${JSON.stringify(value)} is not linear or decibels`);
  return value === "linear";
}

/**
 * Pure function. A sample-and-hold section's mode as "does it track?".
 *
 * @param {string} value - "track" | "sample"
 * @param {string} where - the setter's name, for the error
 * @returns {boolean}
 *
 * @example vc3bTrackMode("track", "x") // true
 * @example vc3bTrackMode("sample", "x") // false
 */
export function vc3bTrackMode(value, where) {
  if (value !== "track" && value !== "sample") throw new Error(`${where}: ${JSON.stringify(value)} is not track or sample`);
  return value === "track";
}
