/**
 * AX-1 MODULE FACTORIES — one factory per ported Axoloti node in this block.
 *
 * ── THE UNIFORM SHAPE, RESTATED FROM synth/modules.js ───────────────────────
 * Every factory takes `(context, params, resources)` and returns
 * `{inputs, outputs, params, start(), dispose(), meta}`. The engine NEVER
 * special-cases a module type — it looks ports up by name and ramps gains around
 * them — which is why adding a whole block of modules needs no engine change beyond loading
 * this block's worklet file. Read synth/modules.js's header first; every convention
 * in it applies here unchanged.
 *
 * A SEPARATE FILE for the mechanical reason core/audio_specs_ax1.js is separate:
 * R7-17 has many agents landing modules at once, and MODULE_FACTORIES is where they
 * meet. `BLOCK_MODULE_FACTORIES` below is what the barrel spreads.
 *
 * ── WHY EVERY ONE OF THESE IS A WORKLET ─────────────────────────────────────
 * synth/modules.js states the implementation law: native AudioNodes FIRST, because
 * they are C++ under the hood, and a worklet is an exception that has to justify
 * itself. Every module here qualifies, and for one reason each rather than by category:
 *
 *   - `axMath`'s twenty operations include comparison, absolute value, four
 *     saturating multipliers and an antialiased ring modulator. A GainNode can
 *     multiply and a WaveShaper can bend a curve; neither can branch on an operation.
 *   - `axSmooth`, `axCounter`, `axLatch`, `axLogic`, `axConvert`'s ramp and every
 *     `axSteps*` node carry STATE ACROSS CONTROL TICKS. There is no native node whose
 *     output depends on its own previous output at 3000 Hz.
 *   - `axDivRem`, `axDecode`, `axStepsBool`, `axStepsMulti` have MULTIPLE OUTPUTS
 *     computed together from one input.
 *   - `axStereoOut` needs a HARD CLIP; a DynamicsCompressor is a limiter, which is a
 *     different sound, and that difference is the point of porting it.
 *   - `axWindow` and `axShaper` are transfer functions a WaveShaper genuinely could
 *     do — but a WaveShaper's curve is a construct-time array, so a keyframed
 *     breakpoint would rebuild the node on every frame of a tween. They stay here.
 *   - `axMidiKeyb`, `axMidiBend` and `axMidiTouch` are EDGE DETECTORS with latched
 *     state (`gate2` is `gate` delayed one control tick; `trig` is one tick on a value
 *     change), which no native node has, and `axMidiKeyb` additionally has FIVE
 *     outputs computed together.
 *   - `axPolyVoices` holds an allocation TABLE — sixteen priorities searched per
 *     note — and reports one slot of it on five outputs. Nothing native is close.
 *
 * ── THE K-RATE CONTRACT THESE MODULES DEPEND ON ─────────────────────────────
 * The processors run 8 control ticks per 128-frame quantum so that Axoloti's 3000 Hz
 * control rate is reproduced exactly. Nothing in THIS file can get that wrong, but
 * anything that replaces a worklet here with a native node MUST preserve it —
 * hoisting to once per quantum makes every counter and glide run 8× slow, silently.
 *
 * ── ZERO PowerRP IMPORTS, AND THIS FILE GOT IT WRONG FIRST ─────────────────
 * The ENGINE law: PowerRP controls the synth, the synth never reaches back. The first
 * version of this file imported `AX1_SPECS` from core/ to DERIVE each factory's
 * parameter list, on the reasoning that deriving beats restating. That was a real
 * violation, and it went unnoticed because `tests/synth_engine_test.js`'s check
 * iterates a HARD-CODED list of five synth files — so a new one is exempt by default.
 * (Reported to the lead; that list mirrors the contents of `synth/` and ought to be
 * derived from it, which is the project's own "no hand-maintained list" rule.)
 *
 * So the port and parameter tables below are STATED here, in the engine, and pinned
 * against the specs by tests/port_ax1_test.js. That is not a worse design — it is the
 * arrangement core/audio_specs.js and synth/modules.js already have, and the reason
 * core/audio_specs.js's header gives for it applies verbatim: core must run in bare
 * node with no AudioContext in its import graph, so the description and the thing it
 * describes are connected by a CHECKED CLAIM rather than by an import.
 */

import { clampParam } from "./dsp.js";

/**
 * The URL of this block's worklet module. synth/engine.js loads `processors.js` from
 * a `new URL(…, import.meta.url)` for the same reason: the path must resolve against
 * THIS file's location so a bundler can fingerprint it, not against the page's.
 */
// BLOCK_WORKLET_URL moved to synth/worklet_urls.js — see that file: a Vite
// `?worker&url` specifier here would make this module un-importable by bare node.

/**
 * Pure function. An indexed family of port or parameter names — `numbered("v", 16)`
 * is the sixteen step values, `numbered("i", 8)` the mux's eight inputs.
 *
 * Within-file generation, which the ENGINE law has nothing to say about: what it
 * forbids is reaching into core/, not writing a loop. Sixteen names spelled out is
 * sixteen chances to skip one, and a skipped `v9` is a step that silently stays at
 * its default.
 *
 * @param {string} prefix - the name stem
 * @param {number} count - how many
 * @param {number} [from] - the first index, 0 unless stated
 * @returns {string[]}
 *
 * @example numbered("i", 3) // ["i0", "i1", "i2"]
 * @example numbered("o", 4, 1) // ["o1", "o2", "o3", "o4"]
 */
function numbered(prefix, count, from = 0) {
  return Array.from({ length: count }, (unused, i) => `${prefix}${i + from}`);
}

// THE PORT-FAMILY WIDTHS, restated from the source objects they come from. They also
// appear in core/audio_specs_ax1.js and in the worklet, three times in all — the
// ENGINE law forbids the first two from importing each other and the worklet cannot
// import at all, so the copies are structural. tests/port_ax1_test.js compares every
// port list across all three, which is what turns the restatement into a checked
// claim rather than three numbers waiting to disagree.

/** `tiar/kfunc/u4u`: four segments, so five breakpoints. */
const AX_SHAPER_POINTS = 5;
/** `mux/mux 8`. The 2- and 4-wide members of the family are this switch truncated. */
const AX_MUX_WIDTH = 8;
/** `sel b 16 4t`: four parallel gate tracks. */
const AX_STEP_TRACKS = 4;
/** `sel … 16`: sixteen steps, and what the `chain` outlet subtracts. */
const AX_STEP_COUNT = 16;
/** `sel 4l 16 8t s`: eight selectable pattern rows. */
const AX_MULTI_ROWS = 8;

/**
 * Command. Set a worklet node's AudioParams from a params object, clamped to each
 * param's own declared range.
 *
 * A near-copy of synth/modules.js's private `setWorkletParams` — it is not exported
 * there, and this file may not edit it. The duplication is eleven lines and is noted
 * to the lead as the one thing worth hoisting when the AX-* blocks merge.
 *
 * @param {AudioWorkletNode} node - the node to configure
 * @param {object} values - caller-supplied initial values
 * @param {string[]} names - the parameter names to apply
 */
function applyParams(node, values, names) {
  for (const name of names) {
    if (values[name] === undefined) continue;
    const param = node.parameters.get(name);
    if (!param) throw new Error(`modules_ax1: worklet has no parameter ${JSON.stringify(name)}`);
    param.value = clampParam(values[name], param.minValue, param.maxValue, name);
  }
}

/**
 * Command. Collect a worklet node's AudioParams into the `{name: AudioParam}` map the
 * engine's setParam and the mirror's wiring both read.
 *
 * @param {AudioWorkletNode} node - the node
 * @param {string[]} names - which parameters to expose
 * @returns {object} name → AudioParam
 */
function paramMap(node, names) {
  const map = {};
  for (const name of names) {
    const param = node.parameters.get(name);
    if (!param) throw new Error(`modules_ax1: worklet has no parameter ${JSON.stringify(name)}`);
    map[name] = param;
  }
  return map;
}

/**
 * Command. Build a module around one of this block's worklet processors.
 *
 * A block of factories that differ in a processor name, an input count and an output
 * count is the same "one shape, N values" situation core/audio_nodes.js solves for
 * the widgets, and the reason is the same: nineteen hand-written copies is nineteen
 * chances to forget `dispose`, or to expose a param the spec does not declare.
 *
 * @param {object} options
 * @param {string} options.processor - the registered processor name, e.g. "ax1-math"
 * @param {string} options.type - the spec type this implements, recorded so
 *   tests/port_ax1_test.js can pin the two together
 * @param {string} options.label - the human name for `meta`
 * @param {string[]} options.inputs - AUDIO port names, in the processor's input-index
 *   order. The order is load-bearing: it is what `connect(…, inputIndex)` takes.
 * @param {string[]} options.outputs - port names, in the processor's output-index order
 * @param {string[]} [options.params] - AudioParam names, matching the spec's knobs
 * @param {string[]} [options.discrete] - knob keys that are DISCRETE and travel by
 *   message rather than as AudioParams (a waveform cannot crossfade — synth/modules.js
 *   states this reasoning for the quantizer's scale table)
 * @param {string[]} [options.paramInlets] - which params are ALSO inlets. § R7-11 says
 *   every param implicitly gets a same-named inlet and most take it — but the shaper's
 *   five breakpoints deliberately do NOT, because five extra beads on a card whose
 *   whole content is five knobs is a worse node. Stated per module rather than
 *   inferred, because exposing a port the spec does not declare would make the engine
 *   and the description disagree about what can be WIRED.
 * @param {number} [options.outputChannels] - channels per output; 1 unless stated
 * @returns {function} a module factory of the engine's uniform shape
 */
function ax1WorkletModule(options) {
  const {
    processor, type, label, inputs, outputs,
    params: audioParamNames = [], discrete = [], paramInlets = [], outputChannels = 1,
  } = options;
  // The factory's own declaration, kept on the returned function so the test can read
  // it back and compare it with the spec. A claim you cannot inspect is not checkable.
  const declaration = { processor, type, inputs, outputs, params: audioParamNames, discrete, paramInlets };

  function factory(context, params = {}) {
    const node = new AudioWorkletNode(context, processor, {
      numberOfInputs: inputs.length,
      numberOfOutputs: outputs.length,
      outputChannelCount: outputs.map(() => outputChannels),
    });
    applyParams(node, params, audioParamNames);
    for (const name of discrete) {
      if (params[name] !== undefined) node.port.postMessage({ [name]: params[name] });
    }
    // A processor that refuses an unknown discrete value posts an error rather than
    // emitting silence. Surfacing it is the difference between "the port is broken"
    // and "the port told you which operation it did not recognise".
    node.port.onmessage = (event) => {
      if (event.data && event.data.error) console.error(`ax1 worklet: ${event.data.error}`);
    };

    // A single-input, single-output module exposes its ports as the node itself, the
    // way every module in synth/modules.js does. A multi-port one must name the
    // INDEX, because Web Audio's connect() takes one.
    const portRef = (names, index) => (names.length === 1 ? node : { node, index });

    const modulePorts = {};
    inputs.forEach((name, index) => { modulePorts[name] = portRef(inputs, index); });
    // A knob that is ALSO an inlet — the § R7-11 param/inlet duality rule that saves
    // Axoloti's ~70 duplicated ` m` objects — lands here as its AudioParam, which is
    // what lets a wire sum into the knob's value instead of replacing it.
    for (const name of paramInlets) {
      if (!modulePorts[name]) modulePorts[name] = node.parameters.get(name);
    }

    const moduleOutputs = {};
    outputs.forEach((name, index) => { moduleOutputs[name] = portRef(outputs, index); });

    return {
      inputs: modulePorts,
      outputs: moduleOutputs,
      // THE NODE ITSELF, exposed for the one thing the uniform shape cannot express: a
      // module that also takes NOTES (§ R7-PLAYABLE) has to reach `port.postMessage`
      // from a wrapper the generic factory knows nothing about. Nothing in the engine
      // reads this key — it looks modules up by `inputs`/`outputs`/`params` — so it is
      // an extension point rather than a widening of the module contract.
      workletNode: node,
      params: {
        ...paramMap(node, audioParamNames),
        ...Object.fromEntries(discrete.map((name) => [name, (value) => node.port.postMessage({ [name]: value })])),
      },
      start() {},
      dispose() {
        node.port.onmessage = null;
        node.disconnect();
      },
      meta: { kind: processor, label },
    };
  };

  // Readable back off the factory, so the spec ⇄ engine agreement is a CHECKED claim
  // (tests/port_ax1_test.js) rather than two lists nobody compares. This is the seam
  // the ENGINE law forces: no import may connect them, so a test must.
  factory.ax1Declaration = Object.freeze(declaration);
  return factory;
}

// ─── The factories ───────────────────────────────────────────────────────────
// Port ORDER is load-bearing: it is the processor's input/output INDEX, which is what
// `connect(dest, outputIndex, inputIndex)` takes. A reordering here silently rewires
// a patch, so each list is written in the same order as the spec's own ports.

/** `math/op` — the arithmetic shelf. `operation` is discrete; `b` is knob AND inlet. */
const axMathModule = ax1WorkletModule({
  processor: "ax1-math", type: "audio_ax_math", label: "Math",
  inputs: ["a"], outputs: ["out"],
  params: ["b"], discrete: ["operation"], paramInlets: ["b"],
});

/** `math/smooth` + `math/glide` — the one-pole, at 3000 Hz. */
const axSmoothModule = ax1WorkletModule({
  processor: "ax1-smooth", type: "audio_ax_smooth", label: "Smooth",
  inputs: ["in"], outputs: ["out"],
  params: ["time", "enable"], paramInlets: ["enable"],
});

/** `math/window` — the Hann window, per sample. */
const axWindowModule = ax1WorkletModule({
  processor: "ax1-window", type: "audio_ax_window", label: "Hann Window",
  inputs: ["phase"], outputs: ["out"],
});

/** `math/divremc` — divide and remainder, two outputs from one input. */
const axDivRemModule = ax1WorkletModule({
  processor: "ax1-divrem", type: "audio_ax_divrem", label: "Divide / Remainder",
  inputs: ["in"], outputs: ["div", "rem"],
  params: ["denominator"], paramInlets: ["denominator"],
});

/** `tiar/kfunc/u4u` — the five-point control shaper. */
const axShaperModule = ax1WorkletModule({
  processor: "ax1-shaper", type: "audio_ax_shaper", label: "4-Segment Shaper",
  inputs: ["in"], outputs: ["out"],
  // NO paramInlets: five breakpoints would be five extra beads on a card whose whole
  // content is five knobs. The spec declares no inputs for them either, and the test
  // pins that the two agree.
  params: numbered("p", AX_SHAPER_POINTS),
});

/** `conv/*` — the range maps and the deliberately-late k→s ramp. */
const axConvertModule = ax1WorkletModule({
  processor: "ax1-convert", type: "audio_ax_convert", label: "Convert",
  inputs: ["in"], outputs: ["out"], discrete: ["mode"],
});

/** `logic/*` — AND, NOT and the two edge detectors. */
const axLogicModule = ax1WorkletModule({
  processor: "ax1-logic", type: "audio_ax_logic", label: "Logic",
  inputs: ["a"], outputs: ["out"],
  params: ["b"], discrete: ["operation"], paramInlets: ["b"],
});

/** `logic/counter` — count and carry, with an independent reset. */
const axCounterModule = ax1WorkletModule({
  processor: "ax1-counter", type: "audio_ax_counter", label: "Counter",
  inputs: ["trig", "reset"], outputs: ["count", "carry"],
  params: ["maximum"],
});

/** `logic/latch` — sample on a rising edge, with no hysteresis. */
const axLatchModule = ax1WorkletModule({
  processor: "ax1-latch", type: "audio_ax_latch", label: "Latch",
  inputs: ["in", "trig"], outputs: ["out"],
});

/** `logic/decode/int 8` — eight one-hot gates plus the cascade chain. */
const axDecodeModule = ax1WorkletModule({
  processor: "ax1-decode", type: "audio_ax_decode", label: "Decode 8",
  inputs: ["in"], outputs: ["o0", "o1", "o2", "o3", "o4", "o5", "o6", "o7", "chain"],
});

/** `mux/mux 8` — eight inputs, one selector. */
const axMuxModule = ax1WorkletModule({
  processor: "ax1-mux", type: "audio_ax_mux", label: "Mux",
  inputs: numbered("i", AX_MUX_WIDTH), outputs: ["out"],
  params: ["select"], paramInlets: ["select"],
});

/** `sel b 16 4t` — four gate patterns, one index. */
const axStepsBoolModule = ax1WorkletModule({
  processor: "ax1-steps-bool", type: "audio_ax_steps_bool", label: "Step Gates",
  inputs: ["index", "default"], outputs: [...numbered("o", AX_STEP_TRACKS, 1), "chain"],
  params: [...numbered("p", AX_STEP_TRACKS, 1), "pulse"],
});

/** `sel fb 16` / `sel fp 16` — sixteen stored values, one index. */
const axStepsValueModule = ax1WorkletModule({
  processor: "ax1-steps-value", type: "audio_ax_steps_value", label: "Step Values",
  inputs: ["index", "default"], outputs: ["out", "chain"],
  params: numbered("v", AX_STEP_COUNT),
});

/** `sel 4l 16 8t s` — eight rows of sixteen four-level steps. */
const axStepsMultiModule = ax1WorkletModule({
  processor: "ax1-steps-multi", type: "audio_ax_steps_multi", label: "Step Levels",
  // `chain_row` snake_case: these strings ARE the spec's port keys (port_ax1_test
  // pins the two lists equal), and a published port name must be spellable by an
  // equation. See the note on AX_STEPS_MULTI_SPEC's outputs.
  inputs: ["index", "default"], outputs: ["out", "chain", "chain_row"],
  params: ["row", ...numbered("t", AX_MULTI_ROWS)], paramInlets: ["row"],
});

/** `midi/in/keyb` (+ `keyb zone lru`'s zone) — the HERTZ→SEMITONE adaptor that makes an
 *  Axoloti patch playable. `velocity` and `release_velocity` are knobs AND inlets so a
 *  sequencer's accent lane can drive them; the ZONE is knob-only, because a wired zone
 *  boundary is a control nobody has a use for and two more beads on a busy card. */
const axMidiKeybModule = ax1WorkletModule({
  processor: "ax1-midi-keyb", type: "audio_ax_midi_keyb", label: "AX MIDI Keyboard",
  inputs: ["pitch", "gate"],
  outputs: ["note", "gate", "gate2", "velocity", "release_velocity"],
  params: ["start_note", "end_note", "velocity", "release_velocity"],
  paramInlets: ["velocity", "release_velocity"],
});

/** `midi/in/bend` — the bender's position in, a pitch interval out. */
const axMidiBendModule = ax1WorkletModule({
  processor: "ax1-midi-bend", type: "audio_ax_midi_bend", label: "AX MIDI Bend",
  inputs: [], outputs: ["bend", "trig"],
  params: ["position"], paramInlets: ["position"],
});

/** `midi/in/touch` — channel pressure, and a trigger on every move. */
const axMidiTouchModule = ax1WorkletModule({
  processor: "ax1-midi-touch", type: "audio_ax_midi_touch", label: "AX Channel Pressure",
  inputs: [], outputs: ["o", "trig"],
  params: ["pressure"], paramInlets: ["pressure"],
});

/**
 * `patch/patcher poly=N` — the VOICE ALLOCATOR (§ R7-POLY), and THE BLOCK'S ONE NOTE
 * SINK (§ R7-PLAYABLE).
 *
 * `voices` and `voice` get no inlet: one is a pool size and the other is which slot this
 * node reports, and a wire into either would be asking the graph to renumber its own
 * voices at audio rate. `velocity` and `release_velocity` DO — they are knobs a wire
 * sums into, which is what stops an unwired node reporting a velocity of zero.
 */
const buildPolyVoices = ax1WorkletModule({
  processor: "ax1-poly-voices", type: "audio_ax_poly_voices", label: "AX Poly Voices",
  // `play` is a METHOD port and so is NOT here: `core/audio_mirror_diff` never connects
  // a method wire, and `synth/modules.js polyPad` likewise keeps its `gate` out of its
  // inputs map. It reaches the module as noteOn/noteOff below, not as an AudioNode.
  inputs: ["note", "gate", "gate2"],
  outputs: ["note", "gate", "gate2", "velocity", "release_velocity"],
  params: ["voices", "voice", "velocity", "release_velocity"],
  paramInlets: ["velocity", "release_velocity"],
});

/**
 * Pure function. Hertz to Axoloti semitones (0 = MIDI 64 = E4) — the inverse of
 * `core/audio_nodes.semitonesToHz`, restated here because synth/** may not import
 * core/** and pinned against it by tests/port_ax1_test.js.
 *
 * ⚠ THIS IS § R7-AXO-TRAPS TRAP 1'S ONE SEAM. `core/live_control.noteRoutes` hands
 * `engine.noteOn` a frequency in HERTZ and every Axoloti pitch port reads SEMITONES; a
 * key played straight through would arrive transposed by its own frequency in semitones
 * — A440 as semitone 440, which is 36 octaves up and therefore silent. Converting here
 * rather than in each patch is what makes it one seam instead of seventeen.
 *
 * @param {number} hz - the note's frequency
 * @returns {number} semitones from E4; NaN for a non-positive frequency
 *
 * @example polyVoicesHzToSemitones(440) // 5
 * @example Math.round(polyVoicesHzToSemitones(329.6275569128699)) // 0
 * @example Number.isNaN(polyVoicesHzToSemitones(0)) // true
 */
function polyVoicesHzToSemitones(hz) {
  if (!(hz > 0)) return NaN;
  return POLY_A440_SEMITONES + POLY_SEMITONES_PER_OCTAVE * Math.log2(hz / POLY_A440_HZ);
}

/** A440 in Axoloti semitones (MIDI 69 − 64), and the octave's width. Restated from
 *  synth/ax1_dsp.js, which restates core/audio_nodes.semitonesToHz. */
const POLY_A440_HZ = 440;
const POLY_A440_SEMITONES = 5;
const POLY_SEMITONES_PER_OCTAVE = 12;

/**
 * Command. `patch/patcher poly=N` as a module the KEYBOARD CAN PLAY (§ R7-PLAYABLE).
 *
 * A wrapper rather than a bare `ax1WorkletModule` for the same reason `axStereoOut` is
 * one: it needs a surface the generic factory does not build. Here that surface is
 * `noteOn`/`noteOff`, which is EXACTLY what `synth/engine.js:629-631` looks for —
 * declaring them is what earns this module a voice pool, and `meta.voices` is what
 * sizes that pool to the patcher's own `poly=N` instead of `DEFAULT_POLY_VOICES`.
 *
 * THE ENGINE OWNS THE ALLOCATION ON THIS PATH AND THIS MODULE OWNS THE SOUND, which is
 * the split `synth/engine.js:825-845` states: the pool decides the slot, the module is
 * handed one. So the Axoloti LRU inside the processor is NOT consulted for a played
 * note — a real divergence from the source, named on the spec, and the price of having
 * one steal policy for every poly module in the app.
 *
 * @param {AudioContext} context - the audio context
 * @param {object} params - construct params; `voices` sizes the engine's pool
 * @returns {object} the engine's uniform module shape, plus noteOn/noteOff
 */
function axPolyVoicesModule(context, params = {}) {
  const module = buildPolyVoices(context, params);
  const node = module.params.voices;
  return {
    ...module,
    // READ BY synth/engine.js's addModule: `createVoicePool(instance.meta?.voices ?? …)`.
    // Without it every patcher would get an 8-voice pool and the harvested 7 / 8 / 5 / 3
    // would be a knob that changed nothing about who gets stolen.
    meta: { ...module.meta, voices: node ? node.value : undefined },
    // ── `voices` IS NOT A LIVE SETTER, AND MUST NOT ADVERTISE ITSELF AS ONE ──
    // The worklet keeps it as an AudioParam because that is how the value crosses to the
    // audio thread, and the processor uses it to narrow its per-tick SEARCH. But the
    // ENGINE reads it exactly once, above, to size the voice pool a played note is
    // allocated from — so a live change would leave the pool and the node disagreeing
    // about how many voices exist, which is a stuck or stolen note rather than a knob
    // that does nothing.
    //
    // The spec is right to mark it `construct: true` (a change REBUILDS the module, which
    // is what keeps pool and processor in step). Leaving it in `params` contradicted that
    // by handing the mirror a setter, and tests/audio_nodes_test.js caught the pair
    // disagreeing: "marked construct:true but engine module DOES expose it as a param".
    // The flag is not the thing to drop — the setter is.
    params: Object.fromEntries(Object.entries(module.params).filter(([k]) => k !== "voices")),
    /**
     * Command. Sound `frequency` on the slot the ENGINE's pool chose.
     *
     * `time` is accepted and cannot be honoured: a `postMessage` is applied at the next
     * control tick, so a note lands within one quantum (2.67 ms at 48 kHz) of where the
     * engine asked for it. Inaudible for a played key; not good enough for a sequenced
     * one. Stated rather than silently rounded.
     */
    noteOn(slot, frequency) {
      const semitones = polyVoicesHzToSemitones(frequency);
      if (!Number.isFinite(semitones)) {
        throw new RangeError(`axPolyVoices.noteOn: ${JSON.stringify(frequency)} Hz has no pitch — a note needs a positive frequency`);
      }
      postNote(module, { slot, semitones, on: true });
    },
    /** Command. Release the slot the engine's pool named. */
    noteOff(slot) {
      postNote(module, { slot, on: false });
    },
  };
}

// The spec ⇄ engine claim the generic factory records is kept on the WRAPPER too, so
// tests/port_ax1_test.js's port and param checks still reach this module. `axStereoOut`
// does not do this and is exempt from those checks as a result — a hole worth not
// widening, reported to the lead rather than fixed in a file this block does not own.
axPolyVoicesModule.ax1Declaration = buildPolyVoices.ax1Declaration;

/**
 * Command. Post one note event to the processor.
 *
 * Factored out so both halves spell the message the same way; the processor rejects an
 * out-of-range slot LOUDLY rather than dropping it, because a slot the table does not
 * have means the engine's pool and this module disagree about the voice count.
 *
 * @param {object} module - the built worklet module
 * @param {object} note - {slot, semitones?, on}
 */
function postNote(module, note) {
  module.workletNode.port.postMessage({ note });
}

/**
 * `sss/audio/StOutVol` — the stereo output with a hard clip.
 *
 * THE ONLY FACTORY HERE THAT IS NOT A BARE `ax1WorkletModule`, because it is a
 * TERMINAL module and must reach the engine's master bus. synth/modules.js's
 * outputModule states the rule and the reason: `resources.destination`, never
 * `context.destination` — an output wired straight to the destination would be
 * audible while the rest of the session was muted and invisible to a recorder, which
 * is a plausible-looking failure in both directions.
 */
const buildStereoOut = ax1WorkletModule({
  processor: "ax1-stereo-out", type: "audio_ax_stereo_out", label: "Stereo Out",
  inputs: ["left", "right"], outputs: ["out"], outputChannels: 2,
  params: ["volume"], paramInlets: ["volume"],
});

function axStereoOutModule(context, params = {}, resources) {
  if (!resources?.destination) {
    throw new Error("axStereoOutModule: resources.destination (the engine's master bus) is required — see the master-chain block in synth/engine.js and outputModule's identical guard");
  }
  const module = buildStereoOut(context, params);
  module.outputs.out.connect(resources.destination);
  const disposeWorklet = module.dispose;
  return {
    ...module,
    // The spec declares NO outputs: sound leaves here. Keeping `outputs` empty is what
    // stops the editor offering a wire out of a terminal node.
    outputs: {},
    tap: module.outputs.out,
    dispose() {
      module.outputs.out.disconnect();
      disposeWorklet();
    },
  };
}

/**
 * THE AX-1 MODULE REGISTRY — spec `module` name → factory.
 *
 * ── NOT YET SPREAD INTO MODULE_FACTORIES ────────────────────────────────────
 * AX-1 does not own synth/modules.js; the barrel line is reported to the lead. Until
 * it lands, `engine.addModule("axMath", …)` throws its ordinary "unknown module"
 * error, which is the correct behaviour for a module that is written but not
 * registered — the same failure mode plugins/audio_index.js's docblock describes.
 *
 * A spec whose `module` names a factory that is not here is a node that appears in
 * the palette and throws when you place it. That agreement cannot be checked HERE any
 * more (the ENGINE law forbids importing the specs), so tests/port_ax1_test.js checks
 * it in both directions — every spec has a factory, and every factory has a spec.
 */
export const BLOCK_MODULE_FACTORIES = {
  axMath: axMathModule,
  axSmooth: axSmoothModule,
  axWindow: axWindowModule,
  axDivRem: axDivRemModule,
  axShaper: axShaperModule,
  axConvert: axConvertModule,
  axLogic: axLogicModule,
  axCounter: axCounterModule,
  axLatch: axLatchModule,
  axDecode: axDecodeModule,
  axMux: axMuxModule,
  axStepsBool: axStepsBoolModule,
  axStepsValue: axStepsValueModule,
  axStepsMulti: axStepsMultiModule,
  axMidiKeyb: axMidiKeybModule,
  axMidiBend: axMidiBendModule,
  axMidiTouch: axMidiTouchModule,
  axPolyVoices: axPolyVoicesModule,
  axStereoOut: axStereoOutModule,
};

/** The types whose factory builds an AudioWorkletNode. See core/audio_blocks.js. */
export const BLOCK_WORKLET_MODULES = Object.keys(BLOCK_MODULE_FACTORIES);
