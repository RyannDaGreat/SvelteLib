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
import {
  createVoicePool,
  noteOn as voiceNoteOn,
  noteOff as voiceNoteOff,
  allNotesOff as allVoicesOff,
  soundingNotes as voiceSoundingNotes,
  DEFAULT_POLY_VOICES,
} from "./voices.js";

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
   * Query. THE PITCH THIS MODULE'S WIRES NAME, in Hz — or `undefined` when no
   * wire names one, which means "use the module's own pitch".
   *
   * ── WHY THIS EXISTS: AudioParam.value CANNOT ANSWER IT ──────────────────────
   * WORKSTREAM CC, and it is the reason the Gamelan Bells demo made no sound.
   * Both pitch-reading modules used to strike at `pitchBus.offset.value`, on a
   * stated premise that `.value` "returns the param's current computed value
   * including every connected input's contribution". THAT IS FALSE, and it was
   * measured in Chrome rather than argued: a ConstantSource of 440 connected into
   * a param whose own offset is 0 leaves `.value` reading 0. `.value` is the
   * INTRINSIC value; connected inputs are summed on the audio thread at render
   * time and are not observable from the control thread at all.
   *
   * The consequence was silent and total. Gamelan sets its lead bell's frequency
   * offset to 0 precisely so "the wire alone names the note", and passes no
   * frequency option precisely so the wire is what is under test. So every strike
   * read 0, clamped to MIN_AUDIBLE_HZ, and played the whole melody at 20 Hz —
   * inaudible, with nothing in any log to explain it.
   *
   * ── SO THE SUM IS COMPUTED WHERE THE WIRES ARE KNOWN ───────────────────────
   * The engine owns `connections`, so it can ask each wired SOURCE for its own
   * intrinsic offset — which IS readable, because on the source node it is not a
   * summed value but the number something wrote there. Summing those is exactly
   * what Web Audio would do at the param, computed one layer up.
   *
   * SCOPE IS DELIBERATELY NARROW. Only wires into a PITCH-NAMING param count
   * (PITCH_PARAM_KEYS), and only sources that expose a plain readable offset. A
   * source that is a genuine audio-rate signal (an LFO's oscillator) has no
   * single control-thread value, contributes nothing here, and still modulates
   * the param on the audio thread the way it always did. This function decides
   * ONE thing: what pitch a discrete strike should be built at.
   *
   * `undefined` rather than 0 when nothing is wired, so the caller's `??` keeps
   * meaning "nobody named a pitch" — 0 is a legitimate offset and would read as
   * an answer.
   *
   * Args:
   *     id (string): the module being struck
   *
   * Returns:
   *     number|undefined: summed wired pitch in Hz, or undefined if unwired
   */
  function wiredPitch(id) {
    const target = modules.get(id);
    if (!target) return undefined;
    let total;
    for (const wire of connections.values()) {
      if (wire.targetId !== id) continue;
      if (!PITCH_PARAM_KEYS.has(wire.targetPort)) continue;
      const contribution = readableOffset(modules.get(wire.sourceId), wire.sourcePort);
      if (contribution === undefined) continue;
      total = (total ?? 0) + contribution;
    }
    // The module's OWN offset is part of the sum — it is what Web Audio adds the
    // wires to, and it is what makes the ding's knob read as a transposition.
    if (total === undefined) return undefined;
    const own = readableOffset(target, wire2ParamKey(target, id));
    return total + (own ?? 0);
  }

  /** The param keys that name "what pitch to sound". Both pitch-reading modules
   *  spell it differently — the ding calls it `frequency`, the poly pad `pitch` —
   *  so the set is stated once here rather than guessed at each call. */
  const PITCH_PARAM_KEYS = new Set(["pitch", "frequency"]);

  /**
   * Query. A module's OWN intrinsic value for one output/param, when it has a
   * readable one — the offset of a ConstantSourceNode, which is how every control
   * source in synth/modules.js stores "the number I am emitting".
   *
   * Returns undefined for anything else (an oscillator, a gain carrying audio),
   * which is the honest answer: those carry a waveform, not a number.
   *
   * ── `controlValue` WINS OVER `.value`, AND HAS TO ──────────────────────────
   * A param moved by `setValueAtTime` does NOT update `.value` — measured, and it
   * is the second half of the Gamelan defect: the sequencer schedules its pitch
   * for a precise audio-clock time (which is what makes the timing sample-exact)
   * and `.value` therefore still reports the PREVIOUS step's number. A module that
   * schedules rather than assigns publishes the plain number alongside, and this
   * prefers it. `.value` remains correct for the sources that simply assign.
   */
  function readableOffset(entry, port) {
    if (!entry || port === undefined) return undefined;
    const node = entry.instance?.outputs?.[port] ?? entry.instance?.params?.[port];
    if (typeof node?.controlValue === "number") return node.controlValue;
    const offset = node instanceof AudioParam ? node : node?.offset;
    if (typeof offset?.controlValue === "number") return offset.controlValue;
    return offset instanceof AudioParam && !(node instanceof AudioParam) ? offset.value : undefined;
  }

  /** Query. Which of a target module's params is its pitch — the one a wire into
   *  it was summing with. Returns undefined when it has none. */
  function wire2ParamKey(entry) {
    for (const key of PITCH_PARAM_KEYS) if (entry?.instance?.params?.[key]) return key;
    return undefined;
  }

  /**
   * Query. The module entry for `id`, refusing LOUDLY if it is not polyphonic.
   *
   * A mono module handed a note-on is the mistake worth catching: nothing about
   * `engine.noteOn("pad1", 60, 262)` looks wrong, and the pad WOULD have a
   * frequency to set — so a permissive fallback would produce a monophonic
   * instrument that mysteriously plays only the last key of every chord. The
   * sentence names the requirement rather than the symptom.
   */
  function requirePoly(id, method) {
    const entry = modules.get(id);
    if (!entry) throw new Error(`No module with id ${JSON.stringify(id)}`);
    if (!entry.pool) {
      throw new Error(
        `Module ${JSON.stringify(id)} (${entry.type}) is not polyphonic — ${method} needs a module ` +
          `declaring noteOn/noteOff (e.g. polyPad). A mono module takes a frequency param, not notes.`,
      );
    }
    return entry;
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
      return Promise.resolve();
    }
    const guards = port === null ? [...entry.guards.values()] : [entry.guards.get(port)].filter(Boolean);
    const now = context.currentTime;
    for (const guard of guards) guard.gain.setTargetAtTime(0, now, REWIRE_RAMP_SECONDS);

    const settleMs = rampSettleSeconds(REWIRE_RAMP_SECONDS) * 1000;
    return new Promise((resolve) => {
      setTimeout(() => {
        apply();
        // Ramp back only if the module still exists — a remove during the
        // window is legal and its guards are already gone.
        if (modules.has(id)) {
          for (const guard of guards) {
            guard.gain.setTargetAtTime(entry.guardLevel, context.currentTime, REWIRE_RAMP_SECONDS);
          }
        }
        resolve();
      }, settleMs);
    });
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

      // A POLY module gets a voice pool, sized from what it actually built.
      // The pool lives HERE rather than inside the module for one reason: the
      // allocation policy (who gets stolen) must be identical for every poly
      // module and provable in bare node, so it is a pure table the engine
      // owns and synth/voices.js decides over. A module that declares no
      // `noteOn` gets no pool and is untouched by any of this.
      const pool = typeof instance.noteOn === "function"
        ? createVoicePool(instance.meta?.voices ?? DEFAULT_POLY_VOICES)
        : null;
      modules.set(id, { instance, guards, guardLevel: 1, type, meterBuffer: null, spectrumBuffer: null, pool });
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
     * any other topology change. Returns a promise resolving once it is gone.
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

      return underRampGuard(id, null, () => {
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
     *
     * RETURNS A PROMISE that resolves when the wire is ACTUALLY switched —
     * roughly 32 ms later, once the guard ramp has settled. The call itself
     * returns immediately and the graph reads as connected at once, so callers
     * that do not care can ignore it. Await it when the ORDER of two topology
     * changes matters, or to measure the true rewire cost (dev.html does).
     */
    connect(sourceId, sourcePort, targetId, targetPort) {
      const key = connectionKey(sourceId, sourcePort, targetId, targetPort);
      if (connections.has(key)) return Promise.resolve();

      const source = resolvePort(sourceId, sourcePort, "output");
      const target = resolvePort(targetId, targetPort, "input");
      connections.set(key, { sourceId, sourcePort, targetId, targetPort });

      return underRampGuard(sourceId, sourcePort, () => {
        if (target.node instanceof AudioParam) source.node.connect(target.node);
        else source.node.connect(target.node, 0, target.index);
      });
    },

    /** Command. Remove a connection, GLITCH-FREE. Disconnecting something that
     * is not connected is a no-op, for the same idempotence reason as connect.
     * Returns a promise resolving when the wire is actually cut. */
    disconnect(sourceId, sourcePort, targetId, targetPort) {
      const key = connectionKey(sourceId, sourcePort, targetId, targetPort);
      if (!connections.has(key)) return Promise.resolve();
      connections.delete(key);

      const source = resolvePort(sourceId, sourcePort, "output");
      const target = resolvePort(targetId, targetPort, "input");

      return underRampGuard(sourceId, sourcePort, () => {
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
     * Query. The raw AudioParam behind a knob, for SCHEDULED AUTOMATION.
     *
     * WHY THIS EXISTS, given setParam already sets values: setParam expresses
     * "move this knob, optionally glide", which covers a live control. It
     * cannot express an ENVELOPE — a shape over time with ordered breakpoints,
     * like a whoosh's rising sweep and fall. Building one out of repeated
     * setParam calls does not merely look clumsy, it is WRONG: successive
     * calls all land at the same currentTime, so the automation events collide
     * and the later ones win. (That is a real bug this engine shipped; see
     * patches.js whoosh().) An envelope must be scheduled as one sequence on
     * the audio clock, and that requires the param itself.
     *
     * Throws for discrete params (waveform, filter type) — those are setter
     * functions with no AudioParam behind them, and automation is meaningless
     * for a value that cannot be interpolated.
     *
     * Args:
     *     id (string): Module id
     *     key (string): Parameter name
     *
     * Returns:
     *     AudioParam
     */
    paramNode(id, key) {
      const entry = modules.get(id);
      if (!entry) throw new Error(`No module with id ${JSON.stringify(id)}`);
      const param = entry.instance.params[key];
      if (param === undefined) {
        throw new Error(
          `Module ${JSON.stringify(id)} (${entry.type}) has no parameter ${JSON.stringify(key)}; ` +
            `has ${Object.keys(entry.instance.params).join(", ") || "none"}`,
        );
      }
      if (typeof param === "function") {
        throw new Error(
          `Parameter ${JSON.stringify(key)} on ${entry.type} is discrete (a setter, not an AudioParam) — ` +
            `it cannot be automated; use setParam`,
        );
      }
      return param;
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
      // THE PITCH A WIRE NAMES (WORKSTREAM CC — this is why Gamelan was silent).
      // A caller's explicit frequency still wins; with none, the wires into this
      // module's pitch param are summed HERE, because the module cannot read them
      // (wiredPitch states why AudioParam.value cannot answer this).
      const resolved = options.frequency ?? wiredPitch(id);
      const withPitch = resolved === undefined ? options : { ...options, frequency: resolved };
      entry.instance.trigger(time ?? context.currentTime, withPitch, port);
    },

    /**
     * Command. Sound a note on a POLYPHONIC module — the keyboard's note-on.
     *
     * ── WHAT THE ENGINE OWNS HERE AND WHAT IT DOES NOT ──────────────────────
     * The engine owns the VOICE POOL (which slot, and who is stolen) because
     * the policy must be one policy: two poly modules that stole differently
     * would be a difference nobody could hear the reason for. The pool itself
     * is synth/voices.js — pure, and tested without an AudioContext.
     *
     * The module owns the SOUND: given a slot it retunes and opens an
     * envelope. It never sees the allocation.
     *
     * A STEAL IS EXECUTED HERE, in order: the displaced voice is released
     * BEFORE the new note starts on the same slot, so the module's noteOn
     * always writes onto a voice that is on its way down rather than one still
     * being told to hold. Both land at the same audio-clock `time`, which is
     * what keeps the switch sample-accurate rather than two rAF ticks apart.
     *
     * Returns what was allocated, so a caller that draws a keyboard can
     * un-light the stolen key.
     *
     * Args:
     *     id (string): Module id
     *     note (number): The note's identity — MIDI number, or any stable key
     *     frequency (number): The pitch in Hz
     *     time (number): Audio-clock time; defaults to now
     *
     * Returns:
     *     {slot: number, stolen: number|null, retrigger: boolean}
     */
    noteOn(id, note, frequency, time = undefined) {
      const entry = requirePoly(id, "noteOn");
      const at = time ?? context.currentTime;
      const allocation = voiceNoteOn(entry.pool, note);
      entry.pool = allocation.pool;
      if (allocation.stolen !== null) entry.instance.noteOff(allocation.slot, at);
      // As `trigger` above: a named frequency wins, and a note with none takes the
      // pitch its WIRES name. This is the path a keyboard whose pitch cable was
      // cut travels — core/live_control.noteRoutes deliberately sends no frequency
      // then, so the pad sounds its own pitch instead of the pressed key's.
      entry.instance.noteOn(allocation.slot, frequency ?? wiredPitch(id), at);
      return { slot: allocation.slot, stolen: allocation.stolen, retrigger: allocation.retrigger };
    },

    /**
     * Command. Release a note on a polyphonic module.
     *
     * A note-off for a note that is NOT sounding does nothing and is NOT an
     * error — a note that was stolen while its key was held sends its note-off
     * later, and silencing the thief would be the classic poly bug. The pool
     * refuses it by identity (synth/voices.noteOff), so this cannot happen
     * even if a caller is sloppy about pairing.
     *
     * Returns:
     *     {slot: number|null} — null when the note was not sounding
     */
    noteOff(id, note, time = undefined) {
      const entry = requirePoly(id, "noteOff");
      const release = voiceNoteOff(entry.pool, note);
      entry.pool = release.pool;
      if (release.slot !== null) entry.instance.noteOff(release.slot, time ?? context.currentTime);
      return { slot: release.slot };
    },

    /** Command. Release every sounding note on a poly module — the panic
     *  button, and what a slide change owes a held chord. */
    allNotesOff(id, time = undefined) {
      const entry = requirePoly(id, "allNotesOff");
      const cleared = allVoicesOff(entry.pool);
      entry.pool = cleared.pool;
      for (const slot of cleared.slots) entry.instance.noteOff(slot, time ?? context.currentTime);
      return { slots: cleared.slots };
    },

    /** Query. Which notes a poly module is currently sounding, in slot order.
     *  For the keyboard's own display and for probes. */
    soundingNotes(id) {
      return voiceSoundingNotes(requirePoly(id, "soundingNotes").pool);
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
