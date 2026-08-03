/**
 * DEMO PATCHES — the three sounds the blueprint's acceptance test names, built
 * ONLY from the public engine API.
 *
 * These are deliberately not privileged: every one is a sequence of addModule /
 * connect / setParam calls that a caller could write themselves. That is the
 * point — if a patch needed something the API does not expose, the API would be
 * wrong. They double as the worked examples for NF-BIND, which will build the
 * same graphs from node-widget connections instead of from literals here.
 *
 * Each patch returns a handle with dispose(), so switching patches tears the
 * previous one down completely rather than layering sounds on top of each other.
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

/** The demo patches, for UI enumeration. */
export const DEMO_PATCHES = {
  padDrone: { build: padDrone, label: "Pad Drone", hint: "One module. Spacey by default." },
  sequencedDings: { build: sequencedDings, label: "Sequenced Dings", hint: "Clock → sequencer → FM bell." },
  whoosh: { build: whoosh, label: "Whoosh", hint: "Noise → swept resonant filter. Fire it." },
};
