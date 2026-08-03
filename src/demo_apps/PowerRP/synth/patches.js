/**
 * DEMO PATCHES — the library, built ONLY from the public engine API.
 *
 * These are deliberately not privileged: every one is a sequence of addModule /
 * connect / setParam calls that a caller could write themselves. That is the
 * point — if a patch needed something the API does not expose, the API would be
 * wrong. They double as the worked examples for NF-BIND, which will build the
 * same graphs from node-widget connections instead of from literals here.
 *
 * Each patch returns a handle with dispose(), so switching patches tears the
 * previous one down completely rather than layering sounds on top of each other.
 *
 * ── WHY THIS FILE IS THE PRIMARY UX, NOT A TEST FIXTURE (ADDENDUM 11) ────────
 * The user, on opening dev.html: "I don't really understand how to wire these
 * modules. Have an agent just make more demo patches on the dev site and these
 * can all carry over to their real website." So the patch library IS how the
 * synth is explored — a patch that does not sound good is a feature that does
 * not exist, and a patch that THROWS is worse than one that was never written,
 * because it makes the whole page look broken.
 *
 * Consequences that shape every patch below:
 *   - EVERY patch starts making sound the moment it is built. None requires a
 *     second gesture to become audible. (Where a patch has a one-shot — the
 *     whoosh — it ALSO has an idle bed, so the card is never silent.)
 *   - Every patch carries a `describe` sentence naming its own signal chain,
 *     because reading the chain is the lesson the wiring UI has not taught yet.
 *   - Anything that needs randomness uses a SEEDED generator, never
 *     Math.random: PowerRP's determinism law (CLAUDE.md, "the three kinds of
 *     state") applies to anything that will be lifted into the editor, and
 *     these will be.
 *
 * ── THE FOUR API QUIRKS EVERY PATCH HERE IS WRITTEN AGAINST ──────────────────
 * Learned by reading modules.js, and each one is a silent wrong-sound rather
 * than an exception if you get it wrong:
 *   1. DISCRETE PARAMS ARE SETTERS. `pad.frequency`, `supersaw.frequency`,
 *      `ding.frequency`, `filter.type`, `reverb.character`, `quantize.scale`
 *      are functions, not AudioParams. setParam works; paramNode THROWS. So an
 *      envelope can never target them — it targets `level`, `cutoff`, `Q`,
 *      `frequency` ON A FILTER, or a gain.
 *   2. ENVELOPES NEED paramNode, NOT REPEATED setParam. Successive setParam
 *      calls all land at the same currentTime and collide; see whoosh() below,
 *      where that was a real shipped bug.
 *   3. THERE IS EXACTLY ONE SCHEDULER, shared by the whole engine. Two
 *      sequenced patches cannot run at once — which is fine, because the page
 *      runs one patch at a time — but every sequenced patch MUST
 *      `scheduler.reset()` in dispose(), or the next patch inherits its tempo
 *      and step count.
 *   4. `trigger(id, port, time, {frequency})` is how a ding gets its pitch.
 *      setParam("frequency") sets the DEFAULT for later strikes; the option
 *      sets THIS strike. Sequenced patches want the option.
 */

/**
 * PAD DRONE — the ambience bed. One module does the work.
 *
 * The user's "harmonic ambience pad type synths in the background": patch the
 * pad into a meter into the output, and it is already spacey. Everything that
 * makes it move (the 0.06 Hz filter sweep, the detuned beating, the deep-space
 * reverb) is inside the pad module, which is what "a module that's just an
 * entire synth" means.
 *
 * Command. Returns a handle; call dispose() to remove it.
 */
export function padDrone(engine, options = {}) {
  const ids = ["patch-pad", "patch-meter", "patch-spectrum", "patch-out"];

  engine.addModule("pad", "patch-pad", {
    frequency: options.frequency ?? 82.41, // E2 — low enough to sit under speech
    level: 0.4,
    space: "deepSpace",
  });
  engine.addModule("meter", "patch-meter");
  engine.addModule("spectrum", "patch-spectrum");
  engine.addModule("output", "patch-out", { volume: 0.7 });

  engine.connect("patch-pad", "out", "patch-meter", "in");
  engine.connect("patch-meter", "out", "patch-spectrum", "in");
  engine.connect("patch-spectrum", "out", "patch-out", "in");

  return {
    ids,
    meterId: "patch-meter",
    spectrumId: "patch-spectrum",
    /** Command. Retune the drone, glided rather than stepped. */
    setPitch(frequency) {
      engine.setParam("patch-pad", "frequency", frequency, { rampSeconds: 0.4 });
    },
    dispose() {
      for (const id of ids) engine.removeModule(id);
    },
  };
}

/**
 * SEQUENCED DINGS — the clock -> sequencer -> bell chain, over the pad.
 *
 * This is the blueprint's acceptance patch: "clock → sequencer → ding". The
 * sequencer rides the engine's shared scheduler, so its timing is sample
 * accurate on the audio clock rather than on a JS timer.
 *
 * The pattern is a pentatonic scale, which is the cheap honest trick for
 * generative music: every note of a pentatonic scale is consonant with every
 * other, so a random or sparse pattern cannot produce a sour interval. Sparse
 * steps (rests) matter as much as the notes — a ding on every step is a
 * ringtone, while a ding every few steps is ambience.
 */
export function sequencedDings(engine, options = {}) {
  const ids = ["seq-clock", "seq-steps", "seq-ding", "seq-reverb", "seq-meter", "seq-spectrum", "seq-out"];

  // E-minor pentatonic across two octaves, with rests. MIDI note numbers.
  const pattern = options.pattern ?? [
    { on: true, note: 76 }, { on: false }, { on: true, note: 79 }, { on: false },
    { on: true, note: 83 }, { on: false }, { on: false }, { on: true, note: 88 },
    { on: false }, { on: true, note: 79 }, { on: false }, { on: false },
    { on: true, note: 74 }, { on: false }, { on: true, note: 71 }, { on: false },
  ];

  engine.addModule("clock", "seq-clock", { bpm: options.bpm ?? 72 });
  engine.addModule("sequencer", "seq-steps", { steps: pattern, stepCount: 16 });
  engine.addModule("ding", "seq-ding", { preset: options.preset ?? "ding", level: 0.42 });
  engine.addModule("reverb", "seq-reverb", { character: "plate", wet: 0.55, dry: 0.5 });
  engine.addModule("meter", "seq-meter");
  engine.addModule("spectrum", "seq-spectrum");
  engine.addModule("output", "seq-out", { volume: 0.7 });

  engine.connect("seq-ding", "out", "seq-reverb", "in");
  engine.connect("seq-reverb", "out", "seq-meter", "in");
  engine.connect("seq-meter", "out", "seq-spectrum", "in");
  engine.connect("seq-spectrum", "out", "seq-out", "in");

  // The sequencer's step events strike the bell. This is where a step becomes
  // a SOUND: the engine hands us (index, audioTime) and we trigger at that
  // exact time on the audio clock, never "now".
  const unsubscribe = engine.scheduler.onStep((index, time) => {
    const step = pattern[index % pattern.length];
    if (!step || step.on === false) return;
    engine.trigger("seq-ding", "gate", time, { frequency: midiFrequency(step.note) });
  });

  engine.scheduler.setTempo(options.bpm ?? 72, 2);
  engine.scheduler.setStepCount(pattern.length);
  engine.scheduler.start();

  return {
    ids,
    meterId: "seq-meter",
    spectrumId: "seq-spectrum",
    dispose() {
      unsubscribe();
      engine.scheduler.reset();
      for (const id of ids) engine.removeModule(id);
    },
  };
}

/** Local MIDI -> Hz. Duplicated from dsp.js deliberately: patches.js is an
 * EXAMPLE file, and an example that reaches into the library's internals
 * teaches the wrong thing. Two lines is cheaper than a bad lesson. */
function midiFrequency(note) {
  return 440 * Math.pow(2, (note - 69) / 12);
}

// ─── Shared helpers for the patch library ────────────────────────────────────

/**
 * Pure. A seeded 0..1 pseudo-random generator (mulberry32).
 *
 * WHY NOT Math.random: PowerRP's determinism law forbids it in anything that
 * renders (CLAUDE.md, "the three kinds of state" — Math.random is BLOCKED in
 * expressions outright). These patches are destined for the editor, where a
 * patch whose gulls cry at different moments on every render would make an
 * exported video unreproducible. Seeding costs one line and keeps the door open.
 *
 * Args:
 *     seed (number): Any integer. The same seed always yields the same stream.
 *
 * Returns:
 *     function: Call it for the next value in [0, 1).
 *
 * Examples:
 *     >>> const next = seededRandom(7)
 *     >>> next() === seededRandom(7)()      // true — same seed, same first draw
 *     >>> next() < 1 && next() >= 0         // true — always in [0, 1)
 */
function seededRandom(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Pure. Map a 0..1 draw onto an inclusive numeric range.
 *
 * Args:
 *     draw (number): A value in [0, 1), e.g. from seededRandom
 *     low (number): Range minimum
 *     high (number): Range maximum
 *
 * Returns:
 *     number
 *
 * Examples:
 *     >>> spread(0.5, 800, 1600)
 *     1200
 *     >>> spread(0, 800, 1600)
 *     800
 */
function spread(draw, low, high) {
  return low + draw * (high - low);
}

/**
 * Command. Build the standard tail of every patch: meter -> spectrum -> output.
 *
 * WHY A HELPER AND NOT COPY-PASTE: every patch needs these three modules for
 * dev.html's meter and spectrum to show anything, and the wiring order is the
 * one part of a patch that carries no sound-design information whatsoever.
 * Factoring it out means each patch below reads as its ACTUAL signal chain.
 *
 * The caller connects its own final module into `inputId`.
 *
 * Args:
 *     engine (object): The synth engine
 *     prefix (string): Unique per patch, so two patches never collide on ids
 *     volume (number): Master output volume, 0..1
 *
 * Returns:
 *     object: {ids, inputId, meterId, spectrumId} — spread into the patch handle
 *
 * Examples:
 *     >>> // const tail = outputTail(engine, "wind", 0.7)
 *     >>> // engine.connect("wind-reverb", "out", tail.inputId, "in")
 *     >>> // return { ids: [...myIds, ...tail.ids], meterId: tail.meterId, ... }
 */
function outputTail(engine, prefix, volume = 0.7) {
  const meterId = `${prefix}-meter`;
  const spectrumId = `${prefix}-spectrum`;
  const outId = `${prefix}-out`;

  engine.addModule("meter", meterId);
  engine.addModule("spectrum", spectrumId);
  engine.addModule("output", outId, { volume });

  engine.connect(meterId, "out", spectrumId, "in");
  engine.connect(spectrumId, "out", outId, "in");

  return { ids: [meterId, spectrumId, outId], inputId: meterId, meterId, spectrumId };
}

/**
 * Command. Fade an AudioParam up from silence over `seconds`.
 *
 * WHY EVERY SUSTAINED PATCH USES THIS: a drone that begins at full level starts
 * with a step discontinuity — the same broadband click the engine's guard gains
 * exist to prevent on a rewire, except this one is at the START of the sound
 * where it is most noticeable. The research is explicit that a drone's attack
 * should be a 5-10 s fade-in; shorter patches here use less, but never zero.
 *
 * Args:
 *     param (AudioParam): From engine.paramNode
 *     target (number): Level to arrive at
 *     seconds (number): Fade duration
 *     now (number): Audio-clock start time
 */
function fadeIn(param, target, seconds, now) {
  param.cancelScheduledValues(now);
  param.setValueAtTime(0, now);
  param.linearRampToValueAtTime(target, now + seconds);
}

// ─── AMBIENT ────────────────────────────────────────────────────────────────

/**
 * DEEP SPACE DRONE — near-static, cavernous, and deliberately almost boring.
 *
 * CHAIN: oscillator(sub sine) + supersaw(low, wide) -> mixer -> lowpass filter
 *        <- slow LFO on cutoff -> deepSpace reverb -> out
 *
 * ── WHAT MAKES A DRONE A DRONE RATHER THAN A LONG NOTE ───────────────────────
 * The research's rule for avoiding fatigue over ten minutes: NO periodic
 * pattern the ear can latch onto. A single LFO at a round rate fails that — the
 * ear finds the cycle within a minute and then hears a wobble instead of a
 * place. So the motion here comes from TWO LFOs at MUTUALLY IRRATIONAL rates
 * (0.037 and 0.061 Hz, deliberately not a ratio of small integers), summed into
 * one cutoff. Their beat period is many minutes long, which is longer than
 * anyone will listen, so the sweep never audibly repeats.
 *
 * The sub sine an octave below the saw stack is felt rather than heard; it is
 * what makes the patch read as SPACE rather than as a quiet pad. deepSpace is
 * the 7-second IR with a 0.28 bloom, so onsets swell instead of cracking.
 */
export function deepSpaceDrone(engine, options = {}) {
  const root = options.frequency ?? 55; // A1 — below the pad's E2, felt more than pitched.
  const ids = [
    "space-sub", "space-saw", "space-mix", "space-filter",
    "space-drift-a", "space-drift-b", "space-verb",
  ];

  engine.addModule("oscillator", "space-sub", { waveform: "sine", frequency: root / 2, level: 0.5 });
  engine.addModule("supersaw", "space-saw", { frequency: root, voices: 7, spread: 11, level: 0.16 });
  engine.addModule("mixer", "space-mix", { level1: 0.9, level2: 0.8, master: 0.9 });
  engine.addModule("filter", "space-filter", { type: "lowpass", frequency: DRONE_CUTOFF_HZ, Q: 2.5 });

  // The two mutually irrational drifts. Depths differ too, so neither is the
  // "main" one — summed, they never present a recognisable waveform.
  engine.addModule("lfo", "space-drift-a", { waveform: "sine", frequency: 0.037, depth: 220 });
  engine.addModule("lfo", "space-drift-b", { waveform: "triangle", frequency: 0.061, depth: 140 });
  engine.addModule("reverb", "space-verb", { character: "deepSpace", wet: 0.85, dry: 0.35, preDelay: 0.08 });

  const tail = outputTail(engine, "space", 0.7);
  ids.push(...tail.ids);

  engine.connect("space-sub", "out", "space-mix", "in1");
  engine.connect("space-saw", "out", "space-mix", "in2");
  engine.connect("space-mix", "out", "space-filter", "in");
  engine.connect("space-drift-a", "out", "space-filter", "frequency");
  engine.connect("space-drift-b", "out", "space-filter", "frequency");
  engine.connect("space-filter", "out", "space-verb", "in");
  engine.connect("space-verb", "out", tail.inputId, "in");

  const now = engine.context.currentTime;
  fadeIn(engine.paramNode("space-mix", "master"), 0.9, DRONE_FADE_SECONDS, now);

  return {
    ids,
    meterId: tail.meterId,
    spectrumId: tail.spectrumId,
    /** Command. Retune the whole drone, glided over several seconds — a drone
     * that steps to a new pitch stops being a drone. */
    setPitch(frequency) {
      engine.setParam("space-sub", "frequency", frequency / 2, { rampSeconds: 2 });
      engine.setParam("space-saw", "frequency", frequency, { rampSeconds: 2 });
    },
    dispose() {
      for (const id of ids) engine.removeModule(id);
    },
  };
}

/** Dark enough that the saws never bite; the drifts sweep around this. */
const DRONE_CUTOFF_HZ = 340;

/** The research's drone attack is 5-10 s. Six is long enough to feel like the
 * room was already there, short enough that a demo card is not dead on click. */
const DRONE_FADE_SECONDS = 6;

/**
 * SHIMMER PAD — the bright counterpart to the drone, with a slow filter bloom.
 *
 * CHAIN: pad(module) -> highshelf-lifted EQ3 -> ping-pong delay -> hall reverb -> out
 *
 * ── WHAT "BLOOM" MEANS AND WHY IT IS A ONE-SHOT RAMP, NOT AN LFO ─────────────
 * The pad module already has a 0.06 Hz LFO breathing its cutoff. Stacking a
 * second oscillating sweep on top would just muddy that. What this patch adds
 * instead is a single, non-repeating OPENING: the cutoff ramps from nearly
 * closed to wide over 12 seconds when the patch starts, and then stays there
 * with only the module's own breathing. That is the "bloom" — the sound arrives
 * rather than being switched on, and because it happens exactly once it can
 * never become a pattern the ear predicts.
 *
 * The EQ3's high shelf is what separates this from padDrone: +6 dB above
 * 3.6 kHz turns the same saw stack from "behind you" into "above you".
 */
export function shimmerPad(engine, options = {}) {
  const ids = ["shimmer-pad", "shimmer-eq", "shimmer-delay", "shimmer-verb"];

  engine.addModule("pad", "shimmer-pad", {
    frequency: options.frequency ?? 110, // A2 — an octave over the deep drone.
    level: 0.3,
    cutoff: SHIMMER_CLOSED_HZ,
    motion: 0.05,
    space: "hall",
    reverb: 0.4,
  });
  engine.addModule("eq3", "shimmer-eq", { low: -3, mid: -2, high: 6, highFrequency: 3600 });
  engine.addModule("delay", "shimmer-delay", {
    time: 0.66, feedback: 0.44, damping: 3200, wet: 0.4, dry: 0.9,
  });
  engine.addModule("reverb", "shimmer-verb", { character: "hall", wet: 0.6, dry: 0.6 });

  const tail = outputTail(engine, "shimmer", 0.7);
  ids.push(...tail.ids);

  engine.connect("shimmer-pad", "out", "shimmer-eq", "in");
  engine.connect("shimmer-eq", "out", "shimmer-delay", "in");
  engine.connect("shimmer-delay", "out", "shimmer-verb", "in");
  engine.connect("shimmer-verb", "out", tail.inputId, "in");

  // THE BLOOM. Exponential, not linear: cutoff is perceived logarithmically, so
  // a linear ramp spends most of its time in the top octave where almost
  // nothing changes audibly, and the opening sounds like it stalls.
  const now = engine.context.currentTime;
  const cutoff = engine.paramNode("shimmer-pad", "cutoff");
  cutoff.cancelScheduledValues(now);
  cutoff.setValueAtTime(SHIMMER_CLOSED_HZ, now);
  cutoff.exponentialRampToValueAtTime(SHIMMER_OPEN_HZ, now + SHIMMER_BLOOM_SECONDS);

  fadeIn(engine.paramNode("shimmer-pad", "level"), 0.3, SHIMMER_FADE_SECONDS, now);

  return {
    ids,
    meterId: tail.meterId,
    spectrumId: tail.spectrumId,
    /** Command. Retune. The pad's frequency is a SETTER that fans out to every
     * detuned voice plus the sub — hence setParam, not paramNode. */
    setPitch(frequency) {
      engine.setParam("shimmer-pad", "frequency", frequency, { rampSeconds: 1.2 });
    },
    dispose() {
      for (const id of ids) engine.removeModule(id);
    },
  };
}

const SHIMMER_CLOSED_HZ = 220;
const SHIMMER_OPEN_HZ = 2600;

/** Long enough to be a journey rather than a filter envelope. */
const SHIMMER_BLOOM_SECONDS = 12;
const SHIMMER_FADE_SECONDS = 4;

/**
 * WIND — filtered noise, gently swept. The simplest patch here, on purpose.
 *
 * CHAIN: noise(pink) -> bandpass filter <- LFO on cutoff -> hall reverb -> out
 *
 * ── WHY BANDPASS AND NOT LOWPASS ─────────────────────────────────────────────
 * Lowpassed noise is a rumble; wind has a defined pitch centre that rises and
 * falls, which is a BAND moving, not a ceiling moving. Q around 2 is the whole
 * trick: below 1 the band is too wide to have a pitch at all, above ~6 it
 * starts to whistle like the whoosh patch, which is a different sound.
 *
 * PINK, not white: pink noise falls at 3 dB/octave, which is roughly how real
 * broadband natural sound distributes its energy. White noise through the same
 * filter sounds like radio static because its top octave carries as much power
 * as everything below it combined.
 */
export function wind(engine, options = {}) {
  const ids = ["wind-noise", "wind-filter", "wind-gust", "wind-verb"];

  engine.addModule("noise", "wind-noise", { color: "pink", level: 0.34, seed: 5 });
  engine.addModule("filter", "wind-filter", { type: "bandpass", frequency: WIND_CENTRE_HZ, Q: 2.2 });
  engine.addModule("lfo", "wind-gust", {
    waveform: "sine",
    frequency: options.gustRate ?? 0.09, // ~11 s per gust — a breeze, not a fan.
    depth: WIND_GUST_DEPTH_HZ,
  });
  engine.addModule("reverb", "wind-verb", { character: "hall", wet: 0.4, dry: 0.85 });

  const tail = outputTail(engine, "wind", 0.7);
  ids.push(...tail.ids);

  engine.connect("wind-noise", "out", "wind-filter", "in");
  engine.connect("wind-gust", "out", "wind-filter", "frequency");
  engine.connect("wind-filter", "out", "wind-verb", "in");
  engine.connect("wind-verb", "out", tail.inputId, "in");

  const now = engine.context.currentTime;
  fadeIn(engine.paramNode("wind-noise", "level"), 0.34, WIND_FADE_SECONDS, now);

  return {
    ids,
    meterId: tail.meterId,
    spectrumId: tail.spectrumId,
    /**
     * Command. How hard it blows. Raises the band centre and the gust depth
     * together, because a stronger wind is both brighter AND more variable —
     * moving only one of them sounds like a filter knob, not like weather.
     *
     * Args:
     *     strength (number): 0 = a draught, 1 = a gale
     */
    setStrength(strength) {
      const level = Math.min(1, Math.max(0, strength));
      engine.setParam("wind-filter", "frequency", WIND_CENTRE_HZ + level * WIND_STRENGTH_RANGE_HZ, {
        rampSeconds: 1.5,
      });
      engine.setParam("wind-gust", "depth", WIND_GUST_DEPTH_HZ * (1 + level * 2), { rampSeconds: 1.5 });
      engine.setParam("wind-noise", "level", 0.26 + level * 0.3, { rampSeconds: 1.5 });
    },
    dispose() {
      for (const id of ids) engine.removeModule(id);
    },
  };
}

const WIND_CENTRE_HZ = 520;
const WIND_GUST_DEPTH_HZ = 300;
const WIND_STRENGTH_RANGE_HZ = 900;
const WIND_FADE_SECONDS = 3;

/**
 * HEARTBEAT SUB — a slow, deep, hypnotic pulse. Felt more than heard.
 *
 * CHAIN: oscillator(sine ~48 Hz) -> VCA <- scheduled gain envelope
 *        -> lowpass -> hall reverb -> out
 *        (scheduler drives the LUB-DUB pair)
 *
 * ── WHY IT IS TWO BEATS AND NOT ONE ──────────────────────────────────────────
 * A single periodic thump is a kick drum. A heart is a PAIR — lub-dub — with
 * the second beat softer and following closely (~0.30 s here), then a long
 * gap. That asymmetry is the entire difference between "pulse" and "heartbeat",
 * and it costs one extra scheduled envelope.
 *
 * The envelope is drawn on the VCA's gain with paramNode rather than by
 * triggering an ADSR, because each beat is a ONE-SHOT SHAPE at a known future
 * time — exactly what scheduled automation is for. An ADSR worklet would be the
 * right choice if the gate came from a wire; here it comes from the scheduler.
 *
 * The pitch DROPS slightly during each beat (60 -> 42 Hz). Every real
 * percussive resonator does this as its tension releases, and without it a sine
 * thump sounds like a test tone being switched on and off.
 */
export function heartbeatSub(engine, options = {}) {
  const ids = ["heart-osc", "heart-vca", "heart-filter", "heart-verb"];
  const bpm = options.bpm ?? 46; // Resting-to-slow. Faster reads as anxious.

  engine.addModule("oscillator", "heart-osc", { waveform: "sine", frequency: HEART_PITCH_HZ, level: 0.9 });
  engine.addModule("vca", "heart-vca", { gain: 0 });
  engine.addModule("filter", "heart-filter", { type: "lowpass", frequency: 160, Q: 1.2 });
  engine.addModule("reverb", "heart-verb", { character: "hall", wet: 0.3, dry: 0.9 });

  const tail = outputTail(engine, "heart", 0.8);
  ids.push(...tail.ids);

  engine.connect("heart-osc", "out", "heart-vca", "in");
  engine.connect("heart-vca", "out", "heart-filter", "in");
  engine.connect("heart-filter", "out", "heart-verb", "in");
  engine.connect("heart-verb", "out", tail.inputId, "in");

  const amplitude = engine.paramNode("heart-vca", "gain");
  const pitch = engine.paramNode("heart-osc", "frequency");

  /** Command. Schedule one thump at an audio-clock time. */
  function beat(time, strength) {
    amplitude.setValueAtTime(0, time);
    amplitude.linearRampToValueAtTime(strength, time + HEART_ATTACK_SECONDS);
    amplitude.exponentialRampToValueAtTime(HEART_FLOOR, time + HEART_DECAY_SECONDS);
    // The tension-release pitch drop.
    pitch.setValueAtTime(HEART_PITCH_HZ, time);
    pitch.exponentialRampToValueAtTime(HEART_PITCH_FLOOR_HZ, time + HEART_DECAY_SECONDS);
  }

  // One pattern step per beat; the lub is on the downbeat, the dub is scheduled
  // as an OFFSET from it rather than as its own step, because the gap between
  // them is fixed in seconds and must not stretch with tempo.
  const unsubscribe = engine.scheduler.onStep((index, time) => {
    if (index % HEART_STEPS_PER_CYCLE !== 0) return;
    beat(time, HEART_LUB_LEVEL);
    beat(time + HEART_DUB_OFFSET_SECONDS, HEART_DUB_LEVEL);
  });

  engine.scheduler.setTempo(bpm, 1);
  engine.scheduler.setStepCount(HEART_STEPS_PER_CYCLE);
  engine.scheduler.start();

  return {
    ids,
    meterId: tail.meterId,
    spectrumId: tail.spectrumId,
    /** Command. Change the rate. A heart that speeds up is the whole reason
     * this patch is interesting for a presentation. */
    setBpm(nextBpm) {
      engine.scheduler.setTempo(nextBpm, 1);
    },
    dispose() {
      unsubscribe();
      engine.scheduler.reset();
      for (const id of ids) engine.removeModule(id);
    },
  };
}

const HEART_PITCH_HZ = 60;
const HEART_PITCH_FLOOR_HZ = 42;
const HEART_ATTACK_SECONDS = 0.012;
const HEART_DECAY_SECONDS = 0.34;

/** exponentialRamp cannot reach zero; this is ~66 dB down. */
const HEART_FLOOR = 0.0005;

const HEART_LUB_LEVEL = 0.95;

/** The dub is quieter than the lub — that inequality is what makes the pair
 * read as one heartbeat rather than as two separate thumps. */
const HEART_DUB_LEVEL = 0.6;
const HEART_DUB_OFFSET_SECONDS = 0.3;

/** One beat per cycle; the other steps are the rest between beats. */
const HEART_STEPS_PER_CYCLE = 1;

// ─── PERCUSSION ─────────────────────────────────────────────────────────────

/**
 * CATHEDRAL BELLS — sparse, slow, enormous. The sound of a room, not a bell.
 *
 * CHAIN: scheduler -> ding(gong preset) -> deepSpace reverb (wet-dominant) -> out
 *
 * ── SPARSITY IS THE DESIGN, NOT A SETTING ────────────────────────────────────
 * At 30 BPM with only four struck steps in sixteen, a note lands roughly every
 * eight seconds. That is slow enough that the 6-second gong tail has nearly
 * finished before the next strike, so what the listener hears is mostly REVERB
 * — which is the point. A bell every two seconds is a clock tower; a bell every
 * eight is a cathedral you are standing in.
 *
 * The reverb runs wet 0.9 / dry 0.35 — unusually wet, deliberately. Bells are
 * the one source where the direct sound is the least interesting part.
 *
 * The pattern is a low pentatonic voicing spanning an octave and a half. Because
 * every interval in a pentatonic scale is consonant with every other, strikes
 * whose tails overlap can never produce a sour chord, no matter which pair
 * happens to collide.
 */
export function cathedralBells(engine, options = {}) {
  const ids = ["bell-ding", "bell-verb"];

  // A2 pentatonic, low and wide. Rests dominate — see the sparsity note.
  const pattern = options.pattern ?? [
    { on: true, note: 45 }, { on: false }, { on: false }, { on: false },
    { on: true, note: 52 }, { on: false }, { on: false }, { on: false },
    { on: true, note: 57 }, { on: false }, { on: false }, { on: false },
    { on: true, note: 50 }, { on: false }, { on: false }, { on: false },
  ];

  engine.addModule("ding", "bell-ding", { preset: "gong", level: 0.5 });
  engine.addModule("reverb", "bell-verb", { character: "deepSpace", wet: 0.9, dry: 0.35, preDelay: 0.05 });

  const tail = outputTail(engine, "bell", 0.75);
  ids.push(...tail.ids);

  engine.connect("bell-ding", "out", "bell-verb", "in");
  engine.connect("bell-verb", "out", tail.inputId, "in");

  const unsubscribe = engine.scheduler.onStep((index, time) => {
    const step = pattern[index % pattern.length];
    if (!step || step.on === false) return;
    engine.trigger("bell-ding", "gate", time, { frequency: midiFrequency(step.note) });
  });

  engine.scheduler.setTempo(options.bpm ?? 30, 1);
  engine.scheduler.setStepCount(pattern.length);
  engine.scheduler.start();

  return {
    ids,
    meterId: tail.meterId,
    spectrumId: tail.spectrumId,
    dispose() {
      unsubscribe();
      engine.scheduler.reset();
      for (const id of ids) engine.removeModule(id);
    },
  };
}

/**
 * PIPS & POPS — short digital blips with a bitcrushed edge, sparse and irregular.
 *
 * CHAIN: scheduler(seeded gate) -> ding(pip preset) -> bitcrush -> highpass
 *        -> plate reverb -> out
 *
 * ── WHY THE RHYTHM IS SEEDED-RANDOM AND NOT A WRITTEN PATTERN ────────────────
 * The user asked for "a pip or a pop" as PUNCTUATION — things that happen, not
 * things that keep time. A 16-step written pattern always reveals its loop
 * within about twenty seconds, at which point it stops being punctuation and
 * becomes a beat. Drawing each step's on/off from a seeded generator with a
 * 22% hit probability produces a stream that never audibly repeats while
 * remaining perfectly reproducible for an exported render (see seededRandom).
 *
 * BITCRUSH is what makes these digital rather than musical: at 6 bits with 4x
 * sample-rate reduction, the quantization error is loud enough to hear as grit
 * on the attack and as aliasing in the tail. That is the "pip" character, and
 * it is why this patch uses the crusher while Metallic Clanks does not.
 *
 * The highpass at 400 Hz is not decoration: crushing adds low-frequency
 * quantization noise that would otherwise pile up as a dull thud under every
 * blip.
 */
export function pipsAndPops(engine, options = {}) {
  const ids = ["pip-ding", "pip-crush", "pip-highpass", "pip-verb"];
  const draw = seededRandom(options.seed ?? 20260803);

  // The scale the random pitches snap to — pentatonic, two octaves up, so
  // colliding pips stay consonant for the same reason the bells do.
  const notes = options.notes ?? [72, 74, 77, 79, 84, 86, 89];

  engine.addModule("ding", "pip-ding", { preset: "pip", level: 0.34 });
  engine.addModule("bitcrush", "pip-crush", { bits: 6, reduction: 4 });
  engine.addModule("filter", "pip-highpass", { type: "highpass", frequency: 400, Q: 0.7 });
  engine.addModule("reverb", "pip-verb", { character: "plate", wet: 0.45, dry: 0.8 });

  const tail = outputTail(engine, "pip", 0.7);
  ids.push(...tail.ids);

  engine.connect("pip-ding", "out", "pip-crush", "in");
  engine.connect("pip-crush", "out", "pip-highpass", "in");
  engine.connect("pip-highpass", "out", "pip-verb", "in");
  engine.connect("pip-verb", "out", tail.inputId, "in");

  const unsubscribe = engine.scheduler.onStep((index, time) => {
    if (draw() > PIP_HIT_PROBABILITY) return;
    const note = notes[Math.floor(draw() * notes.length)];
    engine.trigger("pip-ding", "gate", time, { frequency: midiFrequency(note) });
  });

  engine.scheduler.setTempo(options.bpm ?? 96, 2);
  engine.scheduler.setStepCount(PIP_STEP_COUNT);
  engine.scheduler.start();

  return {
    ids,
    meterId: tail.meterId,
    spectrumId: tail.spectrumId,
    /**
     * Command. How mangled the blips are. One knob spanning "clean digital
     * chirp" to "broken transmission".
     *
     * Args:
     *     amount (number): 0 = 12-bit and nearly clean, 1 = 3-bit and rough
     */
    setCrush(amount) {
      const level = Math.min(1, Math.max(0, amount));
      engine.setParam("pip-crush", "bits", CRUSH_MAX_BITS - level * (CRUSH_MAX_BITS - CRUSH_MIN_BITS));
      engine.setParam("pip-crush", "reduction", 1 + level * CRUSH_MAX_REDUCTION);
    },
    dispose() {
      unsubscribe();
      engine.scheduler.reset();
      for (const id of ids) engine.removeModule(id);
    },
  };
}

/** Roughly one blip every four steps — sparse enough to read as punctuation. */
const PIP_HIT_PROBABILITY = 0.22;

/** A long cycle so even the gate pattern's own period is beyond notice. */
const PIP_STEP_COUNT = 64;

const CRUSH_MAX_BITS = 12;
const CRUSH_MIN_BITS = 3;
const CRUSH_MAX_REDUCTION = 11;

/**
 * METALLIC CLANKS — inharmonic hits, band-passed, and DRY. Industrial, close by.
 *
 * CHAIN: scheduler -> ding(clank preset) -> bandpass(Q 4) -> EQ3(mid boost)
 *        -> plate reverb, mostly dry -> out
 *
 * ── WHY THIS PATCH IS DRY WHEN EVERY OTHER ONE IS WET ────────────────────────
 * Reverb tells the ear how FAR AWAY a sound is. The bells patch is drenched
 * because a cathedral bell is a hundred metres off; a clank is something
 * hitting metal an arm's length from you, and drowning it in a tail turns it
 * into a bell — which the library already has. So: wet 0.18, dry 1.0, plate
 * (1.4 s) rather than deepSpace (7 s). The reverb is there only to stop it
 * sounding like it was recorded in an anechoic chamber.
 *
 * The `clank` preset's 3.53 carrier:modulator ratio is deeply inharmonic, which
 * is what makes it read as struck metal rather than as a note. The bandpass at
 * 1.6 kHz with Q 4 emphasises the band where that inharmonicity lives — without
 * it, the fundamental dominates and the clank sounds like a woodblock.
 *
 * Pitches are drawn (seeded) from a WIDE, deliberately non-scalar set: real
 * struck metal has no key, and quantizing these to a scale makes them sound
 * like a mallet instrument.
 */
export function metallicClanks(engine, options = {}) {
  const ids = ["clank-ding", "clank-band", "clank-eq", "clank-verb"];
  const draw = seededRandom(options.seed ?? 4711);

  engine.addModule("ding", "clank-ding", { preset: "clank", level: 0.4 });
  engine.addModule("filter", "clank-band", { type: "bandpass", frequency: CLANK_BAND_HZ, Q: 4 });
  engine.addModule("eq3", "clank-eq", { low: -6, mid: 5, midFrequency: 2400, midQ: 1.1, high: 2 });
  engine.addModule("reverb", "clank-verb", { character: "plate", wet: 0.18, dry: 1 });

  const tail = outputTail(engine, "clank", 0.7);
  ids.push(...tail.ids);

  engine.connect("clank-ding", "out", "clank-band", "in");
  engine.connect("clank-band", "out", "clank-eq", "in");
  engine.connect("clank-eq", "out", "clank-verb", "in");
  engine.connect("clank-verb", "out", tail.inputId, "in");

  const unsubscribe = engine.scheduler.onStep((index, time) => {
    if (draw() > CLANK_HIT_PROBABILITY) return;
    engine.trigger("clank-ding", "gate", time, {
      frequency: spread(draw(), CLANK_LOW_HZ, CLANK_HIGH_HZ),
    });
    // Move the band with the strike, so successive clanks are not all filtered
    // through the same resonance — a fixed band makes every hit sound like the
    // same object being struck twice.
    engine.setParam("clank-band", "frequency", spread(draw(), CLANK_BAND_HZ * 0.7, CLANK_BAND_HZ * 1.8));
  });

  engine.scheduler.setTempo(options.bpm ?? 84, 2);
  engine.scheduler.setStepCount(CLANK_STEP_COUNT);
  engine.scheduler.start();

  return {
    ids,
    meterId: tail.meterId,
    spectrumId: tail.spectrumId,
    /** Command. Strike one clank right now, at a drawn pitch — the card's
     * "hit it" button, so the patch is not only a waiting game. */
    strike() {
      engine.trigger("clank-ding", "gate", undefined, {
        frequency: spread(draw(), CLANK_LOW_HZ, CLANK_HIGH_HZ),
      });
    },
    dispose() {
      unsubscribe();
      engine.scheduler.reset();
      for (const id of ids) engine.removeModule(id);
    },
  };
}

const CLANK_BAND_HZ = 1600;
const CLANK_LOW_HZ = 180;
const CLANK_HIGH_HZ = 720;
const CLANK_HIT_PROBABILITY = 0.3;
const CLANK_STEP_COUNT = 32;

/**
 * ARP CASCADE — a fast pentatonic arpeggio smeared into a spacey wash.
 *
 * CHAIN: scheduler -> ding(ding preset) -> ping-pong delay (dotted-eighth)
 *        -> deepSpace reverb -> out
 *
 * ── THE DOTTED-EIGHTH DELAY IS THE WHOLE PATCH ───────────────────────────────
 * The arpeggio itself is sixteenth notes. The delay is set to a DOTTED EIGHTH
 * (three sixteenths) of the same tempo, which means each repeat lands between
 * the played notes rather than on top of them. The result is a denser pattern
 * than was played, in a cross-rhythm against it — this is the oldest trick in
 * ambient guitar (The Edge's entire sound) and it works identically here.
 * Because the delay time is DERIVED from the tempo rather than typed in, the
 * relationship survives a tempo change.
 *
 * Ping-pong sends alternate repeats to alternate ears, so the cascade also
 * moves across the stereo field as it decays.
 *
 * The pattern climbs and falls rather than looping in one direction: a rising
 * arpeggio that resets is heard as a repeating figure, while one that turns
 * around is heard as motion.
 */
export function arpCascade(engine, options = {}) {
  const ids = ["arp-ding", "arp-delay", "arp-verb"];
  const bpm = options.bpm ?? 104;

  // E-minor pentatonic, up then down, spanning two octaves.
  const pattern = options.pattern ?? [
    64, 67, 71, 74, 76, 79, 83, 86,
    83, 79, 76, 74, 71, 67, 64, 62,
  ].map((note) => ({ on: true, note }));

  engine.addModule("ding", "arp-ding", { preset: "ding", level: 0.3 });
  engine.addModule("delay", "arp-delay", {
    time: dottedEighthSeconds(bpm),
    feedback: 0.55,
    damping: 2400,
    wet: 0.5,
    dry: 0.85,
  });
  engine.addModule("reverb", "arp-verb", { character: "deepSpace", wet: 0.6, dry: 0.7 });

  const tail = outputTail(engine, "arp", 0.65);
  ids.push(...tail.ids);

  engine.connect("arp-ding", "out", "arp-delay", "in");
  engine.connect("arp-delay", "out", "arp-verb", "in");
  engine.connect("arp-verb", "out", tail.inputId, "in");

  const unsubscribe = engine.scheduler.onStep((index, time) => {
    const step = pattern[index % pattern.length];
    if (!step || step.on === false) return;
    engine.trigger("arp-ding", "gate", time, { frequency: midiFrequency(step.note) });
  });

  engine.scheduler.setTempo(bpm, 4);
  engine.scheduler.setStepCount(pattern.length);
  engine.scheduler.start();

  return {
    ids,
    meterId: tail.meterId,
    spectrumId: tail.spectrumId,
    /** Command. Change tempo, keeping the delay locked to the dotted eighth —
     * the cross-rhythm is the patch, so it must survive the knob. */
    setBpm(nextBpm) {
      engine.scheduler.setTempo(nextBpm, 4);
      engine.setParam("arp-delay", "time", dottedEighthSeconds(nextBpm), { rampSeconds: 0.3 });
    },
    dispose() {
      unsubscribe();
      engine.scheduler.reset();
      for (const id of ids) engine.removeModule(id);
    },
  };
}

/**
 * Pure. Seconds per dotted eighth note at a tempo — three sixteenths.
 *
 * Args:
 *     bpm (number): Beats (quarter notes) per minute
 *
 * Returns:
 *     number: Duration in seconds
 *
 * Examples:
 *     >>> dottedEighthSeconds(120)      // a quarter is 0.5 s, so three sixteenths:
 *     0.375
 *     >>> dottedEighthSeconds(104).toFixed(3)
 *     '0.433'
 */
function dottedEighthSeconds(bpm) {
  return (60 / bpm) * 0.75;
}

/**
 * BEACH — synthesized surf with seagulls. The most ambitious patch here, and
 * the one whose honest assessment matters most.
 *
 * CHAIN (two voices into one mixer):
 *   waves: noise(brown-ish pink) -> lowpass filter <- two slow LFOs on cutoff
 *          AND a swell envelope on level -> mixer.in1
 *   gulls: ding(pip preset, retuned per cry) with a scheduled pitch sweep
 *          -> bandpass -> mixer.in2
 *   mixer -> hall reverb -> out
 *
 * ── HOW CONVINCING IS IT, HONESTLY ───────────────────────────────────────────
 * The WAVES are good. Slow-swept filtered noise is genuinely how surf is
 * synthesized, and the two-LFO irrational-rate trick from the drone patch means
 * the swells arrive at uneven intervals like real ones do. What it lacks is the
 * gravelly high-frequency detail of water on shingle, which needs a second
 * noise layer gated by the swell — a refinement, not a correction.
 *
 * The GULLS are a caricature and should be heard as one. A real gull cry is a
 * pitch-swept formant with a rasp; what this builds is an FM pip whose pitch
 * sweeps down over ~200 ms, which lands somewhere between "gull" and
 * "electronic bird". It reads correctly IN CONTEXT — over the surf bed, the ear
 * accepts it — and is unconvincing in isolation. The missing ingredient is the
 * rasp: real cries are amplitude-modulated at 30-80 Hz, which the ding module
 * has no input for. Doing it properly needs an oscillator into a VCA's gain at
 * audio rate, which is a different (and much larger) patch.
 *
 * The gull SPACING is Poisson-like — drawn from a seeded generator so cries
 * cluster and then leave long gaps, which is what real ones do. Evenly spaced
 * cries destroy the illusion faster than the timbre does.
 */
export function beach(engine, options = {}) {
  const ids = [
    "beach-surf", "beach-lowpass", "beach-swell-a", "beach-swell-b",
    "beach-gull", "beach-gull-band", "beach-mix", "beach-verb",
  ];
  const draw = seededRandom(options.seed ?? 1907);

  // ── The surf bed ──────────────────────────────────────────────────────────
  engine.addModule("noise", "beach-surf", { color: "pink", level: 0.44, seed: 3 });
  engine.addModule("filter", "beach-lowpass", { type: "lowpass", frequency: SURF_CENTRE_HZ, Q: 3 });
  // Irrational rates again: swells at 0.043 and 0.071 Hz never line up, so no
  // two waves are the same size and the sequence never repeats.
  engine.addModule("lfo", "beach-swell-a", { waveform: "sine", frequency: 0.043, depth: SURF_SWELL_DEPTH_HZ });
  engine.addModule("lfo", "beach-swell-b", { waveform: "sine", frequency: 0.071, depth: SURF_SWELL_DEPTH_HZ * 0.6 });

  // ── The gulls ─────────────────────────────────────────────────────────────
  engine.addModule("ding", "beach-gull", { preset: "pip", level: 0.16 });
  engine.addModule("filter", "beach-gull-band", { type: "bandpass", frequency: 1400, Q: 1.8 });

  engine.addModule("mixer", "beach-mix", { level1: 1, level2: 0.85, master: 0.9 });
  engine.addModule("reverb", "beach-verb", { character: "hall", wet: 0.35, dry: 0.9 });

  const tail = outputTail(engine, "beach", 0.75);
  ids.push(...tail.ids);

  engine.connect("beach-surf", "out", "beach-lowpass", "in");
  engine.connect("beach-swell-a", "out", "beach-lowpass", "frequency");
  engine.connect("beach-swell-b", "out", "beach-lowpass", "frequency");
  engine.connect("beach-lowpass", "out", "beach-mix", "in1");

  engine.connect("beach-gull", "out", "beach-gull-band", "in");
  engine.connect("beach-gull-band", "out", "beach-mix", "in2");

  engine.connect("beach-mix", "out", "beach-verb", "in");
  engine.connect("beach-verb", "out", tail.inputId, "in");

  // The surf's LEVEL swells too, not only its brightness. A wave that only gets
  // brighter sounds like a filter; one that gets brighter AND louder together
  // sounds like it is approaching.
  const surfLevel = engine.paramNode("beach-surf", "level");
  const now = engine.context.currentTime;
  fadeIn(surfLevel, 0.44, BEACH_FADE_SECONDS, now);

  // ── Gull scheduling: cluster, then leave gaps ─────────────────────────────
  // A cry is TWO pips a moment apart, because gulls call in pairs; a single
  // isolated chirp reads as a smoke alarm.
  const bandFrequency = engine.paramNode("beach-gull-band", "frequency");

  function cry(time) {
    const pitch = spread(draw(), GULL_LOW_HZ, GULL_HIGH_HZ);
    engine.trigger("beach-gull", "gate", time, { frequency: pitch });
    // The downward sweep of the band is what suggests a falling cry; the ding's
    // own pitch cannot be automated (it is a setter), so the FILTER does the
    // gliding. That is a genuine limitation, stated plainly in the header.
    bandFrequency.cancelScheduledValues(time);
    bandFrequency.setValueAtTime(pitch * GULL_BAND_RATIO, time);
    bandFrequency.exponentialRampToValueAtTime(pitch * GULL_BAND_FALL, time + GULL_SWEEP_SECONDS);
    if (draw() < GULL_DOUBLE_PROBABILITY) {
      engine.trigger("beach-gull", "gate", time + GULL_PAIR_GAP_SECONDS, { frequency: pitch * 0.94 });
    }
  }

  const unsubscribe = engine.scheduler.onStep((index, time) => {
    if (draw() > GULL_PROBABILITY) return;
    cry(time);
  });

  // One step per second, so the probability above reads directly as "cries per
  // second on average" rather than being entangled with a musical tempo. This
  // patch has no beat and should never imply one.
  engine.scheduler.setTempo(60, 1);
  engine.scheduler.setStepCount(BEACH_STEP_COUNT);
  engine.scheduler.start();

  return {
    ids,
    meterId: tail.meterId,
    spectrumId: tail.spectrumId,
    /** Command. Cry on demand — the card's way of letting you hear the gull
     * without waiting for the dice. */
    gull() {
      cry(engine.context.currentTime + GULL_MANUAL_LEAD_SECONDS);
    },
    dispose() {
      unsubscribe();
      engine.scheduler.reset();
      for (const id of ids) engine.removeModule(id);
    },
  };
}

const SURF_CENTRE_HZ = 520;
const SURF_SWELL_DEPTH_HZ = 340;
const BEACH_FADE_SECONDS = 5;

/** Real gull calls sit around 800-1600 Hz (research [07]). */
const GULL_LOW_HZ = 820;
const GULL_HIGH_HZ = 1560;

/** The band opens above the pip's pitch and falls through it — the "eeee-aw"
 * contour, approximated with the one automatable parameter available. */
const GULL_BAND_RATIO = 1.6;
const GULL_BAND_FALL = 0.7;
const GULL_SWEEP_SECONDS = 0.22;

const GULL_DOUBLE_PROBABILITY = 0.55;
const GULL_PAIR_GAP_SECONDS = 0.26;

/** ~1 cry every 8 s on average, at one step per second. Sparse: gulls that call
 * constantly sound like a pet shop, not a coastline. */
const GULL_PROBABILITY = 0.12;

const BEACH_STEP_COUNT = 64;

/** Far enough ahead that the scheduled sweep is in the future (a past time
 * plays instantly and the ramp is skipped), short enough to feel instant. */
const GULL_MANUAL_LEAD_SECONDS = 0.03;

// ─── FX ─────────────────────────────────────────────────────────────────────

/**
 * SPACE WHOOSH — the parameterized one, with an idle bed so the card is never
 * silent, and ONE knob that means something.
 *
 * CHAIN: noise(pink) -> bandpass <- swept by a scheduled envelope
 *        -> EQ3 -> deepSpace reverb -> out
 *
 * ── HOW THIS DIFFERS FROM whoosh() BELOW ─────────────────────────────────────
 * `whoosh()` is the original three-module proof, kept because it is the
 * minimal worked example. THIS one is the sound-design version: it adds an EQ3
 * (so the sweep has a scooped, cinematic midrange rather than a flat one), a
 * deep-space reverb (so it arrives from somewhere), a quiet idle bed of
 * filtered noise (so pressing the card produces sound immediately, not
 * silence-until-you-find-the-button), and a STEREO-ISH doppler tail: the sweep
 * ends BELOW where it started, which is what a real object passing you does as
 * its Doppler shift falls.
 *
 * INTENSITY, the one knob, moves five things at once because "intensity" is not
 * a single physical quantity — a faster pass is shorter, brighter at peak,
 * more resonant, louder, and drier (a close, fast object has less time to
 * excite the room). Moving one of them and calling it intensity is the mistake
 * that makes a knob feel fake.
 */
export function spaceWhoosh(engine, options = {}) {
  const ids = ["space-w-noise", "space-w-filter", "space-w-eq", "space-w-verb"];

  engine.addModule("noise", "space-w-noise", { color: "pink", level: WHOOSH_IDLE_LEVEL, seed: 9 });
  engine.addModule("filter", "space-w-filter", { type: "bandpass", frequency: 300, Q: 5 });
  engine.addModule("eq3", "space-w-eq", { low: 3, mid: -5, midFrequency: 900, midQ: 0.9, high: 4 });
  engine.addModule("reverb", "space-w-verb", { character: "deepSpace", wet: 0.55, dry: 0.75 });

  const tail = outputTail(engine, "space-w", 0.7);
  ids.push(...tail.ids);

  engine.connect("space-w-noise", "out", "space-w-filter", "in");
  engine.connect("space-w-filter", "out", "space-w-eq", "in");
  engine.connect("space-w-eq", "out", "space-w-verb", "in");
  engine.connect("space-w-verb", "out", tail.inputId, "in");

  let intensity = options.intensity ?? 0.5;

  return {
    ids,
    meterId: tail.meterId,
    spectrumId: tail.spectrumId,

    /**
     * Command. Set the one knob. Takes effect on the NEXT fire, and immediately
     * adjusts the resonance so the idle bed shifts character too — a knob whose
     * effect is entirely deferred feels broken while you drag it.
     *
     * Args:
     *     value (number): 0 = a distant drift, 1 = something screaming past
     */
    setIntensity(value) {
      intensity = Math.min(1, Math.max(0, value));
      engine.setParam("space-w-filter", "Q", WHOOSH_BASE_Q + intensity * WHOOSH_Q_RANGE, { rampSeconds: 0.2 });
    },

    /** Query. The current intensity, so the UI can render it without keeping
     * its own copy that could drift out of sync. */
    intensity() {
      return intensity;
    },

    /** Command. Fire one pass, at the current intensity. Safe to call again
     * mid-flight: every ramp is cancelled and rescheduled from now. */
    fire() {
      const context = engine.context;
      const now = context.currentTime;
      const sweepSeconds = WHOOSH_SLOW_SECONDS - intensity * (WHOOSH_SLOW_SECONDS - WHOOSH_FAST_SECONDS);
      const filterFrequency = engine.paramNode("space-w-filter", "frequency");
      const level = engine.paramNode("space-w-noise", "level");

      const peak = now + sweepSeconds * WHOOSH_PEAK_FRACTION;
      const end = now + sweepSeconds;

      filterFrequency.cancelScheduledValues(now);
      level.cancelScheduledValues(now);

      // Exponential in Hz: pitch is perceived logarithmically, so this reads as
      // acceleration where a linear ramp reads as a slide.
      filterFrequency.setValueAtTime(WHOOSH_START_HZ, now);
      filterFrequency.exponentialRampToValueAtTime(
        WHOOSH_PEAK_HZ * (0.55 + intensity * 0.75),
        peak,
      );
      // Ends BELOW where it started — the Doppler fall of something receding.
      filterFrequency.exponentialRampToValueAtTime(WHOOSH_END_HZ, end);

      level.setValueAtTime(WHOOSH_IDLE_LEVEL, now);
      level.linearRampToValueAtTime(WHOOSH_PEAK_LEVEL * (0.5 + intensity * 0.5), peak);
      // Returns to the IDLE level, not to zero, so the bed is still there
      // afterwards and the patch can be fired again forever.
      level.linearRampToValueAtTime(WHOOSH_IDLE_LEVEL, end);
      return now;
    },
    dispose() {
      for (const id of ids) engine.removeModule(id);
    },
  };
}

/** Quiet enough to be a presence rather than a sound, loud enough that the
 * meter proves the patch is alive before anything is fired. */
const WHOOSH_IDLE_LEVEL = 0.05;

const WHOOSH_SLOW_SECONDS = 2.4;
const WHOOSH_FAST_SECONDS = 0.45;

/** The sweep peaks a third of the way through and falls for the rest — a pass
 * that peaks in the middle sounds symmetrical and therefore artificial. */
const WHOOSH_PEAK_FRACTION = 0.34;

/**
 * WHOOSH — the Mandelbrot-zoom sound, and the reason it is a PATCH and not a
 * module.
 *
 * The user: "when the Mandelbrot zooms in maybe I can make it whoosh faster
 * like we're going past a bunch of wind." That is noise through a swept
 * resonant filter — three modules and two wires. Making it a "whoosh module"
 * would hide exactly the composition the node editor exists to show.
 *
 * The sweep is an exponential ramp on the filter's cutoff, which sounds like
 * acceleration; a linear ramp of the same duration sounds like a slide, because
 * pitch perception is logarithmic. `intensity` shortens the sweep and raises
 * the resonance, so one control goes from "a breeze" to "a jet".
 */
export function whoosh(engine, options = {}) {
  const ids = ["whoosh-noise", "whoosh-filter", "whoosh-reverb", "whoosh-meter", "whoosh-spectrum", "whoosh-out"];

  engine.addModule("noise", "whoosh-noise", { color: "pink", level: 0.5 });
  engine.addModule("filter", "whoosh-filter", { type: "bandpass", frequency: 300, Q: 6 });
  engine.addModule("reverb", "whoosh-reverb", { character: "hall", wet: 0.45, dry: 0.7 });
  engine.addModule("meter", "whoosh-meter");
  engine.addModule("spectrum", "whoosh-spectrum");
  engine.addModule("output", "whoosh-out", { volume: 0.7 });

  engine.connect("whoosh-noise", "out", "whoosh-filter", "in");
  engine.connect("whoosh-filter", "out", "whoosh-reverb", "in");
  engine.connect("whoosh-reverb", "out", "whoosh-meter", "in");
  engine.connect("whoosh-meter", "out", "whoosh-spectrum", "in");
  engine.connect("whoosh-spectrum", "out", "whoosh-out", "in");

  return {
    ids,
    meterId: "whoosh-meter",
    spectrumId: "whoosh-spectrum",
    /**
     * Command. Fire one whoosh.
     *
     * Args:
     *     intensity (number): 0 = gentle and slow, 1 = aggressive and fast
     */
    fire(intensity = 0.5) {
      const level = Math.min(1, Math.max(0, intensity));
      // High intensity = short sweep. The research's numbers: 1 s gentle,
      // 0.2 s aggressive.
      const sweepSeconds = 1 - level * 0.8;
      const context = engine.context;
      const now = context.currentTime;

      // ── WHY THIS IS SCHEDULED AUTOMATION AND NOT A SEQUENCE OF setParam ──
      // A whoosh is an ENVELOPE: a shape over time with a beginning, a peak
      // and an end. Expressing it as several setParam calls does not work, and
      // the way it fails is instructive — it was this patch's first bug.
      // setParam(rampSeconds: 0) writes setValueAtTime(now) and
      // setParam(rampSeconds: s) writes setTargetAtTime(now); issuing both in
      // the same turn puts two automation events at the SAME timestamp, and
      // setTargetAtTime only approaches its target asymptotically, so the
      // sweep never arrived. A trailing setTimeout then ramped the level to 0
      // and nothing ever restored it, so the SECOND whoosh was silent.
      //
      // Scheduling the whole shape on the audio clock up front fixes all of
      // it: the events are ordered by construction, the timing is
      // sample-accurate rather than setTimeout-jittery, and every ramp ends at
      // an explicit value so the patch returns to a known state and can be
      // fired again immediately.
      const filterFrequency = engine.paramNode("whoosh-filter", "frequency");
      const noiseLevel = engine.paramNode("whoosh-noise", "level");

      const attack = sweepSeconds * 0.35;
      const peak = now + attack;
      const end = now + sweepSeconds;

      // Cancel anything still in flight from a previous fire, so overlapping
      // whooshes restart cleanly instead of fighting each other.
      filterFrequency.cancelScheduledValues(now);
      noiseLevel.cancelScheduledValues(now);

      // The sweep. Exponential in Hz, because pitch perception is logarithmic:
      // a linear ramp of the same span sounds like a slide, an exponential one
      // sounds like acceleration.
      filterFrequency.setValueAtTime(WHOOSH_START_HZ, now);
      filterFrequency.exponentialRampToValueAtTime(WHOOSH_PEAK_HZ, peak);
      filterFrequency.exponentialRampToValueAtTime(WHOOSH_END_HZ, end);

      engine.setParam("whoosh-filter", "Q", WHOOSH_BASE_Q + level * WHOOSH_Q_RANGE);

      // The amplitude envelope: swell in, fall away. A whoosh at constant
      // volume is a burst of noise, not something moving past the listener.
      noiseLevel.setValueAtTime(0.02, now);
      noiseLevel.linearRampToValueAtTime(WHOOSH_PEAK_LEVEL, peak);
      noiseLevel.linearRampToValueAtTime(0, end);
      return now;
    },
    dispose() {
      for (const id of ids) engine.removeModule(id);
    },
  };
}

/** Whoosh voicing. The sweep spans roughly five octaves, which is wide enough
 * to read as motion rather than as a filter wobble. */
const WHOOSH_START_HZ = 260;
const WHOOSH_PEAK_HZ = 7200;

/** Ends lower than it started, so the whoosh recedes past the listener rather
 * than parking bright. */
const WHOOSH_END_HZ = 220;

const WHOOSH_BASE_Q = 4;
const WHOOSH_Q_RANGE = 8;
const WHOOSH_PEAK_LEVEL = 0.55;

/**
 * THE DEMO PATCH LIBRARY — for UI enumeration.
 *
 * Each entry carries FOUR things, and the last two exist because of ADDENDUM 11
 * (the user explores by picking patches, not by wiring):
 *   build    — the function above
 *   label    — display name
 *   category — one of PATCH_CATEGORIES; the page groups by this
 *   hint     — ONE SENTENCE saying what the sound is and what its chain is.
 *              Not a tooltip afterthought: it is the only explanation of the
 *              patch the user gets, so it names the modules involved. Someone
 *              who reads all ten hints has learned what the modules do, which
 *              is the closest thing to a wiring tutorial this page has.
 *
 * ORDER MATTERS: within each category, patches run from the calmest and most
 * obviously useful to the most specialised. A first-time visitor clicking down
 * the list in order gets a sensible tour rather than a shock.
 */
export const DEMO_PATCHES = {
  // ── Ambient ───────────────────────────────────────────────────────────────
  padDrone: {
    build: padDrone,
    label: "Pad Drone",
    category: "ambient",
    hint: "One pad module straight to the output — a breathing supersaw already inside deep-space reverb.",
  },
  deepSpaceDrone: {
    build: deepSpaceDrone,
    label: "Deep Space Drone",
    category: "ambient",
    hint: "Sub sine + wide supersaw through a dark lowpass, swept by two LFOs whose rates never line up, into a 7-second reverb.",
  },
  shimmerPad: {
    build: shimmerPad,
    label: "Shimmer Pad",
    category: "ambient",
    hint: "A brighter pad whose filter blooms open once over twelve seconds, then drifts — EQ high shelf, ping-pong delay, hall.",
  },
  wind: {
    build: wind,
    label: "Wind",
    category: "ambient",
    hint: "Pink noise through a resonant bandpass that an LFO gusts up and down; one knob for how hard it blows.",
  },
  beach: {
    build: beach,
    label: "Beach",
    category: "ambient",
    hint: "Two voices in a mixer: noise swept by slow LFOs makes the surf, seeded FM pips make the gulls.",
  },

  // ── Percussion ────────────────────────────────────────────────────────────
  sequencedDings: {
    build: sequencedDings,
    label: "Sequenced Dings",
    category: "percussion",
    hint: "The acceptance patch: clock → sequencer → FM bell → plate reverb, on a pentatonic scale with rests.",
  },
  cathedralBells: {
    build: cathedralBells,
    label: "Cathedral Bells",
    category: "percussion",
    hint: "A gong struck about every eight seconds into a very wet 7-second reverb — mostly tail, almost no strike.",
  },
  arpCascade: {
    build: arpCascade,
    label: "Arp Cascade",
    category: "percussion",
    hint: "Sixteenth-note bells through a dotted-eighth ping-pong delay, so the repeats land between the notes.",
  },
  pipsAndPops: {
    build: pipsAndPops,
    label: "Pips & Pops",
    category: "percussion",
    hint: "Short FM blips fired on a seeded random gate, through a bitcrusher — punctuation, not a beat.",
  },
  metallicClanks: {
    build: metallicClanks,
    label: "Metallic Clanks",
    category: "percussion",
    hint: "Inharmonic FM hits at drawn pitches, band-passed and left nearly dry so they stay close rather than becoming bells.",
  },
  heartbeatSub: {
    build: heartbeatSub,
    label: "Heartbeat Sub",
    category: "percussion",
    hint: "A 60 Hz sine pitched down by a scheduled envelope, struck twice per cycle — lub then a softer dub.",
  },

  // ── FX ────────────────────────────────────────────────────────────────────
  spaceWhoosh: {
    build: spaceWhoosh,
    label: "Space Whoosh",
    category: "fx",
    hint: "Noise through a resonant bandpass swept by a scheduled envelope; one intensity knob moves speed, brightness, Q and level together.",
  },
  whoosh: {
    build: whoosh,
    label: "Whoosh (minimal)",
    category: "fx",
    hint: "The three-module original: noise → swept filter → reverb. Kept as the smallest worked example of a patch.",
  },
};

/**
 * The categories, in display order, with the sentence each group gets.
 *
 * Lives here rather than in dev.html because the editor's Demo Patches palette
 * (ADDENDUM 10) will group by the same keys, and two copies of this list would
 * drift the moment a patch is added.
 */
export const PATCH_CATEGORIES = [
  { key: "ambient", label: "Ambient", blurb: "Sustained beds. Start one and leave it running." },
  { key: "percussion", label: "Percussion", blurb: "Struck and sequenced. All of these keep playing on their own." },
  { key: "fx", label: "FX", blurb: "One-shots with an idle bed. Press Fire." },
];

/**
 * Query. Patch keys belonging to a category, in declaration order.
 *
 * Args:
 *     category (string): A key from PATCH_CATEGORIES
 *
 * Returns:
 *     string[]
 *
 * Examples:
 *     >>> patchesInCategory("fx")
 *     [ 'spaceWhoosh', 'whoosh' ]
 *     >>> patchesInCategory("nope")
 *     []
 */
export function patchesInCategory(category) {
  return Object.keys(DEMO_PATCHES).filter((key) => DEMO_PATCHES[key].category === category);
}
