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
import { standardBBoxAnchors } from "./derive.js";
import { bundle, bundleNestedDefaults, props } from "./properties.js";
import { NODE_ITEM_REFS, PORT_BEAD_R, minimumNodeHeight, nodeCardRim, nodeInkBounds, nodeInputRows, portLayout } from "./nodeflow.js";
import { NODE_HEADER_H, NODE_PAD, NODE_VALUE_INK, familyCard, familyRim, knobOps, nodeFamily, portBeads } from "./node_chrome.js";
import { KNOB_PITCH_X, KNOB_ROW_H, knobLayout } from "./node_knobs.js";
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
 */
export function audioKnobValues(spec, s) {
  return (spec.knobs ?? []).map((k) => {
    const stateKey = audioKnobKey(k.key);
    const raw = s?.[stateKey];
    const value = k.discrete
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
  return (spec.knobs ?? []).map((k) => (k.discrete
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
 * @example audioKnobDefaults({}) // {}
 */
export function audioKnobDefaults(spec) {
  return Object.fromEntries((spec.knobs ?? []).map((k) => [audioKnobKey(k.key), k.default]));
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
 * @example audioReadout({knobs: [{key: "bpm", default: 120, unit: " BPM"}], readout: "bpm"}, {audioBpm: 96}) // "96 BPM"
 * @example audioReadout({knobs: [{key: "frequency", default: 440, unit: " Hz"}], readout: "frequency"}, {}) // "440 Hz"
 * @example // a discrete knob reads out as its own name, which is the whole value
 * @example audioReadout({knobs: [{key: "character", default: "hall", discrete: true}], readout: "character"}, {}) // "hall"
 * @example audioReadout({knobs: []}, {}) // ""
 */
export function audioReadout(spec, s) {
  if (!spec.readout) return "";
  const knob = (spec.knobs ?? []).find((k) => k.key === spec.readout);
  if (!knob) return "";
  const { value } = audioKnobValues({ knobs: [knob] }, s)[0];
  if (knob.discrete) return String(value);
  const rounded = Math.abs(value) >= 100 ? Math.round(value) : Number(Number(value).toFixed(2));
  return `${rounded}${knob.unit ?? ""}`;
}

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
  const plugin = {
    type: spec.type,
    ephemeral: EPHEMERAL.NONE,
    title: spec.title,
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
      ...props("opacity"),
      ...bundle("effects"),
    ],
    ports: portsFn,
    /**
     * Pure function. The node's picture: family card, readout, beads, family rim.
     *
     * THIS PATH STAYS PURE, AND THAT IS WHY THE METERS ARE NOT DRAWN HERE. An
     * analysis node's bouncing bar is LIVE audio data, which is not document state
     * and cannot be — reading it inside emit() would make Δt = 0 produce two
     * different pictures and break the determinism law outright (CLAUDE.md). So
     * emit() draws the node's STATIC form, including the static form of its meter,
     * and the live bar is a CANVAS OVERLAY the editor composites on top (see
     * `overlay` in the spec and web/AudioOverlay.svelte). Exports and cli/render.js
     * get the static form, which is the honest picture of a document that has no
     * sound in it.
     */
    emit(s, _target, world) {
      const readout = audioReadout(spec, s);
      const dials = audioKnobLayout(spec, plugin, s);
      const ops = [
        ...familyCard(s, spec.title, spec.family),
        // `dials.length` tells the readout it is sharing the band, so it stops
        // centring and sits above them (readoutBaseline states the collision).
        ...(readout ? audioReadoutOps(s, plugin, readout, dials.length > 0) : []),
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
    commands: [{
      id: `add-${spec.type.replace(/_/g, "-")}`,
      title: `Add ${spec.title}`,
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
export function audioReadoutOps(s, plugin, str, hasKnobs = false) {
  return [text({
    text: str,
    x: NODE_PAD,
    y: readoutBaseline(plugin, s, hasKnobs),
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
 */
export function readoutBaseline(plugin, s, hasKnobs = false) {
  const rows = portLayout(plugin, s);
  const lastRow = rows.length ? Math.max(...rows.map((p) => p.y)) : NODE_HEADER_H;
  const top = lastRow + PORT_BEAD_R + READOUT_GAP;
  const h = s.h ?? 0;
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
  if (hasKnobs) return top + AUDIO_READOUT_SIZE - READOUT_GAP / 2;
  // Otherwise unchanged: centre in the remaining band when there is one, else sit
  // right below the ports and let the card clip, which is the visible signal that
  // it is too short.
  return Math.max(top, top + Math.max(0, (h - top) / 2)) + AUDIO_READOUT_SIZE / 3;
}

/** The gap between the last port bead and the readout band. */
const READOUT_GAP = 8;

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
  return knobLayout(spec.knobs, s, knobBandTop(spec, plugin, s), (k) => s?.[audioKnobKey(k.key)] ?? k.default);
}

/**
 * Pure function. The LOCAL y a node's knob band starts at: below the readout
 * when there is one, below the last port row otherwise.
 *
 * @param {object} spec - an audio node spec
 * @param {object} plugin - the node's plugin
 * @param {object} s - the folded item state
 * @returns {number}
 *
 * @example knobBandTop({}, {ports: () => ({inputs: [], outputs: []})}, {w: 150, h: 90}) > NODE_HEADER_H // true
 * @example // a spec WITH a readout starts its knobs lower than the same spec without
 * @example knobBandTop({readout: "x", knobs: [{key: "x"}]}, {ports: () => ({inputs: [], outputs: []})}, {w: 150, h: 200}) > knobBandTop({}, {ports: () => ({inputs: [], outputs: []})}, {w: 150, h: 200}) // true
 */
export function knobBandTop(spec, plugin, s) {
  const rows = portLayout(plugin, s);
  const lastRow = rows.length ? Math.max(...rows.map((p) => p.y)) : NODE_HEADER_H;
  const afterPorts = lastRow + PORT_BEAD_R + READOUT_GAP;
  // The readout, when there is one, sits at `afterPorts + AUDIO_READOUT_SIZE`
  // (readoutBaseline's knobs branch — a BASELINE, so the glyphs sit above it).
  // The band therefore starts one gap below that line, not below a centred one.
  return spec.readout ? afterPorts + AUDIO_READOUT_SIZE + READOUT_GAP : afterPorts;
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
  const dials = (spec.knobs ?? []).filter((k) => !k.discrete).length;
  if (dials === 0) return 0;
  const perRow = Math.max(1, Math.floor(width / KNOB_PITCH_X));
  return Math.ceil(dials / perRow) * KNOB_ROW_H + KNOB_BAND_PAD;
}

/** Bottom margin under the last knob row, so a label is not flush with the rim. */
const KNOB_BAND_PAD = 6;

/**
 * Pure function. A node's default height: tall enough for its ports AND for its
 * readout band, when it has one.
 *
 * `minimumNodeHeight` sizes a card to its PORTS alone, which is correct for the
 * proof trio (their value text is centred over the whole body). An audio node with a
 * readout needs one more line below the last row, or the readout would be placed
 * outside the card it belongs to.
 *
 * @param {object} spec - an audio node spec
 * @param {object} portsFn - the node's ports accessor
 * @returns {number} a default height
 *
 * @example // a spec with a readout is taller than the same spec without one
 * @example readoutNodeHeight({readout: "x", knobs: [{key: "x", default: 1}]}, () => ({inputs: [], outputs: []})) > readoutNodeHeight({}, () => ({inputs: [], outputs: []})) // true
 */
export function readoutNodeHeight(spec, portsFn, width = AUDIO_NODE_W) {
  const base = minimumNodeHeight({ ports: portsFn }, {});
  const withReadout = spec.readout ? base + AUDIO_READOUT_SIZE + READOUT_GAP * 2 : base;
  // …AND FOR ITS KNOB BAND. A node born too short to show its own dials would
  // paint them past its bottom rim, which is the same defect the readout had
  // before it was placed below the port rows (see audioReadoutOps). The author
  // may still shrink the card afterwards — that clips, visibly, which is the
  // signal the registry docblock asks for rather than one to hide.
  return withReadout + knobBandHeight(spec, width);
}

/** The readout's type size: bigger than a port label, smaller than the display
 *  node's headline number, because it shares its row with neither. */
export const AUDIO_READOUT_SIZE = 13;
