/**
 * THE SYNTH ENGINE — the one API PowerRP talks to.
 *
 * ── THE ENGINE LAW (blueprint) ───────────────────────────────────────────────
 * This library has ZERO PowerRP imports, in this file and every file it pulls
 * in. PowerRP CONTROLS the synth; the synth never reaches back. Concretely that
 * means the engine knows nothing about documents, slides, items, deltas or
 * widgets — it takes module types, ids, port names and numbers. A node widget
 * in PowerRP will hold an id and call setParam; the engine cannot tell whether
 * its caller is the editor, a test page, or dev.html.
 *
 * ── GLITCH-FREE LIVE REWIRING — THE HARD REQUIREMENT ─────────────────────────
 * THE PROBLEM. Web Audio's connect()/disconnect() take effect at an arbitrary
 * point inside the next 128-sample render quantum. If audio is flowing when a
 * wire is cut, the signal goes from whatever it was to zero INSTANTLY — a step
 * discontinuity. A step contains energy at every frequency, so it is heard as a
 * broadband CLICK. The same thing happens in reverse on connect. This is the
 * single most-reported defect in browser modular synths (research [01]/[08]),
 * and it is why Tone.js cannot own the graph: it does not track connectivity,
 * so it cannot know when to protect a change.
 *
 * THE TECHNIQUE — a ramp-cut-ramp sandwich around every topology change:
 *
 *   1. Every module's output is routed through a private GAIN NODE owned by the
 *      engine, never by the module. This "guard gain" exists solely so there is
 *      always a place to attenuate BEFORE the wire that is about to change.
 *   2. On connect/disconnect the engine ramps the affected guard gain toward 0
 *      with setTargetAtTime over REWIRE_RAMP_SECONDS (8 ms — long enough to be
 *      a smooth ramp at ~384 samples, short enough to be imperceptible; see
 *      dsp.REWIRE_RAMP_SECONDS for the full tradeoff).
 *   3. The actual connect()/disconnect() happens AFTER the ramp has settled
 *      (4 time-constants, so <2% remains — dsp.rampSettleSeconds). At that
 *      moment the signal through the changing wire is essentially silence, so
 *      there is no step to hear.
 *   4. The guard gain ramps back up to its previous value.
 *
 * WHY setTargetAtTime AND NOT linearRampToValueAtTime: exponential approach has
 * no corner at either end. A linear ramp has a slope DISCONTINUITY where it
 * starts and stops, and on a loud signal that corner is itself faintly audible
 * as a tick. setTargetAtTime is smooth at both ends by construction.
 *
 * WHY A PER-MODULE GUARD AND NOT ONE MASTER DUCK: ducking the master would make
 * every rewire attenuate the ENTIRE patch, so connecting one idle LFO would dip
 * a playing pad. Guarding per module means a rewire is inaudible in the parts
 * of the patch it does not touch.
 *
 * THE COST, STATED HONESTLY: a rewire takes ~40 ms end to end (ramp down,
 * settle, switch, ramp up) and the rewired path is quiet during it. That is a
 * deliberate trade — inaudible-but-slightly-late beats instant-but-clicking.
 * Rewires are user gestures at human speed, so 40 ms is invisible.
 *
 * ── SUSPEND/RESUME AND THE AUTOPLAY RULE ─────────────────────────────────────
 * Browsers refuse to start an AudioContext without a user gesture. The engine
 * therefore starts SUSPENDED and `resume()` must be called from a real click.
 * That is not a workaround to hide: `isRunning()` reports it, and dev.html has
 * an explicit start control, because a synth that is silently suspended looks
 * exactly like a synth that is broken.
 */

import {
  REWIRE_RAMP_SECONDS,
  rampSettleSeconds,
  generateImpulseResponse,
  clampParam,
  REVERB_CHARACTERS,
} from "./dsp.js";
import { MODULE_FACTORIES } from "./modules.js";
import { createScheduler } from "./scheduler.js";

/** Where the worklet processors live, relative to this file. */
const WORKLET_URL = new URL("./worklets/processors.js", import.meta.url);

/**
 * Create a synth engine.
 *
 * COMMAND (creates an AudioContext and owns all audio state).
 *
 * Args:
 *     options (object): Optional.
 *         audioContext — supply your own, otherwise one is created
 *         sampleRate   — requested rate for a created context
 *
 * Returns:
 *     object: The engine API. `init()` must be awaited before addModule().
 *
 * Examples:
 *     >>> // const engine = createEngine()
 *     >>> // await engine.init()                        // loads the worklets
 *     >>> // engine.addModule("pad", "pad1", { frequency: 82.4 })
 *     >>> // engine.addModule("output", "out")
 *     >>> // engine.connect("pad1", "out", "out", "in")
 *     >>> // await engine.resume()                      // from a click handler
 */
export function createEngine(options = {}) {
  const context = options.audioContext ?? new AudioContext({ sampleRate: options.sampleRate });
  const modules = new Map(); // id -> { instance, guard, type }
  const connections = new Map(); // connectionKey -> {sourceId, sourcePort, targetId, targetPort}
  const meterSubscriptions = new Map(); // id -> Set<callback>
  const spectrumSubscriptions = new Map();
  const impulseResponses = new Map(); // character -> AudioBuffer (cached)

  let initialized = false;
  let pollHandle = null;
  const scheduler = createScheduler(context);

  // ── Resources handed to module factories ──────────────────────────────────

  /**
   * Query (memoized). An AudioBuffer for a reverb character, built from the
   * pure generator. Cached because generating a 7-second stereo IR is ~600k
   * samples of work and every reverb module would otherwise redo it.
   */
  function impulseResponse(character) {
    if (impulseResponses.has(character)) return impulseResponses.get(character);
    if (!REVERB_CHARACTERS[character]) {
      throw new Error(
        `Unknown reverb character ${JSON.stringify(character)}; expected one of ${Object.keys(REVERB_CHARACTERS).join(", ")}`,
      );
    }
    const generated = generateImpulseResponse(character, context.sampleRate, IMPULSE_SEED);
    const buffer = context.createBuffer(2, generated.left.length, context.sampleRate);
    buffer.copyToChannel(generated.left, 0);
    buffer.copyToChannel(generated.right, 1);
    impulseResponses.set(character, buffer);
    return buffer;
  }

  let strikeNoiseBuffer = null;
  /** Query (memoized). A short noise burst, the raw material of the ding's
   * strike transient. One buffer serves every strike of every bell. */
  function strikeNoise() {
    if (strikeNoiseBuffer) return strikeNoiseBuffer;
    const length = Math.floor(context.sampleRate * STRIKE_NOISE_SECONDS);
    strikeNoiseBuffer = context.createBuffer(1, length, context.sampleRate);
    const data = strikeNoiseBuffer.getChannelData(0);
    let state = STRIKE_NOISE_SEED;
    for (let i = 0; i < length; i++) {
      state = (state * 1664525 + 1013904223) >>> 0;
      data[i] = (state / 4294967296) * 2 - 1;
    }
    return strikeNoiseBuffer;
  }

  const resources = { impulseResponse, strikeNoise };

  // ── Port resolution ───────────────────────────────────────────────────────

  /**
   * Query. Resolve a module's named port to the thing connect() needs.
   *
   * Handles the three shapes a port can take, which is the ONE place that
   * variation is allowed to exist:
   *   - an AudioNode           (ordinary input/output)
   *   - an AudioParam          (a modulatable knob, e.g. a filter's frequency)
   *   - {node, index}          (a specific input index, e.g. sample&hold's
   *                             trigger input, which is input 1)
   */
  function resolvePort(id, port, direction) {
    const entry = modules.get(id);
    if (!entry) throw new Error(`No module with id ${JSON.stringify(id)}`);

    // Outputs always go through their guard gain — that is what makes rewiring
    // protectable. Inputs go straight to the module.
    if (direction === "output") {
      const guard = entry.guards.get(port);
      if (!guard) {
        throw new Error(
          `Module ${JSON.stringify(id)} (${entry.type}) has no output port ${JSON.stringify(port)}; ` +
            `has ${[...entry.guards.keys()].join(", ") || "none"}`,
        );
      }
      return { node: guard, index: 0 };
    }

    const target = entry.instance.inputs[port];
    if (!target) {
      throw new Error(
        `Module ${JSON.stringify(id)} (${entry.type}) has no input port ${JSON.stringify(port)}; ` +
          `has ${Object.keys(entry.instance.inputs).join(", ") || "none"}`,
      );
    }
    if (target.node && typeof target.index === "number") return target;
    return { node: target, index: 0 };
  }

  /**
   * Command. Ramp the affected guard gain(s) to zero, run `apply()` once the
   * ramp has settled, then ramp back. THE glitch-free rewiring primitive —
   * every topology change in this engine goes through here.
   *
   * Args:
   *     id (string): Module whose output is changing
   *     port (string|null): Which output port's guard to duck. null = all of
   *         them, which is what removeModule needs (every output is going away).
   *     apply (function): The actual connect/disconnect/dispose
   */
  function underRampGuard(id, port, apply) {
    const entry = modules.get(id);
    if (!entry) {
      // No guard to protect: the change is still legitimate (e.g. the module
      // was removed concurrently), so apply it rather than silently skipping.
      apply();
      return;
    }
    const guards = port === null ? [...entry.guards.values()] : [entry.guards.get(port)].filter(Boolean);
    const now = context.currentTime;
    for (const guard of guards) guard.gain.setTargetAtTime(0, now, REWIRE_RAMP_SECONDS);

    const settleMs = rampSettleSeconds(REWIRE_RAMP_SECONDS) * 1000;
    setTimeout(() => {
      apply();
      // Ramp back only if the module still exists — a remove during the window
      // is legal and its guards are already gone.
      if (modules.has(id)) {
        for (const guard of guards) {
          guard.gain.setTargetAtTime(entry.guardLevel, context.currentTime, REWIRE_RAMP_SECONDS);
        }
      }
    }, settleMs);
  }

  /** Pure. The map key identifying one connection. */
  function connectionKey(sourceId, sourcePort, targetId, targetPort) {
    return `${sourceId}:${sourcePort}->${targetId}:${targetPort}`;
  }

  // ── Meter / spectrum polling ──────────────────────────────────────────────

  /**
   * Command. One poll of every subscribed analyser, pushed to subscribers.
   *
   * WHY POLL AND NOT PUSH: an AnalyserNode has no event — it is a window onto
   * the last FFT, read on demand. Polling on rAF ties meter updates to the
   * display refresh, which is exactly the rate a meter needs and no more.
   * Reusing one Float32Array per analyser keeps this allocation-free, so the
   * meter loop never triggers a GC that could stall the audio thread.
   */
  function poll() {
    for (const [id, callbacks] of meterSubscriptions) {
      const entry = modules.get(id);
      if (!entry || !entry.instance.analyser) continue;
      const analyser = entry.instance.analyser;
      if (!entry.meterBuffer || entry.meterBuffer.length !== analyser.fftSize) {
        entry.meterBuffer = new Float32Array(analyser.fftSize);
      }
      analyser.getFloatTimeDomainData(entry.meterBuffer);
      let sum = 0;
      for (let i = 0; i < entry.meterBuffer.length; i++) {
        sum += entry.meterBuffer[i] * entry.meterBuffer[i];
      }
      const rms = Math.sqrt(sum / entry.meterBuffer.length);
      const peakDb = rms > 0 ? 20 * Math.log10(rms) : SILENT_DB;
      for (const callback of callbacks) callback({ rms, db: peakDb });
    }

    for (const [id, callbacks] of spectrumSubscriptions) {
      const entry = modules.get(id);
      if (!entry || !entry.instance.analyser) continue;
      const analyser = entry.instance.analyser;
      const binCount = analyser.frequencyBinCount;
      if (!entry.spectrumBuffer || entry.spectrumBuffer.length !== binCount) {
        entry.spectrumBuffer = new Uint8Array(binCount);
      }
      analyser.getByteFrequencyData(entry.spectrumBuffer);
      for (const callback of callbacks) callback(entry.spectrumBuffer);
    }

    pollHandle = requestAnimationFrame(poll);
  }

  /** Command. Start the poll loop if anything is subscribed and it is not
   * already running. Idempotent. */
  function ensurePolling() {
    if (pollHandle !== null) return;
    if (meterSubscriptions.size === 0 && spectrumSubscriptions.size === 0) return;
    pollHandle = requestAnimationFrame(poll);
  }

  /** Command. Stop the poll loop when nothing needs it — a rAF loop running
   * against zero subscribers is pure waste on a presenting machine. */
  function maybeStopPolling() {
    if (pollHandle === null) return;
    if (meterSubscriptions.size > 0 || spectrumSubscriptions.size > 0) return;
    cancelAnimationFrame(pollHandle);
    pollHandle = null;
  }

  // ── The public API ────────────────────────────────────────────────────────

  return {
    /**
     * Command. Load the AudioWorklet module. MUST be awaited before any module
     * that needs a worklet (adsr, bitcrush, quantize, sampleHold, trigger).
     *
     * Loading is separate from createEngine because it is ASYNCHRONOUS and a
     * constructor cannot await. Making it explicit means a caller that forgets
     * gets a clear "await engine.init()" error rather than a mystery failure
     * deep inside an AudioWorkletNode constructor.
     */
    async init() {
      if (initialized) return;
      await context.audioWorklet.addModule(WORKLET_URL);
      initialized = true;
    },

    /**
     * Command. Instantiate a module.
     *
     * Every module gets a private GUARD GAIN on its output — the thing that
     * makes rewiring glitch-free (see the file header). The module never sees
     * it and cannot bypass it.
     *
     * Args:
     *     type (string): A key of MODULE_FACTORIES
     *     id (string): Caller-chosen unique id
     *     params (object): Initial parameter values
     */
    addModule(type, id, params = {}) {
      const factory = MODULE_FACTORIES[type];
      if (!factory) {
        throw new Error(
          `Unknown module type ${JSON.stringify(type)}; expected one of ${Object.keys(MODULE_FACTORIES).join(", ")}`,
        );
      }
      if (modules.has(id)) throw new Error(`Module id ${JSON.stringify(id)} already exists`);
      if (!initialized && WORKLET_MODULES.has(type)) {
        throw new Error(`Module type ${JSON.stringify(type)} needs the worklets — await engine.init() first`);
      }

      const onTriggerFired = () => {
        const entry = modules.get(id);
        if (entry && entry.onFired) entry.onFired();
      };
      const instance = factory(context, params, resources, onTriggerFired);

      // ONE GUARD PER OUTPUT PORT, not one per module. A module with several
      // outputs (the sequencer's `pitch` and `gate`) carries genuinely
      // different signals on them; a shared guard would sum them, so
      // connecting `pitch` would silently also deliver `gate`. Per-port guards
      // also mean rewiring one output does not duck the module's others.
      const guards = new Map();
      for (const [portName, output] of Object.entries(instance.outputs)) {
        const guard = context.createGain();
        guard.gain.value = 1;
        output.connect(guard);
        guards.set(portName, guard);
      }

      modules.set(id, { instance, guards, guardLevel: 1, type, meterBuffer: null, spectrumBuffer: null });
      instance.start();

      // A sequencer joins the shared transport, so all sequencers in a patch
      // are locked to one clock.
      if (typeof instance.playStep === "function") {
        const unsubscribe = scheduler.onStep((index, time) => instance.playStep(index, time));
        modules.get(id).unsubscribeScheduler = unsubscribe;
      }
      return id;
    },

    /**
     * Command. Remove a module: disconnect every wire touching it, dispose it,
     * and forget it. Runs under the ramp guard so removal is as click-free as
     * any other topology change.
     */
    removeModule(id) {
      const entry = modules.get(id);
      if (!entry) throw new Error(`No module with id ${JSON.stringify(id)}`);

      for (const [key, connection] of [...connections]) {
        if (connection.sourceId === id || connection.targetId === id) {
          connections.delete(key);
        }
      }
      if (entry.unsubscribeScheduler) entry.unsubscribeScheduler();
      meterSubscriptions.delete(id);
      spectrumSubscriptions.delete(id);
      maybeStopPolling();

      underRampGuard(id, null, () => {
        entry.instance.dispose();
        for (const guard of entry.guards.values()) guard.disconnect();
        modules.delete(id);
      });
    },

    /**
     * Command. Connect an output port to an input port, GLITCH-FREE.
     *
     * Reconnecting an already-connected pair is a no-op rather than an error:
     * the graph state is what was asked for, and throwing would make an
     * idempotent "apply this patch" call fail on the second run.
     */
    connect(sourceId, sourcePort, targetId, targetPort) {
      const key = connectionKey(sourceId, sourcePort, targetId, targetPort);
      if (connections.has(key)) return;

      const source = resolvePort(sourceId, sourcePort, "output");
      const target = resolvePort(targetId, targetPort, "input");
      connections.set(key, { sourceId, sourcePort, targetId, targetPort });

      underRampGuard(sourceId, sourcePort, () => {
        if (target.node instanceof AudioParam) source.node.connect(target.node);
        else source.node.connect(target.node, 0, target.index);
      });
    },

    /** Command. Remove a connection, GLITCH-FREE. Disconnecting something that
     * is not connected is a no-op, for the same idempotence reason as connect. */
    disconnect(sourceId, sourcePort, targetId, targetPort) {
      const key = connectionKey(sourceId, sourcePort, targetId, targetPort);
      if (!connections.has(key)) return;
      connections.delete(key);

      const source = resolvePort(sourceId, sourcePort, "output");
      const target = resolvePort(targetId, targetPort, "input");

      underRampGuard(sourceId, sourcePort, () => {
        if (target.node instanceof AudioParam) source.node.disconnect(target.node);
        else source.node.disconnect(target.node, 0, target.index);
      });
    },

    /**
     * Command. Set a parameter, optionally ramped.
     *
     * `rampSeconds` > 0 uses setTargetAtTime, so a knob drag glides instead of
     * stepping — a stepped gain or cutoff change is a click for the same
     * step-discontinuity reason a rewire is. Discrete params (waveform, filter
     * type, scale) are setter functions; rampSeconds is meaningless for them
     * and is passed through so each module can decide (all currently ignore it).
     *
     * Args:
     *     id (string): Module id
     *     key (string): Parameter name
     *     value (number|string|Array): New value
     *     options (object): { rampSeconds }
     */
    setParam(id, key, value, options = {}) {
      const entry = modules.get(id);
      if (!entry) throw new Error(`No module with id ${JSON.stringify(id)}`);
      const param = entry.instance.params[key];
      if (param === undefined) {
        throw new Error(
          `Module ${JSON.stringify(id)} (${entry.type}) has no parameter ${JSON.stringify(key)}; ` +
            `has ${Object.keys(entry.instance.params).join(", ") || "none"}`,
        );
      }

      const ramp = options.rampSeconds ?? 0;
      const when = context.currentTime;

      if (typeof param === "function") {
        param(value, when, ramp);
        return;
      }
      // An AudioParam: clamp to the param's own declared range, so an
      // out-of-range value is bounded rather than throwing from the Web Audio
      // layer with a message that names no module.
      const bounded = clampParam(value, param.minValue, param.maxValue, `${entry.type}.${key}`);
      if (ramp > 0) param.setTargetAtTime(bounded, when, ramp);
      else param.setValueAtTime(bounded, when);
    },

    /**
     * Command. Fire a trigger on a module — the rising-edge event that strikes
     * a bell or opens an envelope.
     *
     * Args:
     *     id (string): Module id
     *     port (string): Reserved for modules with several trigger inputs
     *     time (number): Audio-clock time; defaults to now
     *     options (object): Module-specific (e.g. { frequency } for a ding)
     */
    trigger(id, port = "gate", time = undefined, options = {}) {
      const entry = modules.get(id);
      if (!entry) throw new Error(`No module with id ${JSON.stringify(id)}`);
      if (typeof entry.instance.trigger !== "function") {
        throw new Error(`Module ${JSON.stringify(id)} (${entry.type}) is not triggerable`);
      }
      entry.instance.trigger(time ?? context.currentTime, options, port);
    },

    /**
     * Command. Subscribe to a meter module's level.
     *
     * The callback receives {rms, db} at display rate. Returns an unsubscribe
     * function; the poll loop stops itself when the last subscriber leaves.
     */
    subscribeMeter(id, callback) {
      const entry = modules.get(id);
      if (!entry) throw new Error(`No module with id ${JSON.stringify(id)}`);
      if (!entry.instance.analyser) {
        throw new Error(`Module ${JSON.stringify(id)} (${entry.type}) has no analyser — use a meter or spectrum module`);
      }
      if (!meterSubscriptions.has(id)) meterSubscriptions.set(id, new Set());
      meterSubscriptions.get(id).add(callback);
      ensurePolling();
      return () => {
        const set = meterSubscriptions.get(id);
        if (!set) return;
        set.delete(callback);
        if (set.size === 0) meterSubscriptions.delete(id);
        maybeStopPolling();
      };
    },

    /** Command. Subscribe to a spectrum module's FFT. The callback receives a
     * Uint8Array of bin magnitudes (0-255), REUSED between calls — copy it if
     * you need to keep it. Reuse is deliberate: allocating a 1024-byte array 60
     * times a second is exactly the GC pressure that stalls audio. */
    subscribeSpectrum(id, callback) {
      const entry = modules.get(id);
      if (!entry) throw new Error(`No module with id ${JSON.stringify(id)}`);
      if (!entry.instance.analyser) {
        throw new Error(`Module ${JSON.stringify(id)} (${entry.type}) has no analyser — use a spectrum module`);
      }
      if (!spectrumSubscriptions.has(id)) spectrumSubscriptions.set(id, new Set());
      spectrumSubscriptions.get(id).add(callback);
      ensurePolling();
      return () => {
        const set = spectrumSubscriptions.get(id);
        if (!set) return;
        set.delete(callback);
        if (set.size === 0) spectrumSubscriptions.delete(id);
        maybeStopPolling();
      };
    },

    /** Command. Suspend the audio context — stops the audio thread entirely,
     * which is the honest way to make a presentation silent without tearing
     * down the patch. */
    async suspend() {
      scheduler.stop();
      await context.suspend();
    },

    /** Command. Resume the audio context. MUST be called from a user gesture
     * the first time, per browser autoplay policy. */
    async resume() {
      await context.resume();
    },

    /** Command. Tear everything down. */
    async dispose() {
      scheduler.reset();
      if (pollHandle !== null) cancelAnimationFrame(pollHandle);
      pollHandle = null;
      for (const [id] of [...modules]) {
        const entry = modules.get(id);
        if (entry.unsubscribeScheduler) entry.unsubscribeScheduler();
        entry.instance.dispose();
        for (const guard of entry.guards.values()) guard.disconnect();
      }
      modules.clear();
      connections.clear();
      meterSubscriptions.clear();
      spectrumSubscriptions.clear();
      await context.close();
    },

    /** The shared transport (clock + sequencer timing). */
    scheduler,

    /** Query. Is audio actually flowing? Reported rather than assumed, because
     * a suspended context looks identical to a broken one. */
    isRunning() {
      return context.state === "running";
    },

    /** Query. The live graph, for UI and debugging. */
    inspect() {
      return {
        state: context.state,
        sampleRate: context.sampleRate,
        modules: [...modules].map(([id, entry]) => ({ id, type: entry.type })),
        connections: [...connections.values()],
      };
    },

    /** The AudioContext, for callers that genuinely need it (an offline
     * render, a decodeAudioData for the sampler). Exposed deliberately rather
     * than hidden behind a wrapper that would only re-export it badly. */
    context,
  };
}

/** Module types that construct an AudioWorkletNode and therefore require
 * init() to have completed. Kept as data so addModule's error can name the
 * problem precisely instead of failing inside a constructor. */
const WORKLET_MODULES = new Set(["adsr", "bitcrush", "quantize", "sampleHold", "trigger"]);

/** Fixed seed for generated impulse responses, so a patch's reverb is identical
 * across reloads and machines. */
const IMPULSE_SEED = 20260802;

const STRIKE_NOISE_SECONDS = 0.05;
const STRIKE_NOISE_SEED = 12345;

/** Reported level for true silence. -120 dB stands in for log10(0) = -Infinity,
 * which would break any UI that tries to scale it. */
const SILENT_DB = -120;
