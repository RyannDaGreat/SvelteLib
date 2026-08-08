/**
 * THE SURGE XT ENGINE MODULE — one AudioWorkletNode running a whole synthesizer,
 * behind the same tiny interface every other module in this engine presents.
 *
 * ── THE ONE STRUCTURAL PROBLEM, AND HOW IT IS SOLVED ────────────────────────
 * `engine.addModule()` is SYNCHRONOUS: a factory must return `{inputs, outputs,
 * params, …}` immediately, because the mirror connects wires the instant the
 * document says they exist. Surge cannot be ready immediately — it needs a 5.4 MB
 * wasm and a 29 MB archive off the network before `sh_init` may even be called.
 *
 * So THE MODULE'S IDENTITY IS A GainNode, created on line one, and Surge is spliced
 * in behind it when it arrives. `outputs.out` is that gain forever, so:
 *   - the mirror's `connect(surge → reverb)` succeeds at once and stays valid;
 *   - `level` is a REAL AudioParam on a real node from the first frame, so a
 *     keyframed level ramps correctly even while the synth is still downloading;
 *   - nothing has to be rewired when Surge finishes loading, which is what would
 *     otherwise produce a click and a race against the author's next edit.
 * Before Surge arrives the gain simply carries silence — the honest picture of a
 * synthesizer that has not loaded yet.
 *
 * ── WHY THE NODE IS STEREO AND WHY THAT IS SAFE HERE ────────────────────────
 * The processor is constructed `numberOfInputs: 0, numberOfOutputs: 1,
 * outputChannelCount: [2]`. Every other module in this engine is mono, so this is
 * the roster's first genuinely stereo source — and it needs no special handling by
 * anything downstream, because Web Audio's own up/down-mix rules apply at every
 * input: a mono filter receiving it sums the pair, and the stereo destination keeps
 * both. That is why the spec declares ONE `out` port rather than an L and an R.
 *
 * ── THE PARAMS ARE THREE, AND EACH ONE IS REACHABLE ─────────────────────────
 * `level` is the gain's AudioParam. `modwheel` and `bend` are SETTER FUNCTIONS
 * (engine.setParam's documented second shape) that post MIDI messages the vendored
 * worklet already implements — `cc` and `pitchBend` are fully wired on its receiving
 * end and WebSurge's own app never sends either, so they cost nothing to support.
 * There is no `tempo`: see SURGE_SPEC's docblock for why that knob was written and
 * then removed rather than shipped inert.
 *
 * ── POLYPHONY: SURGE HAS ITS OWN, AND WE STILL USE THE POOL ─────────────────
 * Surge allocates voices internally, so the engine's pool (synth/voices.js) is not
 * strictly needed. It is used anyway, because it is what makes a `node_keyboard`
 * play this module with NO new code — `core/live_control.noteRoutes` already routes
 * a poly module's gate to `engine.noteOn(id, note, frequency)`, and that path ends
 * at the `noteOn(slot, frequency, time)` this file exports. The pool hands us a
 * SLOT; Surge wants a MIDI NOTE; `slotNotes` is the one small table that bridges
 * them, so a stolen voice's note-off names the note that slot was actually playing
 * rather than the note the caller is now asking for.
 *
 * ── DETERMINISM ─────────────────────────────────────────────────────────────
 * Nothing here reads a clock, and nothing here writes to the document. Surge's DSP
 * is stateful, but that state lives on the audio thread and reaches no pixel — see
 * core/audio_specs_surge.js's four-kinds-of-state section, which is where the
 * ruling is written down in full.
 */

import { SURGE_DATA_BIN_URL, SURGE_ENGINE_WASM_URL, fetchSurgeAsset } from "./surge_remote.js";

/** The processor name the vendored bundle registers. Spelled once. */
export const SURGE_PROCESSOR = "surge-processor";
/** Where the archive is mounted inside the worklet's MEMFS. Must match what is
 *  handed to `sh_init`; Surge stores absolute paths from this root. */
export const SURGE_DATA_ROOT = "/SurgeXTData";
/** Surge's own default voice count, and what the pool is sized to. */
export const SURGE_VOICES = 16;

/** MIDI middle-A, the anchor of the frequency↔note conversion. */
const A4_HZ = 440;
const A4_NOTE = 69;

/**
 * Pure function. The MIDI note nearest a frequency in hertz.
 *
 * ROUNDED, not truncated, and CLAMPED to MIDI's 0..127: Surge takes a note number,
 * so a keyboard's 261.63 Hz must become 60 rather than 59.99. A frequency outside
 * MIDI's range (an LFO wired into `pitch`, which is legal) clamps rather than
 * handing Surge a negative note, which it would treat as garbage.
 *
 * @param {number} hz - a frequency in hertz
 * @returns {number} a MIDI note number, 0..127
 *
 * @example midiNoteFor(440) // 69
 * @example midiNoteFor(261.6255653005986) // 60
 * @example midiNoteFor(880) // 81
 * @example midiNoteFor(0) // 0
 * @example midiNoteFor(1e9) // 127
 */
export function midiNoteFor(hz) {
  if (!Number.isFinite(hz) || hz <= 0) return 0;
  const note = Math.round(A4_NOTE + 12 * Math.log2(hz / A4_HZ));
  return Math.min(127, Math.max(0, note));
}

/**
 * Pure function. A 0..1 knob as a 7-bit MIDI controller value.
 *
 * @param {number} v - 0..1
 * @returns {number} 0..127
 *
 * @example cc7bit(0) // 0
 * @example cc7bit(1) // 127
 * @example cc7bit(0.5) // 64
 * @example cc7bit(-3) // 0
 */
export function cc7bit(v) {
  if (!Number.isFinite(v)) return 0;
  return Math.min(127, Math.max(0, Math.round(v * 127)));
}

/**
 * Pure function. A -1..+1 knob as a 14-bit MIDI pitch-bend value.
 *
 * ── THE TWO HALVES HAVE DIFFERENT SPANS, AND THAT IS MIDI, NOT A BUG ───────
 * The range is 0..16383 and the centre is 8192, so there are 8192 values BELOW
 * centre and only 8191 above it. A single symmetric scale cannot hit both ends:
 * `8192 + v*8192` overflows to 16384 at +1, and `8192 + v*8191` stops one short of
 * 0 at -1. So each half is scaled by its own span. The property that must hold
 * absolutely is `bend14bit(0) === 8192` — exactly no bend — because a half-rounding
 * there would detune every note that was never bent, which is invisible as a bug
 * and extremely audible as a sound.
 *
 * @param {number} v - -1..+1
 * @returns {number} 0..16383
 *
 * @example bend14bit(0) // 8192
 * @example bend14bit(1) // 16383
 * @example bend14bit(-1) // 0
 * @example bend14bit(5) // 16383
 * @example bend14bit(-0.5) // 4096
 */
export function bend14bit(v) {
  if (!Number.isFinite(v)) return 8192;
  const clamped = Math.min(1, Math.max(-1, v));
  const scaled = clamped >= 0 ? clamped * 8191 : clamped * 8192;
  return Math.min(16383, Math.max(0, Math.round(8192 + scaled)));
}

/**
 * Command (constructs AudioNodes; starts a network load). THE `surge` MODULE.
 *
 * @param {BaseAudioContext} context - the engine's AudioContext
 * @param {object} params - construct-time knob values
 * @returns {object} an engine module instance
 */
export function surgeModule(context, params = {}) {
  // THE STABLE IDENTITY. Everything downstream connects to this and never to the
  // worklet node, which does not exist yet and may never exist (a failed download).
  const output = context.createGain();
  output.gain.value = clamp01(params.level ?? 0.5);

  // ── THE PITCH SEAM, and it is the poly pad's, deliberately ────────────────
  // `pitch` is the OFFSET of a ConstantSourceNode, which makes it an ordinary
  // AudioParam any control signal can be wired INTO and that Web Audio SUMS — so a
  // keyboard's pitch output and a transpose knob add up with no scaling module
  // between them. It is SAMPLED AT NOTE-ON, never audio-rate: a held chord whose
  // voices all glide when the pitch input moves is a siren, not a chord. A
  // frequency named per note (what a keyboard does, since it knows which key was
  // pressed) WINS over this port, exactly as it does for the ding and the pad.
  const pitchBus = context.createConstantSource();
  pitchBus.offset.value = 0;
  pitchBus.start();

  /** The worklet, once it exists. Null while loading and forever after a failure. */
  let node = null;
  /** Messages posted before the worklet existed. The PROCESSOR has its own queue for
   *  the window between construction and `sh_init`, but that only helps once the
   *  node exists — this covers the earlier window, which is seconds long because it
   *  spans a 35 MB download. Without it, a patch load or a note played while Surge
   *  downloads is silently dropped. */
  const queued = [];
  /** slot -> the MIDI note that slot is currently sounding. See the polyphony note
   *  in the header: the pool speaks slots and Surge speaks notes. */
  const slotNotes = new Map();
  let disposed = false;
  /** The failure sentence, if the load failed. Read by `inspect()` so a silent
   *  Surge can SAY why rather than merely being quiet. */
  let failure = null;
  /** THE PATCH THIS INSTANCE LAST LOADED — the "what did I already do" half of the
   *  load-on-change rule. Compared against the folded value the mirror pushes, so an
   *  unchanged document never re-sends a 40 KB blob (which would stutter the voice
   *  it interrupts). Starts as the leaf's own default, because that is what a freshly
   *  built Surge is actually playing: its Init patch. */
  let loadedPatch = "";

  function post(message) {
    if (disposed) return;
    if (node) node.port.postMessage(message);
    else queued.push(message);
  }

  /**
   * THE READINESS PROMISE. Resolves TRUE once the worklet exists and is connected
   * to this module's output, FALSE if the load failed or the host has no
   * `audioWorklet` at all.
   *
   * ── WHY THIS EXISTS: AN OFFLINE RENDER CANNOT WAIT BY GUESSING ────────────
   * The async half below is deliberately un-awaited (its own comment says why: the
   * module is usable the moment it returns, and Surge joins when it can). That is
   * right for a LIVE context, where a few hundred milliseconds of silence at the
   * start is invisible. It is fatal for an OfflineAudioContext, which renders as
   * fast as it can and does not wait for anything — so `startRendering()` fired
   * before the worklet had connected and every Surge render came back at EXACTLY
   * -inf dBFS, three chains in a row, which is the signature of a harness fault
   * rather than three independent bugs (tests/patch_sound_probe.mjs records the
   * same tell). A `setTimeout` long enough to usually work is not a fix; it is a
   * flake with a stopwatch.
   *
   * It resolves rather than rejects on failure, because a caller's question is
   * "may I render now" and both answers are useful — `surgeFailure()` says what
   * went wrong for anyone who needs it.
   */
  let markReady;
  const ready = new Promise((resolve) => { markReady = resolve; });

  // ── THE ASYNC HALF ────────────────────────────────────────────────────────
  // Deliberately not awaited by anything: the module is usable (connectable,
  // level-rampable) from the moment this function returns, and Surge joins when it
  // can. A failure is reported LOUDLY and leaves the gain silent rather than
  // throwing into a caller that has already been handed a working module.
  (async () => {
    try {
      // ── THE QUARANTINE DOOR STAYS SHUT IN BARE NODE ───────────────────────
      // `worklet_urls.js` holds Vite-only specifiers and is reachable ONLY by this
      // dynamic import (its own header states the law). Bare node has no
      // `audioWorklet`, so a node process — every core suite, cli/render.js — has
      // nothing to load and must not open that door: doing so throws on a `?url`
      // specifier and prints an unhandled rejection into a green test run. This is
      // the same reason `engine.portBlockWorkletUrls()` is only reached from
      // `init()`, which node never calls.
      if (!context.audioWorklet) { markReady(false); return; }
      const { SURGE_WORKLET_URL, SURGE_DATA_INDEX_URL } = await import("./worklet_urls.js");
      const [wasmBinary, index, archive] = await Promise.all([
        fetchSurgeAsset(SURGE_ENGINE_WASM_URL),
        fetch(SURGE_DATA_INDEX_URL).then((r) => r.json()),
        fetchSurgeAsset(SURGE_DATA_BIN_URL),
        context.audioWorklet.addModule(SURGE_WORKLET_URL),
      ]);
      if (disposed) { markReady(false); return; }

      const built = new AudioWorkletNode(context, SURGE_PROCESSOR, {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        processorOptions: {
          wasmBinary,
          sampleRate: context.sampleRate,
          dataPath: SURGE_DATA_ROOT,
          surgeData: { files: index.files, bytes: archive },
        },
      });
      // THE ONLY MESSAGE THE WORKLET SENDS THAT WE MUST NOT DROP. A rejection inside
      // an AudioWorkletProcessor's constructor is invisible to `onprocessorerror`
      // AND to the console, so the bundle's own `.catch` turns it into this message.
      // WebSurge's app ignores it; ignoring it here would mean a synth that is
      // silent for a reason nobody can see.
      built.port.onmessage = (event) => {
        if (event.data?.type === "error") {
          failure = `Surge engine failed to start: ${event.data.message}`;
          console.error(failure, event.data.stack ?? "");
        }
      };
      built.onprocessorerror = () => {
        failure = "Surge's audio processor crashed; this node is silent until the patch is rebuilt.";
        console.error(failure);
      };
      built.connect(output);
      node = built;
      for (const message of queued) built.port.postMessage(message);
      queued.length = 0;
      markReady(true);
    } catch (err) {
      failure = err?.message ?? String(err);
      console.error(failure);
      markReady(false);
    }
  })();

  return {
    // NO AUDIO INPUTS. Surge is a source: it takes notes, not signal. `level` is the
    // one wireable input and it is the gain's own param, so an LFO patched into it
    // does exactly what it does on every other module.
    inputs: { level: output.gain, pitch: pitchBus.offset },
    outputs: { out: output },
    params: {
      level: output.gain,
      pitch: pitchBus.offset,
      /**
       * THE PATCH, AS A PARAM — which is what makes a saved deck reopen playing its
       * own instrument, and slide 3 play a different one.
       *
       * It is a SETTER (engine.setParam's function shape), so the mirror's ordinary
       * knob diff drives it: it is called on birth by `initialParamOps` and then only
       * when the FOLDED value changes. That is the load-on-change requirement met
       * structurally rather than by a guard here — but the guard below exists anyway,
       * because `initialParamOps` fires on every module birth and a rebuild would
       * otherwise re-send an identical 40 KB blob to the worklet for nothing.
       *
       * AN EMPTY STRING IS "SURGE'S OWN DEFAULT", NOT AN ERROR. It is the leaf's
       * default, so every Surge node that has never had a patch loaded carries one,
       * and shipping that to the worklet as a zero-byte patch would replace a working
       * Init with silence.
       */
      patchData: (value) => {
        const next = typeof value === "string" ? value : "";
        if (next === loadedPatch) return;
        loadedPatch = next;
        if (!next) return;
        const bytes = base64ToBytes(next);
        if (!bytes) return; // reported inside; a corrupt leaf must not silence the node
        post({ type: "loadPatch", path: "", name: "", bytes: bytes.buffer });
      },
      modwheel: (value) => post({ type: "cc", channel: 0, cc: 1, value: cc7bit(value) }),
      bend: (value) => post({ type: "pitchBend", channel: 0, value: bend14bit(value) }),
    },
    /** How many voices the pool gives this module. Surge allocates internally too;
     *  this is the pool's size, and 16 matches Surge's own default. */
    meta: { voices: SURGE_VOICES },
    /**
     * Command. THE ENGINE'S START HOOK. A no-op here, and its ABSENCE WAS A FATAL
     * BUG — this method exists because of what happened without it.
     *
     * ── WHAT BROKE, AND WHY NOTHING CAUGHT IT ──────────────────────────────
     * `synth/engine.js addModule` calls `instance.start()` UNCONDITIONALLY (there is
     * no `?.`), because every one of the other ~112 module factories defines it.
     * This one did not, so **`engine.addModule("surge", …)` threw
     * `TypeError: instance.start is not a function` and the Surge node could not be
     * instantiated AT ALL** — not in the editor, not in a presentation, not in an
     * export. The feature was dead on arrival, committed and pushed.
     *
     * `tests/surge_test.js` passed throughout because it never calls `addModule`: it
     * checks the spec, the knob table and the message protocol, all of which were
     * correct. The graph was never built. That is precisely the gap the user's
     * ruling names — "don't theorize about sound. we acrually need to HEAR it" —
     * and it was found by `tests/surge_audio_probe.mjs` on its first run, because a
     * probe that renders audio has to construct the module first.
     *
     * ── WHY A NO-OP IS THE RIGHT FIX, NOT `instance.start?.()` IN THE ENGINE ──
     * Making the engine's call optional would weaken a contract that is currently
     * total: a module that genuinely needs starting and forgets the method would
     * then fail SILENTLY, producing a graph that builds and makes no sound. The
     * contract stays strict and this module states its own answer to it, which is
     * that it has nothing to defer — `pitchBus.start()` already ran during
     * construction, and the worklet begins as soon as its async load resolves
     * (see THE ASYNC HALF above). There is no third thing waiting for a cue.
     */
    start() {},
    /**
     * Command. Sound `frequency` on pool slot `slot`.
     *
     * `time` is ACCEPTED AND IGNORED, and that is a real bound worth naming: the
     * worklet's protocol has no scheduled-note message, so a note fires when its
     * message is delivered rather than at an audio-clock instant. For live playing
     * (a keyboard, a clip driven by the presentation clock) the difference is one
     * render quantum and inaudible. It would matter for tightly sequenced material,
     * and fixing it means adding a timestamp to the vendored bundle's protocol.
     */
    noteOn(slot, frequency, _time) {
      // A caller that named no frequency falls back to the WIRE — read once, here,
      // which is what "sampled at note-on" means.
      const hz = Number.isFinite(frequency) && frequency > 0 ? frequency : pitchBus.offset.value;
      const note = midiNoteFor(hz);
      // A slot the pool is REUSING may still hold a note (a retrigger, or a steal
      // the engine did not separately release). Release it first, or Surge keeps a
      // voice sounding that nothing will ever turn off.
      const held = slotNotes.get(slot);
      if (held !== undefined && held !== note) post({ type: "noteOff", channel: 0, key: held, velocity: 0 });
      slotNotes.set(slot, note);
      post({ type: "noteOn", channel: 0, key: note, velocity: 100 });
    },
    /** Command. Release whatever note pool slot `slot` is holding. */
    noteOff(slot, _time) {
      const note = slotNotes.get(slot);
      if (note === undefined) return;
      slotNotes.delete(slot);
      post({ type: "noteOff", channel: 0, key: note, velocity: 0 });
    },
    /**
     * THE GUI SEAM. The Surge modal owns a SECOND Surge (the GUI wasm holds its own
     * synthesizer and is the authoritative parameter model — see
     * core/audio_specs_surge.js); these are the two calls that carry its decisions to
     * the one that makes sound. Exposed as a plain object rather than as params
     * because neither is a knob: `setParam` is indexed by Surge's own parameter id,
     * of which there are 766, and a patch load is an event.
     */
    surgeControl: {
      /** Query. Resolves once the worklet is connected (true) or could not load
       *  (false). The seam an OFFLINE render must await before `startRendering()`,
       *  and the honest way for the GUI modal to know it may talk to the engine.
       *  See `ready` above for the measured failure that made it necessary. */
      whenReady: () => ready,
      /** Command. One of Surge's own parameters, by index, 0..1. */
      setParam: (index, value) => post({ type: "setParam", index, value }),
      /** Command. Load a patch. `bytes` is present only for an on-demand patch that
       *  is in neither module's filesystem; an archive patch travels by path alone,
       *  because both Surges have the same archive mounted. */
      loadPatch: ({ path, name, bytes }) => post(bytes
        ? { type: "loadPatch", path, name, bytes }
        : { type: "loadPatchPath", path, name }),
      /** Command. Release every sounding note (the panic the modal's piano needs). */
      allNotesOff: () => { slotNotes.clear(); post({ type: "allNotesOff" }); },
      /** Command. A note played from the MODAL's own piano, by MIDI number — which
       *  is what the modal has. It does NOT go through the pool: the pool exists to
       *  allocate the DOCUMENT's notes, and a hand on the modal's keyboard is a live
       *  performance gesture (core/live_control.js's own distinction). */
      noteOn: (note, velocity = 100) => post({ type: "noteOn", channel: 0, key: note, velocity }),
      noteOff: (note) => post({ type: "noteOff", channel: 0, key: note, velocity: 0 }),
    },
    /** Query. What went wrong, or null. */
    surgeFailure: () => failure,
    dispose() {
      disposed = true;
      if (node) { node.port.onmessage = null; node.onprocessorerror = null; node.disconnect(); }
      try { pitchBus.stop(); } catch { /* a ConstantSourceNode that never started */ }
      pitchBus.disconnect();
      output.disconnect();
    },
  };
}

/**
 * Pure function. Base64 back to bytes, or null when the string is not base64.
 *
 * ── WHY IT IS HAND-ROLLED AND NOT `atob` + spread ──────────────────────────
 * The obvious `Uint8Array.from(atob(s), c => c.charCodeAt(0))` is correct but the
 * SPREAD form of it (`String.fromCharCode(...bytes)`, its mirror on the encode
 * side) is what blew the argument stack on a large patch — web/surgeGui.js
 * documents that measurement. This direction uses a loop for the same reason: the
 * largest vendored factory patch is 549 KB, and a decoder that works on every patch
 * anyone tested with and throws on the biggest one is the worst kind of bug.
 *
 * NULL RATHER THAN A THROW, reported once: a corrupt `patchData` leaf (a truncated
 * save, a hand edit) must leave the node playing its current patch with a sentence
 * in the console, not tear down a running presentation.
 *
 * @param {string} b64 - base64 text
 * @returns {Uint8Array|null}
 */
function base64ToBytes(b64) {
  if (typeof atob !== "function") return null; // bare node: nothing to decode into
  try {
    const binary = atob(b64);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  } catch (err) {
    console.error(`Surge: stored patch data is not valid base64 (${err?.message ?? err}); keeping the current patch.`);
    return null;
  }
}

/** Pure function. 0..1, with a non-number reading as the middle of nothing. */
function clamp01(v) {
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
}

/** THE PORT-BLOCK CONTRACT's two exports, so `synth/modules.js` spreads this file
 *  exactly as it spreads every ported block. */
export const BLOCK_MODULE_FACTORIES = { surge: surgeModule };
/** Surge is a worklet module, so it is named here — but it is NOT in
 *  `PORT_BLOCK_MODULES`: that list drives `IMPLEMENTATION` for the ported blocks,
 *  and Surge is not one. See modules.js, which names it directly. */
export const BLOCK_WORKLET_MODULES = ["surge"];
