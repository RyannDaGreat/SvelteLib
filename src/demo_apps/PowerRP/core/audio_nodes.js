/**
 * AUDIO NODES — the bridge between one synth module and one PowerRP node widget.
 *
 * ── WHAT THIS FILE IS, AND WHY IT IS ONE FILE ───────────────────────────────
 * There are 23 engine modules today and the user expects "upwards of a hundred"
 * nodes eventually (ADDENDUM 3). Written out longhand, each would be a ~110-line
 * plugin file that differs from its neighbours in about twelve values: a title, a
 * family, a port list, a knob list. Twenty-three copies of one shape is twenty-three
 * places for the shape to drift, and the drift is not cosmetic — a node whose
 * `defaults` forgets `inputs: {}` cannot have its wires remapped when it is copied
 * (NF-CORE measured exactly that), and one whose `h` is not sized from its own port
 * list paints beads outside its own card.
 *
 * So the SHAPE lives here, once, as `audioNodePlugin(spec)`, and each
 * plugins/audio_*.js is the twelve values that make its module different. That is
 * the same composition route core/node_chrome.js takes for the LOOK and for the
 * same stated reason: no plugin may import another plugin, so anything shared by
 * plugins lives in core.
 *
 * ── THIS FILE IS DOM-FREE AND ENGINE-FREE, DELIBERATELY ─────────────────────
 * core/ must run in bare node (CLAUDE.md), and nothing here may import synth/**.
 * That is not merely a layering preference: the ENGINE constructs an AudioContext,
 * which does not exist in node, so a core module that imported it would break every
 * bare-node suite and cli/render.js with it.
 *
 * What this file therefore holds is the module's *description* — its ports, its
 * knobs, their ranges — not its implementation. The description is checked against
 * the real engine by tests/audio_nodes_test.js, which imports BOTH and asserts that
 * every declared knob is a param the engine actually has and every declared port is
 * a port the engine actually exposes. That test is the seam that keeps a
 * description honest without a runtime dependency.
 *
 * ── THE THREE KINDS OF STATE, FOR AN AUDIO NODE ─────────────────────────────
 * A module's KNOBS and its CONNECTIONS are PROPERTY STATE: ordinary keyframable
 * numeric leaves, folded from the document, so a patch tweens across slides and is
 * reproducible under a shuffle of time. Nothing in this file reads a clock.
 *
 * The SOUND is not state at all — it is a live consumer downstream of that state
 * (blueprint §7), the same way the video player is. web/audioMirror.svelte.js is
 * where the folded state becomes engine calls; this file never touches the engine.
 *
 * ── WHY `computeOutputs` IS ABSENT FOR AUDIO PORTS ──────────────────────────
 * core/nodeflow.js's evaluator is PULL-BASED and computes VALUES. An `audio` port
 * does not carry a value that a document evaluation could produce — it carries a
 * signal that exists only inside the engine's graph, at a sample rate the document
 * has no concept of. So an audio module declares its audio ports for WIRING (the
 * gesture, the type checking, the picture) and computes nothing for them: it is a
 * SINK in the value evaluator's terms, which is exactly what `computeOutputs`'s
 * absence already means (nodeflow's docblock: "A node with no computeOutputs
 * produces nothing, which is what a pure SINK wants").
 *
 * A module with genuine NUMBER outputs would declare computeOutputs; none of the 23
 * has one, because every engine module's outputs are audio-rate. The sequencer's
 * `pitch` is the interesting near-miss and it is audio too — it is a control SIGNAL
 * on an AudioNode, not a number the document knows.
 */

import { EPHEMERAL } from "./ephemeral.js";
import {
  ANALYSIS_DISPLAY_BAND_H, analysisDisplayDefaults, analysisDisplayOps, analysisDisplayRows,
} from "./analysis_display.js";
import { standardBBoxAnchors } from "./derive.js";
import { bundle, bundleNestedDefaults, props } from "./properties.js";
import { NODE_ITEM_REFS, minimumNodeHeight, nodeCardRim, nodeInkBounds, nodeInputRows } from "./nodeflow.js";
import {
  NODE_BODY_GAP, NODE_PAD, NODE_VALUE_INK, familyCard, familyRim, knobOps, nodeBodyTop,
  nodeBox, nodeDefaultSize, nodeFaceBand, nodeFamily, portBeads, portIsWired, textLineH,
} from "./node_chrome.js";
import { KNOB_BAND_MIN_SCALE, KNOB_LABEL_SIZE, KNOB_PITCH_X, KNOB_ROW_H, knobLayout } from "./node_knobs.js";
import { text } from "../render_gpu/ir.js";
import { applyEffects, effectsCullMargin } from "../render_gpu/effects.js";
import * as T from "./transform.js";

/** The Inspector category every audio knob row lands in. One category, so a
 *  module's knobs are one collapsible group rather than scattered among the
 *  universal rows. */
export const AUDIO_CAT = "audio";

/** A node card's default width. Wide enough for a two-word title and a port label
 *  on each side at the default type size; narrow enough that a 6-module patch fits
 *  across a 1920-wide slide with room for its wires. */
export const AUDIO_NODE_W = 150;

/**
 * Pure function. The item-state key a knob's value is stored under.
 *
 * Knobs are stored FLAT (`cutoff: 800`), not nested under a `params` object, and
 * that is a deliberate choice with one concrete consequence: a flat numeric leaf
 * whose plugin default is a NUMBER is an EQUATION SLOT for free
 * (core/expressions.js's rule), so `= ease(time)` works on any knob with no code
 * here. A nested `params.cutoff` would be a leaf too, but its Inspector row and its
 * keyframe path would both need the dotted spelling, and every equation would have
 * to name it that way. Flat is what makes a knob indistinguishable from `w`.
 *
 * The `audio` prefix exists because knob names come from the ENGINE's vocabulary
 * and some of them collide with PowerRP's universal item state: a filter's `type`
 * is its lowpass/highpass mode, but `type` on an item is its WIDGET TYPE, and a
 * module with a `scale` knob would collide with the similarity transform's `scale`.
 * A silent collision there would be a widget that retypes itself when you turn a
 * knob, so the namespace is not optional.
 *
 * @param {string} key - the engine's param name
 * @returns {string} the item-state key
 *
 * @example audioKnobKey("cutoff") // "audioCutoff"
 * @example audioKnobKey("type") // "audioType"
 * @example // the collision this prevents: an item's own `scale` is its similarity transform
 * @example audioKnobKey("scale") // "audioScale"
 */
export function audioKnobKey(key) {
  return "audio" + key.charAt(0).toUpperCase() + key.slice(1);
}

/**
 * Pure function. Every knob of a spec as `{key, stateKey, value}`, read off a
 * folded item state with each knob's own default filled in.
 *
 * THE ONE READER both halves of the feature go through: the audio mirror turns this
 * into setParam calls and the node's own picture reads its readout from it, so what
 * you hear and what you see cannot disagree about what a knob is set to.
 *
 * A knob whose folded value is not a finite number (an unresolved equation, a
 * string that failed to evaluate) falls back to its DEFAULT rather than reaching
 * the engine: `setParam` with a NaN would poison an AudioParam permanently — the
 * Web Audio spec makes a NaN'd param stay NaN, so one bad equation would silence
 * that module for the rest of the session with no way back short of a reload. The
 * equation's own error is already reported by the expression pass; this is about
 * not turning a visible error into an inaudible one. DISCRETE knobs (a waveform
 * name) are strings by nature and skip the numeric check.
 *
 * @param {object} spec - an audio node spec
 * @param {object} s - the folded item state
 * @returns {Array<{key: string, stateKey: string, value: number|string, discrete: boolean}>}
 *
 * @example audioKnobValues({knobs: [{key: "cutoff", default: 800}]}, {audioCutoff: 1200})[0].value // 1200
 * @example audioKnobValues({knobs: [{key: "cutoff", default: 800}]}, {})[0].value // 800
 * @example // a broken equation leaves a STRING in the slot; the default is used instead of NaN
 * @example audioKnobValues({knobs: [{key: "cutoff", default: 800}]}, {audioCutoff: "= nope"})[0].value // 800
 * @example // discrete knobs are strings BY DESIGN and are passed through
 * @example audioKnobValues({knobs: [{key: "waveform", default: "sine", discrete: true}]}, {audioWaveform: "saw"})[0].value // "saw"
 *
 * ── `derived`: A PARAM WITH NO LEAF OF ITS OWN (R7-14) ──────────────────────
 * The third spelling, and the spec vocabulary's newest word. Some engine params
 * are not ONE number an author types — the sequencer's `steps` is a whole pattern,
 * and its `stepCount` is that pattern's LENGTH. Neither can be a flat knob leaf:
 * a pattern is a LIST property (core/lists.js), and a length read from a second
 * leaf beside the list is a second source of truth for a number the list already
 * states. So a `derived` knob declares a PURE FUNCTION of the item state instead
 * of a state key, and everything downstream — `constructParams`, the rebuild test,
 * `setParam`, `transportOf` — reads it exactly as it reads every other knob.
 *
 * It is the same argument `construct: true` settled and the same three options:
 * drop the param (then a piano roll cannot reach the engine at all), pretend it is
 * an ordinary knob (then `Number(raw)` on an array is NaN and the pattern silently
 * becomes the default — the silent failure this project forbids), or DECLARE the
 * shape. This is the declaration.
 *
 * @example // a derived param reads the state through its own function
 * @example audioKnobValues({knobs: [{key: "stepCount", derived: (s) => (s.notes ?? []).length}]}, {notes: [[60], [64]]})[0].value // 2
 */
export function audioKnobValues(spec, s) {
  return (spec.knobs ?? []).map((k) => {
    const stateKey = audioKnobKey(k.key);
    const raw = s?.[stateKey];
    const value = k.derived
      ? k.derived(s ?? {})
      : k.discrete
        ? (typeof raw === "string" ? raw : k.default)
        : (Number.isFinite(Number(raw)) ? Number(raw) : k.default);
    return { key: k.key, stateKey, value, discrete: !!k.discrete };
  });
}

/**
 * Pure function. The Inspector rows for a spec's knobs — DECLARATIVE ONLY.
 *
 * Every row is an ordinary `number` or `select` row on a flat item-state key, which
 * is what makes a knob keyframable, equation-bindable and multi-select-unifiable
 * with no audio-specific code anywhere in web/Inspector.svelte. This function is in
 * core rather than in each plugin so that a knob's row and the mirror's setParam
 * call are generated from ONE declaration and cannot describe different ranges.
 *
 * @param {object} spec - an audio node spec
 * @returns {object[]} Inspector row descriptors
 *
 * @example audioKnobRows({knobs: [{key: "cutoff", label: "Cutoff", default: 800, min: 20, max: 20000, help: "Hz"}]})[0].key // "audioCutoff"
 * @example audioKnobRows({knobs: [{key: "cutoff", label: "Cutoff", default: 800}]})[0].kind // "number"
 * @example audioKnobRows({knobs: [{key: "waveform", label: "Wave", default: "sine", discrete: true, options: ["sine", "square"]}]})[0].kind // "select"
 * @example audioKnobRows({}) // []
 */
export function audioKnobRows(spec) {
  // A DERIVED param has no leaf, so it has no row: its Inspector surface is the
  // property it is derived FROM, which that widget declares itself. A row here
  // would be a field writing a state key nothing reads — the phantom-leaf defect
  // the R7 audio map opens with.
  return (spec.knobs ?? []).filter((k) => !k.derived).map((k) => (k.discrete
    ? { key: audioKnobKey(k.key), label: k.label, kind: "select", options: k.options, category: AUDIO_CAT, help: k.help }
    : { key: audioKnobKey(k.key), label: k.label, kind: "number", min: k.min, max: k.max, step: k.step, category: AUDIO_CAT, help: k.help }));
}

/**
 * Pure function. A spec's `defaults` fragment for its knobs: `{audioCutoff: 800, …}`.
 *
 * @param {object} spec - an audio node spec
 * @returns {object}
 *
 * @example audioKnobDefaults({knobs: [{key: "cutoff", default: 800}, {key: "Q", default: 1}]}) // {audioCutoff: 800, audioQ: 1}
 * @example // a DERIVED param has no leaf, so it contributes none (R7-14) — a stored
 * @example // `audioSteps` beside a derived one would be state nothing ever reads
 * @example audioKnobDefaults({knobs: [{key: "steps", derived: () => []}]}) // {}
 * @example audioKnobDefaults({}) // {}
 */
export function audioKnobDefaults(spec) {
  return Object.fromEntries((spec.knobs ?? []).filter((k) => !k.derived).map((k) => [audioKnobKey(k.key), k.default]));
}

/**
 * Pure function. The `{inputs, outputs}` port declaration for a spec.
 *
 * Ports are declared as `{key, type, label}` exactly like any node widget's, and
 * the TYPE is the port's real signal type in the engine — `audio` for a signal,
 * `number` for a control input a wire can drive, `trigger` for a gate. That is what
 * makes the type checking meaningful: core/nodeflow.js's coercion table decides
 * whether a drop is legal, and it can only be right if these say what is true.
 *
 * `feedbackSafe` rides along per-port. NF-CORE reserved it as the declared escape
 * hatch for exactly this wave: a delay's feedback path is a genuine cycle in the
 * AUDIO domain, where a one-block delay is part of the sound rather than a
 * frame-N-1 dependency the determinism law forbids. Only ports whose module
 * actually delays by at least one render quantum may carry it (see DELAY_SPEC).
 *
 * @param {object} spec - an audio node spec
 * @returns {{inputs: object[], outputs: object[]}}
 *
 * @example audioPorts({inputs: [{key: "in", type: "audio"}]}).inputs[0].label // "in"
 * @example // a METHOD port keeps its flag: it is what decides connect-vs-trigger
 * @example audioPorts({inputs: [{key: "gate", type: "trigger", method: true}]}).inputs[0].method // true
 * @example // and an ordinary port does not grow the key at all
 * @example "method" in audioPorts({inputs: [{key: "in", type: "audio"}]}).inputs[0] // false
 * @example audioPorts({}).outputs // []
 */
export function audioPorts(spec) {
  const norm = (p) => ({
    key: p.key, type: p.type, label: p.label ?? p.key,
    ...(p.feedbackSafe ? { feedbackSafe: true } : {}),
    // `method` RIDES ALONG TOO, and it did not until wave 3. The mirror reads the
    // flag off the SPEC (core/audio_mirror_diff.js), so the feature worked — but
    // anything asking the PLUGIN what its ports are got a port declaration that
    // silently disagreed with the spec about the one thing that decides whether a
    // wire becomes engine.connect or engine.trigger. tests/audio_patches_test.js
    // asked exactly that question and concluded a patch had LOST two wires. A
    // declaration that omits a field is not neutral; it is a confident wrong answer.
    ...(p.method ? { method: true } : {}),
  });
  return { inputs: (spec.inputs ?? []).map(norm), outputs: (spec.outputs ?? []).map(norm) };
}

/**
 * Pure function. The one-line readout an audio node shows in its body: its most
 * telling knob, formatted with its unit.
 *
 * A module has up to eight knobs and a card has room for one line, so a node shows
 * the knob its spec names as `readout` — the cutoff for a filter, the BPM for a
 * clock — and nothing at all when a spec names none (an output module's card is
 * better empty than padded with a number nobody reads). This is a GLANCE, not the
 * Inspector: the full knob set is one click away and does not belong on the card.
 *
 * @param {object} spec - an audio node spec
 * @param {object} s - the folded item state
 * @returns {string} the readout, or "" when the spec declares none
 *
 * ── A KNOB MAY DECLARE `hz(value)`, AND THE READOUT APPENDS IT ──────────────
 * Lead ruling, 2026-08-06: the R7-17 filter ports stay TUNED IN SEMITONES, because
 * Axoloti sums `param_pitch + inlet_pitch` in the pitch domain and that is what makes
 * an LFO of depth 12 sweep an octave wherever the knob is parked. The cost is real —
 * our native `audio_filter` is tuned in HERTZ, so the library now has two tunings for
 * "cutoff" — and the ruling's own mitigation is that the divergence must not be
 * hidden: **"a pitch number with no frequency shown is a control the author cannot
 * reason about."** So a knob whose number is not itself a frequency may say what
 * frequency it means, and the card shows both: `24 st · 1318 Hz`.
 *
 * The MECHANISM is generic: this function knows only "there may be a frequency behind
 * this number" and never which one. A knob supplies the conversion, and the ported
 * blocks supply `semitonesToHz` (below) because they share Axoloti's one tuning law.
 *
 * @param {object} spec - an audio node spec
 * @param {object} s - the folded item state
 * @returns {string} the readout, or "" when the spec declares none
 *
 * @example audioReadout({knobs: [{key: "bpm", default: 120, unit: " BPM"}], readout: "bpm"}, {audioBpm: 96}) // "96 BPM"
 * @example audioReadout({knobs: [{key: "frequency", default: 440, unit: " Hz"}], readout: "frequency"}, {}) // "440 Hz"
 * @example // a discrete knob reads out as its own name, which is the whole value
 * @example audioReadout({knobs: [{key: "character", default: "hall", discrete: true}], readout: "character"}, {}) // "hall"
 * @example // a pitch-domain knob shows the frequency it means, because "st" alone is unreadable
 * @example audioReadout({knobs: [{key: "pitch", default: 24, unit: " st", hz: (p) => 440 * 2 ** ((p - 5) / 12)}], readout: "pitch"}, {}) // "24 st · 1319 Hz"
 * @example audioReadout({knobs: []}, {}) // ""
 */
export function audioReadout(spec, s) {
  if (!spec.readout) return "";
  const knob = (spec.knobs ?? []).find((k) => k.key === spec.readout);
  if (!knob) return "";
  const { value } = audioKnobValues({ knobs: [knob] }, s)[0];
  if (knob.discrete) return String(value);
  const also = typeof knob.hz === "function" ? ` · ${readoutNumber(knob.hz(Number(value)))} Hz` : "";
  return `${readoutNumber(value)}${knob.unit ?? ""}${also}`;
}

/** Below this magnitude a readout keeps two decimals; at or above it, the decimals are
 *  noise on a card that has one line — 1318.51 Hz says nothing 1319 Hz does not. */
const READOUT_DECIMALS_BELOW = 100;

/**
 * Pure function. One number as a readout renders it — the rule applied to BOTH the
 * knob's own value and any frequency it declares, so the two cannot round differently
 * on the same line.
 *
 * @param {number} value - the number to render
 * @returns {number}
 *
 * @example readoutNumber(1318.5102) // 1319
 * @example readoutNumber(0.328194)  // 0.33
 * @example readoutNumber(-64)       // -64
 */
export function readoutNumber(value) {
  return Math.abs(value) >= READOUT_DECIMALS_BELOW ? Math.round(value) : Number(Number(value).toFixed(2));
}

/** A440 anchors equal temperament; on Axoloti's dial it sits five semitones up, because
 *  pitch 0 is MIDI 64 = E4 and A4 is MIDI 69. The pair only means anything together. */
const A440_HZ = 440;
const A440_SEMITONES = 5;
const SEMITONES_PER_OCTAVE = 12;

/**
 * Pure function. Axoloti's pitch domain to hertz — `hz = 440 · 2^((p − 5)/12)`, where
 * pitch 0 is MIDI 64 = E4 = 329.6276 Hz. Every ported block that tunes in semitones
 * shares this one law, so it is stated once for all of them here rather than per block.
 *
 * ── WHY THIS IS A RESTATEMENT AND WHY THAT IS FORCED ────────────────────────
 * The DSP already computes it — `synth/ax2_kernels.axoPitchToHz` and
 * `synth/ax3_kernels.axPitchToHz`. They cannot be shared with this file: `core/` may not
 * import `synth/` (core must run in bare node) and `synth/` may not import PowerRP (the
 * ENGINE law), so a spec that wants to SHOW the frequency its DSP will USE has to say it
 * again. Exactly processors.js restating SCHMITT_LOW, and it gets the same treatment —
 * `tests/audio_nodes_test.js` holds this against BOTH kernels rather than trusting them
 * to agree. It is at least a fourth statement avoided: without it every block that tunes
 * in semitones would carry its own copy.
 *
 * NO CLAMP, deliberately. The filters clamp at fs/2 because they must not alias; a
 * readout's job is to say what the knob is asking for, and silently reporting 24 kHz for
 * every pitch above the clamp would hide the very knob position an author is hunting.
 *
 * @param {number} semitones - Axoloti pitch; 0 is E4
 * @returns {number} hertz
 *
 * @example semitonesToHz(0)   // 329.6275569128699
 * @example semitonesToHz(5)   // 440
 * @example semitonesToHz(24)  // 1318.5102276514797
 * @example semitonesToHz(12) / semitonesToHz(0) // 2
 */
export function semitonesToHz(semitones) {
  return A440_HZ * Math.pow(2, (semitones - A440_SEMITONES) / SEMITONES_PER_OCTAVE);
}

/**
 * Pure function. ONE AUDIO WIDGET'S DISPLAY TITLE — its spec title under the
 * mandatory "Audio " prefix.
 *
 * USER, 2026-08-03 (verbatim): "All audio related widgets should be prefixed with
 * "Audio" like "Audio Delay" etc. Including  patches."
 *
 * ── WHY THIS IS DERIVED AND NOT 24 EDITED LITERALS ─────────────────────────
 * Every audio widget is `audioNodePlugin(SPEC)`, so there is exactly one funnel
 * and prefixing it reaches the card, the palette entry ("Add Audio Delay") and
 * every Inspector title at once. Editing the specs instead would put the rule in
 * 24 places for a NEW spec to forget — the drift audioNodePlugin exists to
 * prevent, arriving through the title field.
 *
 * ── WHAT IS **NOT** PREFIXED, AND WHY ──────────────────────────────────────
 * The generic control, math and display nodes (Knob, Slider, Button, Keyboard,
 * Number, Math, Display) keep their bare names. They are not audio widgets: the
 * founding vision has them driving materials and shapes too, and "Audio Knob"
 * would be a false claim about what a knob can be wired to. They are also not
 * built by this function, so they are untouched BY CONSTRUCTION rather than by an
 * exclusion list — the boundary is the one the code already draws.
 *
 * IDEMPOTENT, so a spec author who writes the prefix by hand gets one, not two.
 *
 * THE STORED TYPE STRING IS UNTOUCHED. This is a DISPLAY title; `spec.type`
 * ("audio_delay") is what documents hold, so no saved deck needs migrating and
 * this cannot be a load-bearing rename.
 *
 * @param {string} title - the spec's own title
 * @returns {string}
 *
 * @example audioDisplayTitle("Delay") // "Audio Delay"
 * @example audioDisplayTitle("Poly Pad") // "Audio Poly Pad"
 * @example // the meter's card reads "Level"; it becomes the user's "Audio Level"
 * @example audioDisplayTitle("Level") // "Audio Level"
 * @example // already prefixed stays prefixed — no "Audio Audio Delay"
 * @example audioDisplayTitle("Audio Delay") // "Audio Delay"
 */
export function audioDisplayTitle(title) {
  const name = String(title ?? "");
  return name.startsWith(AUDIO_TITLE_PREFIX) ? name : `${AUDIO_TITLE_PREFIX}${name}`;
}

/** The prefix the user asked for, with its trailing space — stated once so the
 *  "already prefixed" test and the construction cannot disagree. */
const AUDIO_TITLE_PREFIX = "Audio ";

/**
 * Pure function. A COMPLETE PowerRP plugin for one audio module, built from its
 * declarative spec.
 *
 * WHAT THE CALLER STILL OWNS: nothing structural. A plugins/audio_*.js file is its
 * spec and one line calling this. That is on purpose — a plugin that could reach in
 * and override `emit` or `ports` would reintroduce the 23-way drift this exists to
 * prevent, so the escape hatch is deliberately absent. A module that genuinely
 * cannot be described by a spec (the analysis nodes' live overlays are the closest
 * call, and they are handled by a DECLARATION — `overlay` — rather than by an
 * override) is a signal that the spec vocabulary is missing a word, and the fix is
 * to add the word here where all 23 get it.
 *
 * @param {object} spec - {type, title, family, module, inputs, outputs, knobs, readout, icon, help, overlay}
 * @returns {object} a plugin object for core/registry.js
 *
 * @example // const p = audioNodePlugin(REVERB_SPEC); p.type // "audio_reverb"
 * @example audioNodePlugin({type: "audio_x", title: "X", module: "noise", family: "source"}).capabilities.bbox // true
 * @example audioNodePlugin({type: "audio_x", title: "X", module: "noise"}).audioModule // "noise"
 */
export function audioNodePlugin(spec) {
  const ports = audioPorts(spec);
  const portsFn = () => ports;
  const width = spec.w ?? AUDIO_NODE_W;
  const title = audioDisplayTitle(spec.title);
  const plugin = {
    type: spec.type,
    ephemeral: EPHEMERAL.NONE,
    title,
    capabilities: { bbox: true, transform: true, resizable: true, backdrop: false },
    itemRefs: NODE_ITEM_REFS,
    // ── THE ENGINE BINDING, DECLARED ON THE PLUGIN ──────────────────────────
    // `audioModule` is what web/audioMirror.svelte.js reads to decide that an item
    // is an audio module and which engine type to instantiate for it. It lives on
    // the PLUGIN rather than in a table inside the mirror so that adding a module
    // is one file, and so the mirror never has to know the roster — it asks each
    // item's plugin what it is, exactly as every other tool in the app dispatches
    // on declarations rather than on type strings (core/registry.js's law).
    audioModule: spec.module,
    audioSpec: spec,
    // DOUBLE-CLICK ACTIVATION (web/widget_handlers.js, phase "activate"): the
    // founding ask, verbatim — "If I double click the module, I can start
    // playing with the knobs in it". Enters KNOB FOCUS, a sustained mode in
    // which a press on a dial turns it and a press anywhere else leaves.
    activate: "knob_focus",
    defaults: {
      type: spec.type,
      x: 100, y: 100, w: width,
      h: readoutNodeHeight(spec, portsFn, width),
      z: 0, rotation: 0, scale: 1,
      rotationAnchor: { x: "self.anchors.center.x", y: "self.anchors.center.y" },
      // Empty at birth but PRESENT — NODE_ITEM_REFS names a wildcard path through
      // it, and a wildcard cannot expand over a slot that does not exist, so a node
      // without this key would stay wired to the original when it was copied.
      inputs: {},
      ...audioKnobDefaults(spec),
      // THE DISPLAY'S OWN PROPERTIES (R7-19), for the specs that declare an
      // `overlay`. They are not engine params — a spectrogram's colour map and
      // scroll speed never reach the AudioContext — so they are not knobs, and
      // core/analysis_display.js declares them beside the drawing they modify.
      ...(spec.overlay ? analysisDisplayDefaults(spec.overlay) : {}),
      ...bundleNestedDefaults("effects"),
    },
    inspector: [
      ...bundle("transform"),
      // THE INPUT ROWS COME FIRST AMONG THIS NODE'S OWN PROPERTIES, above its
      // knobs. What a module is WIRED TO is the thing an author reads a patch by;
      // its knob values only mean something once you know what is flowing in.
      // Their absence was the defect the user named — "none of these nodes seem to
      // record any of their inputs as properties" — and putting them below the
      // knobs would have fixed the omission while keeping the burial.
      // `{ports: portsFn}` rather than `plugin`: this literal is evaluated while
      // `plugin` is still in its temporal dead zone, and nodeInputRows needs only
      // the port declaration. (Measured — it threw "Cannot access 'plugin' before
      // initialization" on the first run.)
      ...nodeInputRows({ ports: portsFn }),
      ...audioKnobRows(spec),
      // BELOW THE KNOBS, because they describe the PICTURE rather than the sound:
      // an author reads an analysis node by what it measures first. Filed under
      // AUDIO_CAT so a node's knobs and its display controls are one group rather
      // than two, and empty for every spec with no `overlay`.
      ...(spec.overlay ? analysisDisplayRows(spec.overlay, AUDIO_CAT) : []),
      ...props("opacity"),
      ...bundle("effects"),
    ],
    ports: portsFn,
    /**
     * Pure function. The node's picture: family card, live display, readout, beads,
     * family rim.
     *
     * ── THE ANALYSIS DISPLAY IS DRAWN HERE, AND THE PURITY LAW IS INTACT (R7-5) ─
     * It used to be a DOM `<canvas>` composited over the whole scene by
     * web/AudioOverlay.svelte, and the user rejected that in four words that name
     * four symptoms: it drew on top of everything, it RESTARTED ON ZOOM, it did not
     * rotate with its node, and no export contained it. All four followed from the
     * history living in that canvas's PIXELS — core/analysis_display.js's header
     * states the diagnosis in full.
     *
     * WHAT DID NOT CHANGE is the reason the old split existed: live samples are not
     * document state, and reading them from inside emit() would make Δt = 0 produce
     * two different pictures. They are not read here. They arrive as `ctx`, the
     * RENDER-TIME DISPLAY CONTEXT that `pdfDisplay`, `mapTiles` and `scene3d`
     * already use (render_gpu/ports.js states the law) — a plain argument, supplied
     * only by a surface that has a running AudioContext. Same descriptor, same ops.
     * A surface that passes none (every exporter, every thumbnail, cli/render.js)
     * gets exactly the static form it got before, so a headless render is
     * byte-identical to what it was.
     *
     * UNDER THE PORT BEADS AND THE RIM, deliberately: the display is part of the
     * card's FACE, and a waterfall painted over a port label would be the same
     * "one layer strikes through another" defect the wire layer avoids by drawing
     * beneath the cards. That ordering is only expressible because the display is
     * in the display list — it is precisely what a DOM overlay structurally cannot
     * do.
     *
     * @param {object} [ctx] - the render-time display context; `ctx.liveAnalysis`
     *   is THIS node's {kind, columns} descriptor, or null/absent
     */
    emit(s, _target, world, ctx) {
      const readout = audioReadout(spec, s);
      const dials = audioKnobLayout(spec, plugin, s);
      const bandTop = knobBandTop(spec, plugin, s);
      const ops = [
        ...familyCard(s, title, spec.family),
        // THE LIVE DISPLAY, when this surface supplied one. Empty for every module
        // that declares no `overlay`, and empty on every headless surface.
        ...(ctx?.liveAnalysis ? analysisDisplayOps(ctx.liveAnalysis, plugin, s) : []),
        // `dials.length` tells the readout it is sharing the band, so it stops
        // centring and sits above them (readoutBaseline states the collision); the
        // band's RESOLVED top then caps how far down it may sit, because on a
        // shortened card that top has climbed to keep the dials inside the frame.
        ...(readout && readoutFits(spec, plugin, s, dials.length > 0, bandTop)
          ? audioReadoutOps(s, plugin, readout, dials.length > 0, bandTop)
          : []),
        // THE KNOBS, painted with NO `ui` argument — the dials are document
        // state and every pixel consumer gets exactly this. The focus ring and
        // the live readout are transient editor state and belong to the
        // screen-space overlay (core/node_chrome.knobOps states the split).
        ...knobOps(dials, nodeFamily(spec.family).rim),
        ...portBeads(plugin, s),
        ...familyRim(s, spec.family),
      ];
      return applyEffects(ops, s, world, { x: 0, y: 0, w: s.w ?? 0, h: s.h ?? 0 });
    },
    /** Query. THIS NODE'S KNOB DIALS in LOCAL coords — the declaration
     *  web/knobFocus.js hit-tests and drags, and the one the overlay repaints.
     *  Declared on the plugin so the mode never needs the spec roster. */
    knobLayout: (state) => audioKnobLayout(spec, plugin, state),
    /** Query. THE DECLARED FLOOR — the height below which this module's dial band
     *  has spent its whole reflow ladder and begins to clip. Same contract as
     *  core/control_nodes.controlFloorHeight, so ONE question answers for every
     *  node family; it depends on the width because the band WRAPS. */
    nodeFloorHeight: (state) => audioFloorHeight(spec, plugin, state ?? plugin.defaults),
    commands: [{
      id: `add-${spec.type.replace(/_/g, "-")}`,
      title: `Add ${title}`,
      icon: spec.icon ?? "mdi:sine-wave",
      category: "Audio Nodes",
      run: (app) => app.armCrosshairPlacement(plugin),
    }],
    cullMargin: effectsCullMargin,
    // THE BOUNDS PROTOCOL (core/registry.js): a node's ink is its card PLUS the
    // half of each port bead that sits outside the card's edge. Declared for all
    // 23 modules from the one place their shape is known.
    localBounds: (state) => nodeInkBounds(plugin, state),
    anchors: standardBBoxAnchors,
    // The rim is the card's ROUNDED rectangle — a projection, not a clamp. See
    // core/nodeflow.nodeCardRim for the defect the clamp had.
    closestAnchor(state, wx, wy, world) {
      const local = T.apply(T.invert(world), wx, wy);
      return nodeCardRim(state, local.x, local.y);
    },
  };
  return plugin;
}

/**
 * Pure function. The readout line's display-list ops.
 *
 * ── IT SITS BELOW THE PORT ROWS, AND THAT IS A MEASURED CORRECTION ──────────
 * The first version put it just under the header, which is where a value belongs on
 * a card that has nothing else — and it landed exactly on the first port row. On a
 * rendered patch the noise node read "level" and "pink" on the same line, which is
 * two labels fighting rather than one card with a number on it.
 *
 * So the readout is placed BELOW the last port row, in the band the ports leave
 * free, and a node's default height already reserves that band (see
 * `readoutNodeHeight`). Deliberately NOT nodeValueText, which centres a 22pt number
 * in the card's whole body: that is right for a display node whose entire purpose is
 * one number, and wrong for a module whose body also holds port labels on both
 * sides. It is also horizontally inset by the same padding the port labels use, so
 * a long readout on a narrow card clips against the edge rather than under a bead.
 *
 * @param {object} s - the folded item state
 * @param {object} plugin - the node's own plugin (to know how many port rows precede)
 * @param {string} str - the formatted readout
 * @returns {object[]} display-list commands
 *
 * @example audioReadoutOps({w: 150, h: 90}, {ports: () => ({inputs: [], outputs: []})}, "800 Hz").length // 1
 * @example audioReadoutOps({w: 150, h: 90}, {ports: () => ({inputs: [], outputs: []})}, "800 Hz")[0].text // "800 Hz"
 * @example audioReadoutOps({w: 150, h: 90}, {ports: () => ({inputs: [], outputs: []})}, "800 Hz")[0].boxStyle.align // "center"
 */
export function audioReadoutOps(s, plugin, str, hasKnobs = false, bandTop = Infinity) {
  return [text({
    text: str,
    x: NODE_PAD,
    y: readoutBaseline(plugin, s, hasKnobs, bandTop),
    size: AUDIO_READOUT_SIZE,
    color: NODE_VALUE_INK,
    boxW: Math.max(0, (s.w ?? 0) - NODE_PAD * 2),
    boxStyle: { align: "center" },
  })];
}

/**
 * Pure function. The LOCAL baseline y the readout sits on: below the last port row,
 * centred in whatever height remains.
 *
 * Reads the port layout the beads themselves are placed from, so the two cannot
 * disagree about where the rows end — the same one-source-of-truth reason
 * core/node_chrome.portBeads reads it rather than recomputing.
 *
 * @param {object} plugin - the node's plugin
 * @param {object} s - the folded item state
 * @returns {number} a LOCAL baseline y
 *
 * @example // with no ports, the readout centres in the body below the header
 * @example readoutBaseline({ports: () => ({inputs: [], outputs: []})}, {w: 150, h: 90}) > 24 // true
 * @example // more port rows push it further down
 * @example readoutBaseline({ports: () => ({inputs: [{key: "a", type: "number"}, {key: "b", type: "number"}], outputs: []})}, {w: 150, h: 140}) > readoutBaseline({ports: () => ({inputs: [], outputs: []})}, {w: 150, h: 140}) // true
 * @example // WITH KNOBS below it the readout stops centring and hugs the port rows,
 * @example // which is what stops it landing on the dials' labels
 * @example readoutBaseline({ports: () => ({inputs: [], outputs: []})}, {w: 150, h: 200}, true) < readoutBaseline({ports: () => ({inputs: [], outputs: []})}, {w: 150, h: 200}, false) // true
 *
 * ── AND IT YIELDS TO THE BAND WHEN THE BAND HAS MOVED UP (workstream CD) ────
 * `bandTop` is the knob band's ACTUAL top, which on a shortened card is no longer
 * the natural one — `knobBandTop` now slides the band up against the bottom rim
 * rather than letting it leave the card. That is the right trade for the dials,
 * but it means the band can arrive UNDER a readout that was placed from the port
 * rows alone, and on the shipped ambience deck it did: "82.41 Hz", "900 Hz" and
 * "0.05 Hz" each landed on the arcs of the dials beneath them (seen on a rendered
 * still immediately after the CD fix, which is the third time this line has been
 * caught by eye rather than by a test). So when the band has climbed, the readout
 * climbs with it and keeps its own line clear — and when it has not, nothing here
 * changes at all.
 *
 * @param {number} [bandTop] - the knob band's resolved top, when there is a band
 */
export function readoutBaseline(plugin, s, hasKnobs = false, bandTop = Infinity) {
  const top = nodeBodyTop(plugin, s);
  const h = nodeBox(s).h ?? 0;
  // WITH KNOBS BELOW IT, THE READOUT SITS RIGHT ON `top` AND DOES NOT CENTRE, and
  // this correction is the second time this line has been wrong in the same way.
  // Centring "in the remaining band" was right when the readout was the ONLY
  // thing under the port rows — it is the rule that put the value in the middle
  // of an otherwise empty card. Wave 3 gave the card a knob band occupying that
  // same space, and the centred readout landed squarely on top of the dials'
  // labels: a rendered filter read "800 Hz" through the words "Cutoff" and
  // "Resonance" (caught by eye on a screenshot, not by any test — the same way
  // the ORIGINAL version of this bug was caught, when the readout landed on the
  // first port row). A band that now has two tenants cannot let either of them
  // centre in the whole of it.
  // A BASELINE, so the glyphs sit ABOVE it — `top + size` puts the whole line in
  // the band starting at `top`. The `- READOUT_GAP / 2` that used to be here made
  // it `top + 13 - 4`, i.e. a 13pt line whose cap height was 4px ABOVE the band —
  // and the knob band starts one gap below `top + size`, so the readout's own
  // glyphs reached down into the first row of dials. Measured on a rendered
  // six-knob module: the Poly Pad's "8" sat on its Cutoff dial. The gap belongs
  // BELOW the line (which knobBandTop already adds), not stolen from above it.
  // THE BAND'S TOP IS A CEILING ON THE READOUT'S BASELINE. Its glyphs sit ABOVE
  // the baseline, so a baseline AT the band's top already clears the dials; the
  // extra gap keeps a descender off the first arc. It never pushes the readout
  // ABOVE `top`, because the port row above it is the one thing that cannot give.
  //
  // ── AND `y` IS THE LINE BOX'S TOP, NOT A BASELINE (W1-D, 2026-08-06) ───────
  // Everything above this line was reasoned about a baseline, and the renderer
  // has never had one: `render_gpu/skia/text_layout.js` draws a Paragraph at
  // (cmd.x, cmd.y) — its TOP-LEFT — and svg_backend adds its own ascent. So the
  // readout was consistently drawn ONE LINE LOWER than every correction above
  // computed, which is why it kept landing on the dials no matter how many times
  // the arithmetic was adjusted. Three separate fixes are recorded above; all
  // three were tuning the wrong quantity. It is now placed as a line box, and
  // `readoutLineH` is its height.
  if (hasKnobs) return Math.max(top, Math.min(top, bandTop - readoutLineH() - NODE_BODY_GAP / 2));
  // Otherwise: CENTRED in the band the ports leave free, which is what "centre in
  // the remaining band" always meant — as a line box rather than as a baseline.
  return Math.max(top, top + Math.max(0, (h - top - readoutLineH()) / 2));
}

/** The vertical space the readout's own line occupies. */
export function readoutLineH() {
  return textLineH(AUDIO_READOUT_SIZE);
}

/** The gap between the last port bead and the readout band — the shared band gap
 *  (core/node_chrome.NODE_BODY_GAP), not a second opinion about the same space. */
const READOUT_GAP = NODE_BODY_GAP;

/**
 * Pure function. Whether a node's READOUT LINE is drawn at this size — and when
 * a card is too small for both, which of the readout and the dials yields.
 *
 * ── THE RULE, AND WHY IT FALLS THIS WAY ─────────────────────────────────────
 * On a card shortened past the point where the readout line and the knob band
 * both fit, one of them has to go. THE READOUT YIELDS, and the reason is not
 * taste: for 18 of the 21 specs that declare one, the readout NAMES A KNOB THAT
 * ALSO HAS A DIAL (measured across AUDIO_SPECS — filter's `frequency`, mixer's
 * `level1`, output's `volume`, and so on). Dropping it removes a DUPLICATE of a
 * value the card is still showing, in a second place besides — the Inspector row
 * for the same property. Dropping the dial instead would remove the only
 * graphical statement of that value AND the only thing on the card you can turn.
 *
 * THE THREE SPECS WHOSE READOUT HAS NO DIAL BEHIND IT KEEP IT. Noise's `color`,
 * the Ding's `preset` and the Reverb's `character` are DISCRETE — a choice among
 * names, which core/node_knobs.knobLayout deliberately does not draw as a dial —
 * so their readout is the card's only word for what the module is set to, and
 * hiding it would leave a module whose face says nothing about itself. That is
 * the whole of the exception, and it is derived from the spec rather than listed,
 * so a new discrete-readout module gets it without anyone remembering to.
 *
 * ── WHAT IT LOOKED LIKE BEFORE (workstream CD, on a rendered still) ─────────
 * Once the CD fix slid the knob band up to keep the dials inside a shortened
 * card, the readout — placed from the PORT ROWS, which do not move — arrived
 * underneath it. On the shipped ambience deck the Filter read "900 Hz" straight
 * through its Cutoff and Resonance arcs, and the LFO's "0.05 Hz" through its Rate
 * and Depth. Both are legible in neither role. Two lines of text on one line of
 * card is not a smaller picture, it is an unreadable one.
 *
 * @param {object} spec - an audio node spec
 * @param {object} plugin - the node's plugin
 * @param {object} s - the folded item state
 * @param {boolean} hasKnobs - whether the card is drawing any dials
 * @param {number} bandTop - the knob band's RESOLVED top
 * @returns {boolean}
 *
 * @example // no dials to collide with: a readout is always drawn
 * @example readoutFits({readout: "x"}, {ports: () => ({inputs: [], outputs: []})}, {w: 150, h: 90}, false, Infinity) // true
 * @example // room for both: drawn
 * @example readoutFits({readout: "x", knobs: [{key: "x"}]}, {ports: () => ({inputs: [], outputs: []})}, {w: 150, h: 300}, true, 80) // true
 * @example // squeezed, and the readout duplicates a DIAL: the readout yields
 * @example readoutFits({readout: "x", knobs: [{key: "x"}]}, {ports: () => ({inputs: [], outputs: []})}, {w: 150, h: 300}, true, 44) // false
 * @example // squeezed, but the readout's knob is DISCRETE and has no dial: it stays
 * @example readoutFits({readout: "x", knobs: [{key: "x", discrete: true}, {key: "y"}]}, {ports: () => ({inputs: [], outputs: []})}, {w: 150, h: 300}, true, 44) // true
 */
export function readoutFits(spec, plugin, s, hasKnobs, bandTop) {
  if (!hasKnobs) return true;
  const top = nodeBodyTop(plugin, s);
  // The readout's own line, plus the half-gap readoutBaseline keeps under it.
  if (bandTop - top >= readoutLineH() + READOUT_GAP / 2) return true;
  // No room. It stays only if it is the card's ONLY statement of its value —
  // which is exactly when its knob is discrete, so no dial is drawn for it.
  const knob = (spec.knobs ?? []).find((k) => k.key === spec.readout);
  return Boolean(knob?.discrete);
}

/**
 * Pure function. THE KNOB LAYOUT for one audio node — the ONE call the painter,
 * the hit test and the drag all make, so a dial cannot be drawn anywhere other
 * than where it can be turned.
 *
 * Placed in this file rather than in core/node_knobs.js because it is what
 * joins a knob to an AUDIO SPEC: the band's top comes from `readoutBaseline`
 * (this file owns a node's vertical stack) and each dial's live value comes
 * from the RAW state, not from `audioKnobValues`. The distinction matters and
 * is the reason `valueOf` reads `s[stateKey]` directly: audioKnobValues
 * substitutes a knob's DEFAULT when the slot holds an unresolved equation, which
 * is exactly right for the engine (a NaN would poison an AudioParam forever) and
 * exactly wrong here — a dial must show that the value is BOUND so the drag can
 * refuse it, rather than quietly showing a default the document does not hold.
 *
 * @param {object} spec - an audio node spec
 * @param {object} plugin - the node's own plugin (for its port rows)
 * @param {object} s - the folded item state
 * @returns {Array<object>} knobLayout records
 *
 * @example // audioKnobLayout(FILTER_SPEC, filterPlugin, {w: 150, h: 160}).length // 3
 * @example audioKnobLayout({knobs: [{key: "q", min: 0, max: 10, default: 1}]}, {ports: () => ({inputs: [], outputs: []})}, {w: 150, h: 160})[0].key // "q"
 * @example // an unresolved equation in the slot marks the dial BOUND, not defaulted
 * @example audioKnobLayout({knobs: [{key: "q", min: 0, max: 10, default: 1}]}, {ports: () => ({inputs: [], outputs: []})}, {w: 150, h: 160, audioQ: "= ease(time)"})[0].bound // true
 * @example audioKnobLayout({}, {ports: () => ({inputs: [], outputs: []})}, {w: 150, h: 90}) // []
 */
export function audioKnobLayout(spec, plugin, s) {
  // The `audio` prefix is declared HERE, on the record, rather than re-derived by
  // the mode that turns the dial (which is what web/knobFocus.js used to do, and
  // which its own docblock flagged as temporary). A control node stores its value
  // in a plain `value` leaf with no prefix, so a guessing mode would have written
  // `audioValue` into a widget that has no such property.
  //
  // ONLY THE KNOBS THAT STILL SHOW A WIDGET are laid out — `paramShowsWidget`, the
  // survey's convergent rule. A driven param's row is its bead and its label, and
  // its dial is gone, so the band it was in gets shorter and the card reflows.
  return knobLayout(
    paramWidgetKnobs(spec, s), s, knobBandTop(spec, plugin, s),
    (k) => s?.[audioKnobKey(k.key)] ?? k.default,
    (k) => audioKnobKey(k.key),
    () => false
  );
}

/**
 * Pure function. Does this param still show its own widget on the card?
 *
 * ── THE PREDICATE FOUR UNRELATED EDITORS INVENTED SEPARATELY (R7-10) ────────
 * `showWidget = widget && (isOutput || !socket || linkCount === 0)`
 * (`.frenzy/round7/patchers_blueprints_report.md` §(a): Blender's `node_draw.cc`,
 * Unreal Blueprint's Slate rows, Rete.js's `{#if input.control &&
 * input.showControl}`, and litegraph's TS fork all arrived at it independently,
 * in C++/OpenGL, Slate, the DOM and canvas respectively. The report's judgement,
 * which is the reason to take it: "That convergence is worth more than any single
 * one being well designed.")
 *
 * THIS IS THE USER'S KNOB-OR-INPUT DUALITY, and it is the half that is VISIBLE:
 * *"things can either be a knob control or they can be an input control."* An
 * unwired param IS a knob; a wired one IS an input. The two states are mutually
 * exclusive BY CONSTRUCTION, so there is no third state to get wrong and no
 * "which one wins" question — which is precisely what a dial showing a stale
 * number beside a live wire was.
 *
 * OUR SPECS ALREADY CARRY THE RAW MATERIAL. A Filter declares BOTH a `frequency`
 * knob and a `frequency` input; so do the oscillator, the LFO, the delay and the
 * VCA. That is Axoloti's `param_X + inlet_X` convention (Q3), spelled by hand,
 * and it costs Axoloti ~70 duplicated `x` / `x m` objects. Deriving the pairing
 * from the two arrays instead of listing it is what makes the duality free for
 * the ~100 specs Wave 3 will author — see this file's SPEC VOCABULARY note.
 *
 * @param {object} spec - an audio node spec
 * @param {object} s - the folded item state
 * @param {string} key - a knob's key
 * @returns {boolean}
 *
 * @example // no same-named input at all: always a knob
 * @example paramShowsWidget({inputs: [], knobs: [{key: "q"}]}, {}, "q") // true
 * @example // a same-named input exists but nothing is plugged in: still a knob
 * @example paramShowsWidget({inputs: [{key: "q", type: "number"}]}, {}, "q") // true
 * @example // …and the moment a wire lands on it, the widget yields to the wire
 * @example paramShowsWidget({inputs: [{key: "q", type: "number"}]}, {inputs: {q: {item: "n1", port: "out"}}}, "q") // false
 * @example // a wire on a DIFFERENT port is not this param's business
 * @example paramShowsWidget({inputs: [{key: "q", type: "number"}]}, {inputs: {in: {item: "n1", port: "out"}}}, "q") // true
 */
export function paramShowsWidget(spec, s, key) {
  const socket = (spec?.inputs ?? []).some((p) => p.key === key);
  return !socket || !portIsWired(s, key);
}

/**
 * Pure function. A spec's dial knobs that still show a widget, in order.
 *
 * @param {object} spec - an audio node spec
 * @param {object} s - the folded item state
 * @returns {object[]} knob declarations
 *
 * @example paramWidgetKnobs({knobs: [{key: "a"}, {key: "b", discrete: true}]}, {}).length // 1
 * @example // a driven param drops out of the band entirely
 * @example paramWidgetKnobs({inputs: [{key: "a", type: "number"}], knobs: [{key: "a"}]}, {inputs: {a: {item: "n1", port: "out"}}}) // []
 * @example // …and so does a DERIVED one: it has no leaf, so there is nothing to turn
 * @example paramWidgetKnobs({knobs: [{key: "steps", derived: () => []}]}, {}) // []
 */
export function paramWidgetKnobs(spec, s) {
  return (spec?.knobs ?? []).filter((k) => !k.discrete && !k.derived && paramShowsWidget(spec, s, k.key));
}

/**
 * Pure function. The LOCAL y a node's knob band starts at: below the readout
 * when there is one, below the last port row otherwise — AND NEVER SO LOW THAT
 * THE BAND LEAVES THE CARD.
 *
 * ── THE SECOND HALF IS WORKSTREAM CD (user, 2026-08-03, verbatim) ───────────
 * "Also looks at this stupid shit when I resize a widget lmao the knobs stay in
 * place and the module knobs are floating"
 *
 * The first two clauses are the NATURAL top: they stack the band under whatever
 * the card already holds, and they are the whole of what this function used to
 * be. They are also functions of the PORT ROWS alone, which are placed from the
 * card's top edge by fixed constants — so the natural top does not move when the
 * author drags the card shorter, and past a certain height the band it names is
 * simply outside the card. MEASURED on the Mixer at its default width: its
 * natural band top is y 231 and its band is 94 tall, so at any height between
 * ~195 (where the ports still fit) and ~300 the ports are inside the frame and
 * every dial is below it — which is precisely the screenshot the ruling names.
 *
 * So the band is FLOORED AGAINST THE BOTTOM RIM: when the natural top would put
 * the band's last row past the bottom, the band slides UP to sit against the rim
 * instead. That is a reflow and not a clamp-to-nothing, because it never rises
 * above `afterPorts` — the band gives up the slack it had under the readout
 * first, and only when that is exhausted does the fit scale start shrinking the
 * dials themselves. Two mechanisms, in the order that costs the picture least:
 * move the band, then scale it, then (past the scale floor) clip visibly.
 *
 * The height it reserves is `knobBandHeight` MINUS its bottom pad, because that
 * pad is a margin under the last label and this is measuring to the label, not
 * past it — reserving the pad too would push the band up by six units on every
 * card that is exactly tall enough, changing a picture that was already right.
 *
 * ── SINCE R7-10 THE LADDER IS NOT SPELLED HERE ──────────────────────────────
 * Every clause above is still true and still the reason; what changed is that
 * this function no longer IMPLEMENTS any of it. The reflow is
 * `core/node_chrome.nodeFaceBand` and the port geometry is
 * `core/node_chrome.nodeBodyTop`, so a Knob node's dial and a Mixer's band
 * descend the SAME ladder and read the SAME port rows. That is the whole of
 * R7-10: what was three hand-rolled schemes is now one declaration each.
 *
 * IT ALSO REMOVES A SECOND READER OF PORT GEOMETRY. This used to call
 * `portLayout` itself and re-derive the last row, which is the duplication
 * core/registry.js:220 and core/node_chrome.js's portBeads docblock both name as
 * the defect to avoid — a face placed from its own copy of the port math drifts
 * under a reflowed bead exactly on the short cards this is about.
 *
 * @param {object} spec - an audio node spec
 * @param {object} plugin - the node's plugin
 * @param {object} s - the folded item state
 * @returns {number}
 *
 * @example knobBandTop({}, {ports: () => ({inputs: [], outputs: []})}, {w: 150, h: 90}) > NODE_HEADER_H // true
 * @example // a spec WITH a readout starts its knobs lower than the same spec without
 * @example knobBandTop({readout: "x", knobs: [{key: "x"}]}, {ports: () => ({inputs: [], outputs: []})}, {w: 150, h: 200}) > knobBandTop({}, {ports: () => ({inputs: [], outputs: []})}, {w: 150, h: 200}) // true
 * @example // FOUR dials on a portless card with a readout: the band is two rows,
 * @example // and a tall card leaves it at its natural top under the readout line.
 * @example // 61.6 SINCE R7-10, and it MOVED FOR ONE REASON: the natural top is now
 * @example // DERIVED (body top 38 + the readout's real line 15.6 + one gap 8) where
 * @example // it used to be a constant sum (38 + the readout's SIZE 13 + TWO gaps 16
 * @example // = 67). The doubled gap was compensating for a text op's `y` being read
 * @example // as a baseline; stating the line's true height retires the fudge.
 * @example knobBandTop({readout: "a", knobs: [{key: "a"}, {key: "b"}, {key: "c"}, {key: "d"}]}, {ports: () => ({inputs: [], outputs: []})}, {w: 150, h: 400}) // 61.6
 * @example // SHORTENED, the band slides UP to sit against the bottom rim — and it
 * @example // now starts sliding EARLIER than it used to, because the reservation
 * @example // grew by the two corrections above: KNOB_ROW_H reserves the label's
 * @example // LINE (9.6) where it reserved its SIZE (8), and the band reserves its
 * @example // bottom pad so a WRAPPED label stays inside the rim. A band that
 * @example // occupies more must climb sooner; CD's ladder itself is untouched.
 * @example // MEASURED: 400→61.6, 200→61.6, 160→49.2, 150→39.2, 140→38, 120→38.
 * @example knobBandTop({readout: "a", knobs: [{key: "a"}, {key: "b"}, {key: "c"}, {key: "d"}]}, {ports: () => ({inputs: [], outputs: []})}, {w: 150, h: 160}) // 49.2
 * @example knobBandTop({readout: "a", knobs: [{key: "a"}, {key: "b"}, {key: "c"}, {key: "d"}]}, {ports: () => ({inputs: [], outputs: []})}, {w: 150, h: 150}) // 39.2
 * @example // …but NEVER above the port rows (38, the portless inset): past that the
 * @example // band stops moving and the fit scale starts shrinking it.
 * @example knobBandTop({readout: "a", knobs: [{key: "a"}, {key: "b"}, {key: "c"}, {key: "d"}]}, {ports: () => ({inputs: [], outputs: []})}, {w: 150, h: 140}) // 38
 * @example // …but NEVER above the port rows (here 38, the portless inset): past
 * @example // that the band stops moving and knobBandScale starts shrinking it.
 * @example knobBandTop({readout: "a", knobs: [{key: "a"}, {key: "b"}, {key: "c"}, {key: "d"}]}, {ports: () => ({inputs: [], outputs: []})}, {w: 150, h: 120}) // 38
 */
export function knobBandTop(spec, plugin, s) {
  const afterPorts = nodeBodyTop(plugin, s);
  // The readout, when there is one, is a LINE BOX one gap below the ports, so the
  // band starts one gap below the bottom of that line. It used to be stated as
  // "two gaps below the readout's BASELINE", a correction made because the number
  // read as sitting on the dials — which it did, for the reason readoutBaseline
  // now records: the op's `y` was never a baseline, so the line was already a
  // whole line-height lower than the arithmetic believed. Stating the line's real
  // height makes the fudge unnecessary and the gap honest.
  const natural = spec.readout ? afterPorts + readoutLineH() + READOUT_GAP : afterPorts;
  const rows = knobBandRows(spec, s);
  if (rows <= 0) return natural;
  // A READOUT THAT CANNOT YIELD IS A HARD CEILING ON THE BAND. `readoutFits`
  // drops a readout that merely duplicates a dial, which is what lets the band
  // climb into its line; but a DISCRETE readout (Noise's colour, the Ding's
  // preset, the Reverb's character) is the card's only word for what the module
  // is set to and stays. Sliding the band up under one would print the dials
  // through it, which is the collision this whole workstream is about — so on
  // those three the band keeps its natural top and CLIPS instead, visibly, which
  // is the honest signal that the card is too short for what it is holding.
  const readoutKnob = (spec.knobs ?? []).find((k) => k.key === spec.readout);
  if (spec.readout && readoutKnob?.discrete) return natural;
  // THE LADDER, in the one place it lives.
  //
  // THE RESERVATION INCLUDES KNOB_BAND_PAD, and it did not until W1-D. The
  // docblock above argued for excluding it — "that pad is a margin under the last
  // label and this is measuring to the label, not past it" — which is true of a
  // ONE-LINE label and false of a wrapped one. A knob label is a boxed run one
  // pitch wide and wraps when the name is longer (the Filter's "Resonance", the
  // Pad's "Frequency"); with the pad excluded, a band floored against the bottom
  // rim ends its last label line exactly AT the rim, so the wrapped line landed
  // outside the card. MEASURED on the shipped ambience deck, before and after.
  // Reserving the pad costs a floored band one line of upward travel and buys the
  // containment the whole workstream is about.
  return nodeFaceBand({
    floorTop: afterPorts, top: natural, height: rows * KNOB_ROW_H + KNOB_BAND_PAD,
  }, nodeBox(s).h).top;
}

/**
 * Pure function. How many ROWS of dials a spec's band wraps to at a card's width
 * — counting only the dials that still show a widget.
 *
 * The ONE place the wrap is computed, because three functions need it (the
 * band's height, the band's top and the layout itself) and a fourth copy is a
 * fourth chance for them to disagree about how many rows a card is holding.
 *
 * @param {object} spec - an audio node spec
 * @param {object} s - the folded item state
 * @returns {number}
 *
 * @example knobBandRows({knobs: [{key: "a"}]}, {w: 150}) // 1
 * @example // four dials at a 150 pitch of 44 wrap to two rows
 * @example knobBandRows({knobs: [{key: "a"}, {key: "b"}, {key: "c"}, {key: "d"}]}, {w: 150}) // 2
 * @example knobBandRows({knobs: []}, {w: 150}) // 0
 */
/**
 * Pure function. THE DECLARED FLOOR for one audio module — the height at which
 * its dial band has slid up, shrunk to KNOB_BAND_MIN_SCALE, and begins to clip.
 *
 * The twin of core/control_nodes.controlFloorHeight, and it takes the STATE
 * rather than a width alone because the band WRAPS: the same module is a
 * one-row band at 150 wide and a three-row band at 80, so its floor is not one
 * number. That is exactly the case the containment sweep found — an oscillator
 * whose dials were inside every card at its default width and outside a narrow
 * one, because the wrap tripled the band it had to fit.
 *
 * @param {object} spec - an audio node spec
 * @param {object} plugin - the node's plugin
 * @param {object} s - the folded item state (its `w` decides the wrap)
 * @returns {number} a LOCAL height
 *
 * @example // a module with no dials only has to hold its ports and readout
 * @example audioFloorHeight({}, {ports: () => ({inputs: [], outputs: []})}, {w: 150}) // 38
 * @example // one dial row adds a third of KNOB_ROW_H, plus the band's bottom pad
 * @example Math.round(audioFloorHeight({knobs: [{key: "a"}]}, {ports: () => ({inputs: [], outputs: []})}, {w: 150})) // 64
 * @example // …and a NARROW card wraps that band, so its floor is higher
 * @example audioFloorHeight({knobs: [{key: "a"}, {key: "b"}]}, {ports: () => ({inputs: [], outputs: []})}, {w: 60}) > audioFloorHeight({knobs: [{key: "a"}, {key: "b"}]}, {ports: () => ({inputs: [], outputs: []})}, {w: 150}) // true
 */
export function audioFloorHeight(spec, plugin, s) {
  const top = nodeBodyTop(plugin, { ...s, h: undefined })
    + (spec?.readout ? readoutLineH() + READOUT_GAP : 0);
  const rows = knobBandRows(spec, s);
  // NO ROWS, NO PAD. KNOB_BAND_PAD is the margin under the LAST LABEL, so a module
  // with no dials (or whose every dial is currently driven by a wire) reserves
  // nothing for it — otherwise an Output node's floor would claim six units for a
  // band it does not draw.
  return top + rows * KNOB_ROW_H * KNOB_BAND_MIN_SCALE + (rows ? KNOB_BAND_PAD : 0);
}

export function knobBandRows(spec, s) {
  const dials = paramWidgetKnobs(spec, s).length;
  if (dials === 0) return 0;
  const perRow = Math.max(1, Math.floor(nodeBox(s).w / KNOB_PITCH_X));
  return Math.max(1, Math.ceil(dials / perRow));
}

/**
 * Pure function. How many DIALS a spec draws — its continuous knobs.
 *
 * The one place the "not discrete" rule is spelled, because three functions now
 * need the count (the band's height, the band's top and the layout itself) and a
 * fourth copy of the filter is a fourth chance for them to disagree about how
 * many rows a card is holding.
 *
 * @param {object} spec - an audio node spec
 * @returns {number}
 *
 * @example dialCount({knobs: [{key: "a"}, {key: "b"}]}) // 2
 * @example // a DISCRETE knob is a switch, not a dial: it lives in the Inspector
 * @example dialCount({knobs: [{key: "a"}, {key: "wave", discrete: true}]}) // 1
 * @example // a DERIVED param has no leaf and therefore no dial (R7-14)
 * @example dialCount({knobs: [{key: "a"}, {key: "steps", derived: () => []}]}) // 1
 * @example dialCount({}) // 0
 */
export function dialCount(spec) {
  return (spec?.knobs ?? []).filter((k) => !k.discrete && !k.derived).length;
}

/**
 * Pure function. How much extra height a spec's KNOB BAND needs — the rows its
 * dials wrap to at a given width, plus the label under the last one.
 *
 * Zero for a spec whose knobs are all DISCRETE (no dial is drawn, so no band is
 * reserved): a Noise node's only continuous knob is its level, and an Output's
 * is its volume, so nothing here inflates a card that has nothing to show.
 *
 * @param {object} spec - an audio node spec
 * @param {number} width - the node's width
 * @returns {number} extra local height, 0 when the spec has no dials
 *
 * @example knobBandHeight({knobs: []}, 150) // 0
 * @example knobBandHeight({knobs: [{key: "a", discrete: true}]}, 150) // 0
 * @example knobBandHeight({knobs: [{key: "a"}]}, 150) > 0 // true
 * @example // four dials on a 150-wide card need two rows, so twice the height
 * @example knobBandHeight({knobs: [{key: "a"}, {key: "b"}, {key: "c"}, {key: "d"}]}, 150) > knobBandHeight({knobs: [{key: "a"}]}, 150) // true
 */
export function knobBandHeight(spec, width) {
  const dials = dialCount(spec);
  if (dials === 0) return 0;
  const perRow = Math.max(1, Math.floor(width / KNOB_PITCH_X));
  return Math.ceil(dials / perRow) * KNOB_ROW_H + KNOB_BAND_PAD;
}

/**
 * Bottom margin under the last knob row.
 *
 * ── IT IS ONE LABEL LINE, AND THAT IS A MEASUREMENT NOT A MARGIN ────────────
 * It was 6, "so a label is not flush with the rim". A knob label is a BOXED run
 * one knob-pitch wide and it WRAPS when the name is longer than that — which the
 * registry docblock's rule says to show rather than hide, because a name too long
 * for its column is a sizing problem the author should see. But the WRAP was
 * landing outside the card: seen on a rendered still of the shipped ambience deck,
 * the Filter's "Resonance" broke to a second line whose "e" was painted three
 * units BELOW the bottom rim, and the Ambience Pad's "Frequency" did the same.
 * An overflow you can see is a signal; one that leaves the card is the defect this
 * whole workstream is about.
 *
 * So the band reserves ONE MORE LINE of label. A two-line label now lands inside
 * the rim; a three-line one still escapes, and that is honest — at three lines the
 * card is far too narrow and no reservation makes it readable.
 */
const KNOB_BAND_PAD = textLineH(KNOB_LABEL_SIZE);

/**
 * Pure function. A node's default height: tall enough for its ports AND for its
 * readout band, when it has one.
 *
 * `minimumNodeHeight` sizes a card to its PORTS alone, which is correct for the
 * proof trio (their value text is centred over the whole body). An audio node with a
 * readout needs one more line below the last row, or the readout would be placed
 * outside the card it belongs to.
 *
 * A SPEC WITH AN `overlay` NEEDS THE SAME COURTESY FOR ITS DISPLAY (R7-5). The two
 * analysis specs declare `readout: null` and no knobs, so under the old sizing they
 * were born at their PORT height with no free band at all — which is why the DOM
 * overlay that preceded this drew straight over their port labels. A meter or a
 * spectrum is a widget whose entire purpose is a picture; being born with room for
 * one is the same reservation a readout already gets. The two are additive rather
 * than exclusive, so a future module with both is sized for both.
 *
 * @param {object} spec - an audio node spec
 * @param {object} portsFn - the node's ports accessor
 * @returns {number} a default height
 *
 * @example // a spec with a readout is taller than the same spec without one
 * @example readoutNodeHeight({readout: "x", knobs: [{key: "x", default: 1}]}, () => ({inputs: [], outputs: []})) > readoutNodeHeight({}, () => ({inputs: [], outputs: []})) // true
 * @example // and so is one with a live display, for the same reason
 * @example readoutNodeHeight({overlay: "spectrum"}, () => ({inputs: [], outputs: []})) > readoutNodeHeight({}, () => ({inputs: [], outputs: []})) // true
 */
export function readoutNodeHeight(spec, portsFn, width = AUDIO_NODE_W) {
  const base = minimumNodeHeight({ ports: portsFn }, {});
  const withDisplay = spec.overlay ? base + ANALYSIS_DISPLAY_BAND_H : base;
  const withReadout = spec.readout ? withDisplay + AUDIO_READOUT_SIZE + READOUT_GAP * 2 : withDisplay;
  // …AND FOR ITS KNOB BAND. A node born too short to show its own dials would
  // paint them past its bottom rim, which is the same defect the readout had
  // before it was placed below the port rows (see audioReadoutOps). The author
  // may still shrink the card afterwards — that clips, visibly, which is the
  // signal the registry docblock asks for rather than one to hide.
  // ROUNDED at the one point an abstract size becomes a stored default — see
  // core/node_chrome.nodeDefaultSize for the drag-sensitivity regression a
  // fractional `defaults.h` caused on all 23 modules at once.
  return nodeDefaultSize(withReadout + knobBandHeight(spec, width));
}

/** The readout's type size: bigger than a port label, smaller than the display
 *  node's headline number, because it shares its row with neither. */
export const AUDIO_READOUT_SIZE = 13;
