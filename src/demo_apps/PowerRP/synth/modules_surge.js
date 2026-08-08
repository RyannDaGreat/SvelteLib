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

  function post(message) {
    if (disposed) return;
    if (node) node.port.postMessage(message);
    else queued.push(message);
  }

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
      if (!context.audioWorklet) return;
      const { SURGE_WORKLET_URL, SURGE_DATA_INDEX_URL } = await import("./worklet_urls.js");
      const [wasmBinary, index, archive] = await Promise.all([
        fetchSurgeAsset(SURGE_ENGINE_WASM_URL),
        fetch(SURGE_DATA_INDEX_URL).then((r) => r.json()),
        fetchSurgeAsset(SURGE_DATA_BIN_URL),
        context.audioWorklet.addModule(SURGE_WORKLET_URL),
      ]);
      if (disposed) return;

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
    } catch (err) {
      failure = err?.message ?? String(err);
      console.error(failure);
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
      modwheel: (value) => post({ type: "cc", channel: 0, cc: 1, value: cc7bit(value) }),
      bend: (value) => post({ type: "pitchBend", channel: 0, value: bend14bit(value) }),
    },
    /** How many voices the pool gives this module. Surge allocates internally too;
     *  this is the pool's size, and 16 matches Surge's own default. */
    meta: { voices: SURGE_VOICES },
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
