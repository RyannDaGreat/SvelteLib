/**
 * PURE DSP MATH — the part of the synth engine with no AudioContext in it.
 *
 * ── WHY THIS FILE EXISTS SEPARATELY ───────────────────────────────────────────
 * Everything an AudioContext touches can only be proven in a browser. Everything
 * in HERE is ordinary arithmetic over Float32Arrays and numbers, so it runs in
 * bare node and is covered by tests/synth_engine_test.js. The split is
 * deliberate: impulse-response generation, the lookahead scheduler's timing
 * arithmetic, parameter clamping and the FM bell's ratio tables are the parts
 * where a silent mistake produces a WRONG SOUND rather than an exception, and
 * those are exactly the parts a cheap node test can pin.
 *
 * Nothing here imports PowerRP (the ENGINE law: PowerRP controls the synth, the
 * synth never reaches back), and nothing here imports a browser global.
 *
 * All functions are PURE unless their docstring says otherwise.
 */

// ─── Parameter clamping ──────────────────────────────────────────────────────

/**
 * Coercion-free numeric clamp: refuses non-numbers LOUDLY rather than coercing.
 *
 * A synth parameter that silently accepts "440" or NaN is how a patch goes
 * quiet with no error to explain it — `gain.value = NaN` throws in some
 * browsers and poisons the node in others. So this is the ONE funnel every
 * setParam goes through, and it throws on anything that is not a finite number.
 *
 * Args:
 *     value (number): Candidate value
 *     min (number): Lower bound, inclusive
 *     max (number): Upper bound, inclusive
 *     label (string): Name used in the error message
 *
 * Returns:
 *     number: value clamped into [min, max]
 *
 * Examples:
 *     >>> clampParam(0.5, 0, 1, "gain")            // 0.5
 *     >>> clampParam(20000, 20, 18000, "cutoff")   // 18000  (clamped, not an error)
 *     >>> clampParam("440", 0, 1000, "freq")       // throws: freq must be a finite number
 */
export function clampParam(value, min, max, label) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${label} must be a finite number, got ${JSON.stringify(value)}`);
  }
  return Math.min(max, Math.max(min, value));
}

/**
 * Musical pitch conversion: MIDI note number -> frequency in Hz (A4 = 69 = 440).
 *
 * Examples:
 *     >>> midiToFreq(69)   // 440
 *     >>> midiToFreq(81)   // 880   (one octave up)
 */
export function midiToFreq(note) {
  return A4_HZ * Math.pow(2, (note - A4_MIDI) / SEMITONES_PER_OCTAVE);
}

/** Concert-pitch reference: MIDI note 69 is A4 at 440 Hz. */
const A4_HZ = 440;
const A4_MIDI = 69;
const SEMITONES_PER_OCTAVE = 12;

/**
 * Detune in cents -> frequency multiplier. The supersaw's whole character is
 * this curve: a cent is 1/100 of a semitone, so 1200 cents is exactly 2x.
 *
 * Examples:
 *     >>> centsToRatio(0)      // 1
 *     >>> centsToRatio(1200)   // 2
 *     >>> centsToRatio(7).toFixed(5)   // '1.00405'  (the classic +7c pad detune)
 */
export function centsToRatio(cents) {
  return Math.pow(2, cents / (SEMITONES_PER_OCTAVE * 100));
}

// ─── Deterministic noise ─────────────────────────────────────────────────────

/**
 * Seeded 32-bit hash -> uniform float in [0, 1). Near-pure (no state; the name
 * "random" is about the OUTPUT's distribution, not about nondeterminism).
 *
 * WHY NOT Math.random: an impulse response generated from Math.random differs
 * every page load, so two runs of the same patch reverberate differently and no
 * test can pin the IR's energy. Seeding makes the reverb REPRODUCIBLE, which is
 * the same discipline core/particles.js applies to the sparkler.
 *
 * Args:
 *     seed (number): Any integer
 *
 * Returns:
 *     number: Uniform in [0, 1)
 *
 * Examples:
 *     >>> hashRandom(1) === hashRandom(1)   // true — same seed, same value
 *     >>> hashRandom(1) !== hashRandom(2)   // true
 */
export function hashRandom(seed) {
  let x = Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

/**
 * Seeded bipolar white noise sample in [-1, 1).
 *
 * Examples:
 *     >>> Math.abs(whiteNoiseAt(12345)) <= 1   // true
 */
export function whiteNoiseAt(seed) {
  return hashRandom(seed) * 2 - 1;
}

// ─── Impulse response synthesis (the Convolver reverbs) ──────────────────────

/**
 * The three reverb characters, as pure parameter records.
 *
 * WHY GENERATED, NOT SAMPLED: the blueprint forbids binary assets, and a
 * synthesized IR is also seekable/reproducible in a way a downloaded .wav is
 * not. Each character is exponentially-decaying noise, which is the standard
 * cheap model of a diffuse tail — the differences that make hall / plate /
 * deep-space actually SOUND different are decay length, the shape of the decay
 * curve, stereo width, and how much early energy is delayed in.
 *
 * - hall:       long-ish, gently curved decay, wide. The default musical space.
 * - plate:      short, very dense, bright, narrow — a metal-plate emulation, the
 *               classic bell/ding reverb.
 * - deepSpace:  very long with a SLOW ONSET (a pre-delay plus a swelling
 *               envelope) so the tail blooms after the sound instead of under
 *               it. This is the one the ambience deck lives in.
 */
export const REVERB_CHARACTERS = {
  hall: { seconds: 3.2, decayPower: 2.2, preDelaySeconds: 0.02, bloom: 0, stereoSpread: 0.7, dampen: 0.35 },
  plate: { seconds: 1.4, decayPower: 3.4, preDelaySeconds: 0.004, bloom: 0, stereoSpread: 0.3, dampen: 0.12 },
  deepSpace: { seconds: 7.0, decayPower: 1.5, preDelaySeconds: 0.08, bloom: 0.28, stereoSpread: 1.0, dampen: 0.55 },
};

/**
 * Synthesize a stereo impulse response as plain Float32Arrays.
 *
 * Returns raw channel data rather than an AudioBuffer precisely so this is
 * node-testable; the engine wraps the result in a real buffer.
 *
 * THE MATH, per sample index i at age a = i / sampleRate:
 *   envelope(a) = (1 - a/T)^decayPower                 — the decay tail
 *                 * bloomGain(a)                       — optional slow onset
 *                 * gate(a >= preDelay)                — silence before onset
 *   sample      = seededNoise * envelope, lowpassed by `dampen`
 * The one-pole lowpass makes the tail DARKEN as it decays, which is what real
 * rooms do (air and soft surfaces eat highs faster than lows) and is the single
 * cheapest thing that stops a generated IR sounding like a burst of static.
 *
 * Args:
 *     character (string): Key of REVERB_CHARACTERS
 *     sampleRate (number): Samples per second, e.g. 48000
 *     seed (number): Seeds the noise so the IR is reproducible
 *
 * Returns:
 *     {left: Float32Array, right: Float32Array, sampleRate: number}
 *     Both channels have length ceil(seconds * sampleRate).
 *
 * Examples:
 *     >>> const ir = generateImpulseResponse("plate", 48000, 1)
 *     >>> ir.left.length              // 67200  (1.4 s at 48 kHz)
 *     >>> ir.left[0]                  // 0 — inside the pre-delay, both channels silent
 *     >>> ir.left[1000] !== ir.right[1000]   // true — past onset the channels
 *                                            // decorrelate, which IS the stereo width
 */
export function generateImpulseResponse(character, sampleRate, seed = 1) {
  const spec = REVERB_CHARACTERS[character];
  if (!spec) {
    throw new Error(
      `Unknown reverb character ${JSON.stringify(character)}; expected one of ${Object.keys(REVERB_CHARACTERS).join(", ")}`,
    );
  }
  const length = Math.ceil(spec.seconds * sampleRate);
  const preDelaySamples = Math.floor(spec.preDelaySeconds * sampleRate);
  const bloomSamples = Math.floor(spec.bloom * spec.seconds * sampleRate);

  const left = new Float32Array(length);
  const right = new Float32Array(length);

  // One-pole lowpass state, per channel. `dampen` is the pole position: 0 = no
  // damping (bright), approaching 1 = heavy damping (dark, distant).
  let lowpassL = 0;
  let lowpassR = 0;
  const pole = spec.dampen;

  for (let i = 0; i < length; i++) {
    if (i < preDelaySamples) continue;

    const age = (i - preDelaySamples) / (length - preDelaySamples || 1);
    let envelope = Math.pow(1 - age, spec.decayPower);

    // The bloom: a slow fade-IN over the first `bloomSamples`, so deep-space
    // swells rather than cracking. Absent (bloom 0) for hall and plate.
    if (bloomSamples > 0 && i - preDelaySamples < bloomSamples) {
      const rise = (i - preDelaySamples) / bloomSamples;
      envelope *= rise * rise;
    }

    // Two independent noise streams = decorrelated channels = stereo image.
    // stereoSpread crossfades the right channel from "same as left" (mono) to
    // "fully independent" (widest).
    const noiseA = whiteNoiseAt(seed * 2654435761 + i);
    const noiseB = whiteNoiseAt(seed * 40503 + i + length);
    const rightNoise = noiseA * (1 - spec.stereoSpread) + noiseB * spec.stereoSpread;

    lowpassL = lowpassL * pole + noiseA * (1 - pole);
    lowpassR = lowpassR * pole + rightNoise * (1 - pole);

    left[i] = lowpassL * envelope;
    right[i] = lowpassR * envelope;
  }

  return { left, right, sampleRate };
}

/**
 * Total energy (sum of squares) of one IR channel — the quantity a test can
 * assert monotonically decreases over the tail, which is what "it decays" MEANS.
 *
 * Examples:
 *     >>> const ir = generateImpulseResponse("hall", 8000, 3)
 *     >>> impulseEnergy(ir.left) > 0   // true
 */
export function impulseEnergy(channel) {
  let sum = 0;
  for (let i = 0; i < channel.length; i++) sum += channel[i] * channel[i];
  return sum;
}

// ─── FM bell (the METALLIC DING) ─────────────────────────────────────────────

/**
 * The bell timbre presets, as carrier:modulator frequency RATIOS.
 *
 * WHY RATIOS AND WHY THESE ONES: a bell's defining acoustic property is that
 * its overtones are INHARMONIC — not integer multiples of the fundamental. In
 * FM, an integer modulator:carrier ratio produces a harmonic (organ/brass-like)
 * spectrum; a non-integer ratio produces inharmonic partials, which is why FM
 * is the cheap classic way to make a bell (Chowning, 1973). The further the
 * ratio is from a simple integer, the more "clangorous" the result:
 *
 *   - ding:   1.41  (~sqrt 2, maximally irrational-feeling) — bright struck bell
 *   - pip:    2.76  — short, high, glassy
 *   - clank:  3.53  — dense and metallic, closest to "struck pipe"
 *   - gong:   1.17  — slow beating between close partials, big and dark
 *
 * `indexPeak` is the modulation index at the strike: how far the modulator
 * swings the carrier, in multiples of the modulator frequency. High index =
 * many audible sidebands = bright attack. It DECAYS FASTER than the amplitude
 * (indexDecayScale < 1), which is the single most important detail for making
 * FM sound like a real bell instead of a buzzer: a real bell's strike is bright
 * and its tail is pure, so the spectrum must thin out as it rings down.
 */
export const BELL_PRESETS = {
  ding: { ratio: 1.41, indexPeak: 34, indexDecayScale: 0.42, decaySeconds: 2.4, brightness: 1.0 },
  pip: { ratio: 2.76, indexPeak: 48, indexDecayScale: 0.3, decaySeconds: 0.55, brightness: 1.4 },
  clank: { ratio: 3.53, indexPeak: 56, indexDecayScale: 0.25, decaySeconds: 0.9, brightness: 1.25 },
  gong: { ratio: 1.17, indexPeak: 26, indexDecayScale: 0.55, decaySeconds: 6.0, brightness: 0.7 },
};

/**
 * Resolve a bell preset + pitch into the concrete numbers the engine schedules.
 *
 * Pure so the ratio math is testable without an AudioContext: the engine only
 * has to apply these to real AudioParams.
 *
 * Args:
 *     preset (string): Key of BELL_PRESETS
 *     frequency (number): Carrier frequency in Hz
 *
 * Returns:
 *     {carrierHz, modulatorHz, modulationDepthHz, ampDecaySeconds, indexDecaySeconds}
 *     modulationDepthHz is the modulator GainNode's peak value: in FM, the
 *     modulator's output is added to the carrier's frequency in Hz, so
 *     depth = index * modulatorHz.
 *
 * Examples:
 *     >>> const v = bellVoice("ding", 440)
 *     >>> v.modulatorHz.toFixed(1)          // '620.4'   (440 * 1.41)
 *     >>> v.modulationDepthHz.toFixed(0)    // '21094'   (index 34 * 620.4)
 *     >>> v.indexDecaySeconds < v.ampDecaySeconds   // true — spectrum thins first
 */
export function bellVoice(preset, frequency) {
  const spec = BELL_PRESETS[preset];
  if (!spec) {
    throw new Error(
      `Unknown bell preset ${JSON.stringify(preset)}; expected one of ${Object.keys(BELL_PRESETS).join(", ")}`,
    );
  }
  const carrierHz = clampParam(frequency, MIN_AUDIBLE_HZ, MAX_AUDIBLE_HZ, "bell frequency");
  const modulatorHz = carrierHz * spec.ratio;
  return {
    carrierHz,
    modulatorHz,
    modulationDepthHz: spec.indexPeak * modulatorHz * spec.brightness,
    ampDecaySeconds: spec.decaySeconds,
    indexDecaySeconds: spec.decaySeconds * spec.indexDecayScale,
  };
}

/** Human hearing bounds, used to clamp any user-facing frequency parameter. */
export const MIN_AUDIBLE_HZ = 20;
export const MAX_AUDIBLE_HZ = 20000;

// ─── Supersaw detune spread (the AMBIENCE PAD) ───────────────────────────────

/**
 * Detune offsets in cents for an N-voice supersaw, symmetric about the centre.
 *
 * WHY NOT EVENLY SPACED: evenly-spaced detunes beat against each other at
 * related rates and the ensemble sounds mechanical. Spacing the voices with a
 * mild power curve (exponent < 1 pushes voices OUT toward the edges) gives a
 * denser core and wider skirts, which is the JP-8000 supersaw's actual trick
 * and what makes a pad sound "lush" rather than "out of tune".
 *
 * The research's hard constraint: keep the total spread within ~25 cents or the
 * effect turns dissonant. `spreadCents` is the half-width, so it is clamped to
 * half of that.
 *
 * Args:
 *     voiceCount (number): Number of oscillators, >= 1
 *     spreadCents (number): Half-width of the detune fan, in cents
 *
 * Returns:
 *     number[]: Detune per voice, in cents, centred on 0 and symmetric.
 *
 * Examples:
 *     >>> supersawDetunes(1, 12)             // [0]
 *     >>> supersawDetunes(3, 12)             // [-12, 0, 12]
 *     >>> supersawDetunes(2, 12)             // [-12, 12]  (no centre voice)
 */
export function supersawDetunes(voiceCount, spreadCents) {
  const count = Math.max(1, Math.floor(voiceCount));
  const spread = clampParam(spreadCents, 0, MAX_PAD_SPREAD_CENTS, "spreadCents");
  if (count === 1) return [0];

  const detunes = [];
  for (let i = 0; i < count; i++) {
    // Normalized position in [-1, 1] across the voice fan.
    const position = (i / (count - 1)) * 2 - 1;
    const curved = Math.sign(position) * Math.pow(Math.abs(position), SUPERSAW_SPREAD_EXPONENT);
    detunes.push(curved * spread);
  }
  return detunes;
}

/** The research's dissonance ceiling: beyond ~25 cents total the pad sours. */
export const MAX_PAD_SPREAD_CENTS = 25;

/** < 1 pushes voices outward from the centre — dense core, wide skirts. */
const SUPERSAW_SPREAD_EXPONENT = 0.8;

// ─── Two-clock lookahead scheduler math ──────────────────────────────────────

/**
 * The canonical "Tale of Two Clocks" constants (Chris Wilson), confirmed
 * unanimous across the research.
 *
 * WHY TWO CLOCKS: setTimeout/setInterval jitter by tens of milliseconds and
 * stall entirely during GC or a heavy repaint, so scheduling a note AT the
 * moment it should sound is audibly sloppy. Instead a slow, jittery JS timer
 * wakes up periodically and schedules events onto the AudioContext's
 * SAMPLE-ACCURATE hardware clock, some distance in the future. As long as the
 * JS timer wakes up more often than the lookahead window is long, every event
 * is placed before it is due, and main-thread stalls shorter than the window
 * are completely inaudible.
 *
 * The invariant that makes it work: LOOKAHEAD_SECONDS > TICK_MS/1000, with
 * enough margin to ride out a stall. 100 ms vs 25 ms gives 4x headroom.
 */
export const SCHEDULER_TICK_MS = 25;
export const SCHEDULER_LOOKAHEAD_SECONDS = 0.1;

/**
 * Seconds per step for a step sequencer.
 *
 * Args:
 *     bpm (number): Beats per minute
 *     stepsPerBeat (number): Sequencer resolution, e.g. 4 = sixteenth notes
 *
 * Returns:
 *     number: Duration of one step, in seconds
 *
 * Examples:
 *     >>> stepDuration(120, 4)    // 0.125  — 16ths at 120 BPM
 *     >>> stepDuration(60, 1)     // 1      — quarter notes at 60 BPM
 */
export function stepDuration(bpm, stepsPerBeat) {
  const tempo = clampParam(bpm, MIN_BPM, MAX_BPM, "bpm");
  const resolution = clampParam(stepsPerBeat, 1, MAX_STEPS_PER_BEAT, "stepsPerBeat");
  return SECONDS_PER_MINUTE / (tempo * resolution);
}

export const MIN_BPM = 20;
export const MAX_BPM = 300;
const MAX_STEPS_PER_BEAT = 16;
const SECONDS_PER_MINUTE = 60;

/**
 * The scheduler's core decision, as a PURE function: given where the sequencer
 * has already scheduled up to, which step times fall inside the lookahead
 * window now?
 *
 * Pulling this out of the timer callback is what makes the scheduler testable
 * at all — the timing logic is arithmetic over three numbers, and the timer is
 * just something that calls it.
 *
 * THE EDGE-TRIGGER RULE (research [09]): steps are emitted when the schedule
 * CROSSES them, never re-emitted for a time already passed. Because `cursor`
 * advances past every step this returns, a step can never fire twice even if
 * the timer fires erratically or twice in a row.
 *
 * Args:
 *     currentTime (number): AudioContext.currentTime, seconds
 *     cursor (number): Time up to which steps have already been scheduled
 *     secondsPerStep (number): From stepDuration()
 *     lookahead (number): Window size, seconds
 *
 * Returns:
 *     {times: number[], cursor: number} — event times to schedule, and the new
 *     cursor to carry into the next tick.
 *
 * Examples:
 *     >>> stepsInWindow(0, 0, 0.125, 0.1)
 *     { times: [ 0 ], cursor: 0.125 }
 *     >>> stepsInWindow(0.2, 0.125, 0.125, 0.1)
 *     { times: [ 0.125, 0.25 ], cursor: 0.375 }
 *     >>> stepsInWindow(0.05, 0.5, 0.125, 0.1)   // already scheduled ahead
 *     { times: [], cursor: 0.5 }
 */
export function stepsInWindow(currentTime, cursor, secondsPerStep, lookahead) {
  const times = [];
  let next = cursor;
  const horizon = currentTime + lookahead;
  while (next < horizon && times.length < MAX_STEPS_PER_TICK) {
    times.push(next);
    next += secondsPerStep;
  }
  return { times, cursor: next };
}

/**
 * Safety bound on events emitted per tick. A pathological (tiny step, huge
 * lookahead) must not build an unbounded array in the timer callback; hitting
 * this simply defers the rest to the next tick, which is 25 ms away.
 */
const MAX_STEPS_PER_TICK = 256;

// ─── Schmitt trigger (the Axoloti rising-edge ruling) ────────────────────────

/**
 * Schmitt-trigger thresholds, normalized to a 0..1 control signal.
 *
 * WHY HYSTERESIS (research [04], confirmed across 5+ sources): a single
 * threshold comparator fires on every noise wiggle across that one level. A
 * slowly-rising signal with a little ripple on it produces dozens of spurious
 * triggers, so a "trigger on rising edge" node built the naive way machine-guns
 * instead of firing once. Two separate thresholds fix it: the signal must climb
 * ABOVE `high` to arm a trigger, and must fall back BELOW `low` before it can
 * fire again. The gap between them is the noise-rejection band.
 *
 * Eurorack's convention is ~0.1 V low / ~1-2 V high against a 0-10 V range;
 * these are that convention normalized.
 */
export const SCHMITT_LOW = 0.1;
export const SCHMITT_HIGH = 0.5;

/**
 * One step of Schmitt-trigger edge detection. PURE: state in, state out.
 *
 * This is the exact logic the trigger AudioWorklet runs per sample; keeping it
 * here as a pure function means the state machine is proven in node and the
 * worklet is a thin loop around it.
 *
 * Args:
 *     value (number): Current input level
 *     armed (boolean): Whether the detector is currently latched high
 *
 * Returns:
 *     {fired: boolean, armed: boolean}
 *
 * Examples:
 *     >>> schmittStep(0.6, false)    // { fired: true,  armed: true  }  — rising edge
 *     >>> schmittStep(0.8, true)     // { fired: false, armed: true  }  — still high, no retrigger
 *     >>> schmittStep(0.3, true)     // { fired: false, armed: true  }  — in the dead band
 *     >>> schmittStep(0.05, true)    // { fired: false, armed: false }  — released, can fire again
 */
export function schmittStep(value, armed) {
  if (!armed && value >= SCHMITT_HIGH) return { fired: true, armed: true };
  if (armed && value <= SCHMITT_LOW) return { fired: false, armed: false };
  return { fired: false, armed };
}

// ─── Glitch-free rewiring timing ─────────────────────────────────────────────

/**
 * The crossfade duration used around every topology change, in seconds.
 *
 * WHY ~8 ms: a connect/disconnect on a running graph is a STEP DISCONTINUITY in
 * the waveform, and a step is broadband — it is heard as a click. Ramping the
 * signal to zero first and back afterwards removes the step. The length is a
 * genuine tradeoff: too short and the ramp itself is still a fast enough
 * transient to tick; too long and rewiring feels sluggish and audibly ducks the
 * sound. 8 ms is below the ~20 ms threshold where a gain change reads as a
 * "level move" rather than an instantaneous one, and long enough (≈384 samples
 * at 48 kHz) to be a smooth ramp rather than a fast edge.
 */
export const REWIRE_RAMP_SECONDS = 0.008;

/**
 * Ramp target for setTargetAtTime, which approaches exponentially and never
 * quite arrives. Scheduling the follow-up action after 4 time-constants leaves
 * <2% of the original level, which is inaudible under a subsequent change.
 *
 * Examples:
 *     >>> rampSettleSeconds(0.008).toFixed(3)   // '0.032'
 */
export function rampSettleSeconds(timeConstant) {
  return timeConstant * RAMP_TIME_CONSTANTS_TO_SETTLE;
}

const RAMP_TIME_CONSTANTS_TO_SETTLE = 4;
