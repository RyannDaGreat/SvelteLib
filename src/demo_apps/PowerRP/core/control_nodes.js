/**
 * CONTROL NODES — the widgets whose whole purpose is to be PLAYED BY HAND.
 *
 * ── THE FOUNDING ASK (user, 2026-08-03, verbatim) ───────────────────────────
 * "I'll also like to have a knob node, for example. Slider nodes, button nodes
 * for triggers. I need nodes in the UI so that some of these patches I can play
 * with them. I need to be able to play with them myself. Even a keyboard node is
 * good. Polyphonic demos are important"
 *
 * Four widgets: KNOB and SLIDER emit a number, BUTTON emits a trigger, KEYBOARD
 * emits pitch and gate. What makes them a FAMILY rather than four unrelated
 * nodes is that each one is an INPUT SURFACE — the graph's other nodes compute,
 * and these are where a human's hand enters the patch.
 *
 * ── THE STATE QUESTION, WHICH IS THE WHOLE DESIGN ───────────────────────────
 * A control node has to be two things at once and CLAUDE.md's taxonomy is what
 * keeps that honest:
 *
 *   ITS STORED VALUE IS PROPERTY STATE. A knob's `value` is a plain numeric leaf:
 *     keyframable, tweenable, an equation slot for free, folded from the document
 *     like `w`. Set a knob to 0.2 on slide 1 and 0.9 on slide 2 and the patch
 *     sweeps across the transition with no code anywhere. This is the DEFAULT
 *     reading of a control node and it is what an EXPORT renders — a rendered
 *     video of a deck with a knob in it shows the knob at its authored value,
 *     deterministically, on every machine.
 *
 *   ITS LIVE PLAY IS A PRESENTER INPUT. Turning the dial during a presentation,
 *     or pressing the button, is the SAME CLASS as the presenter's mouse: it is
 *     not document state, it is a person interacting with a running thing. The
 *     blueprint already classifies the audio engine this way (§7, "a live
 *     consumer"), and a button press is a live consumer's input.
 *
 * The two do not conflict because they meet at ONE seam: a knob turn WRITES the
 * property (setPreview/commitPreview, one undo unit — that is web/knobFocus.js,
 * unchanged), so live play in the EDITOR is ordinary editing. What is genuinely
 * live and unrecorded is the BUTTON and the KEYBOARD, whose events are moments
 * rather than values.
 *
 * ── WHAT A RECORDED EXPORT DOES WITH A BUTTON PRESS: NOTHING, AND THAT IS
 *    CORRECT ────────────────────────────────────────────────────────────────
 * Stated plainly because the alternative looks like a bug: `cli/render_job.js`
 * rendering a deck containing a Button node produces frames in which the button
 * was never pressed. It is not that the press was dropped — there was no press.
 * A press is a live human event with no representation in `[[slide, alpha]]`, so
 * by the core invariant (RenderTree = pure(document, [[slide, alpha]])) it cannot
 * be in the render, and a "recording" of one would have to be EPHEMERAL state,
 * which the project has none of and exists to avoid.
 *
 * A deck that wants a trigger to fire in an export must drive it from something
 * that IS state: a Clock or Sequencer (recordable — a pure function of elapsed
 * time), or a keyframed number crossing a threshold. The Button is for playing,
 * and playing is what happens in front of an audience.
 *
 * This is the SAME boundary the video player sits on, and it is the same answer:
 * the manifest says a player's playing is not document state. A button's pressing
 * is not either.
 *
 * ── ONE SHAPE, FOUR WIDGETS ─────────────────────────────────────────────────
 * As with core/audio_nodes.js: what these four share (a card, a family, an
 * `inputs: {}` so copies remap, a bead-inclusive ink bounds, effects, a rim) is
 * written ONCE here, and each plugin is its own picture plus its own ports. They
 * do NOT go through `audioNodePlugin`, because a control node has no engine
 * module behind it — it is a source of document values, and the mirror must not
 * mistake it for something to instantiate.
 *
 * DOM-free and engine-free: core/ runs in bare node.
 */

import { EPHEMERAL } from "./ephemeral.js";
import { standardBBoxAnchors } from "./derive.js";
import { bundle, bundleNestedDefaults, props } from "./properties.js";
import { NODE_ITEM_REFS, nodeCardRim, nodeInkBounds } from "./nodeflow.js";
import { applyEffects, effectsCullMargin } from "../render_gpu/effects.js";
import * as T from "./transform.js";

/** The Inspector category a control node's own rows land in. One category so a
 *  knob's range rows are one collapsible group rather than scattered among the
 *  universal transform rows. */
export const CONTROL_CAT = "control";

/**
 * The FAMILY every control node declares.
 *
 * `modulation` — the control plane, the family whose members drive other nodes
 * rather than being heard. An LFO and a knob do the same job by different means
 * (one from a wave, one from a hand), so they read as siblings on the canvas,
 * which is exactly what a family is for. Deliberately NOT a new seventh family:
 * a colour is only meaningful if it distinguishes, and "things that produce
 * control values" is what modulation already means.
 */
export const CONTROL_FAMILY = "modulation";

/**
 * Pure function. A control node's value, coerced and clamped, or its default.
 *
 * ── WHY A BOUND (EQUATION) VALUE FALLS BACK TO THE DEFAULT HERE ─────────────
 * The same reasoning as core/audio_nodes.audioKnobValues, for a different
 * consumer. A knob whose slot holds an unresolved equation has no number in it,
 * and the node's OUTPUT must still be a number — `computeOutputs` returning NaN
 * would propagate through every downstream node's arithmetic and turn one
 * visible equation error into a graph-wide silent one.
 *
 * The dial's own PICTURE does not use this (it reads the raw state, so a bound
 * knob can be drawn as bound and refused by the drag — see
 * core/node_knobs.knobLayout). This is the value the GRAPH sees.
 *
 * @param {*} raw - the folded state's value
 * @param {number} fallback - the plugin's default
 * @param {number} min - range minimum
 * @param {number} max - range maximum
 * @returns {number}
 *
 * @example controlValue(0.5, 0, 0, 1) // 0.5
 * @example // out of range is CLAMPED: a keyframe or equation may overshoot, and
 * @example // a knob that reports past its own maximum is lying about its range
 * @example controlValue(5, 0, 0, 1) // 1
 * @example controlValue(-5, 0, 0, 1) // 0
 * @example // an unresolved equation is not a number; the default stands in
 * @example controlValue("= ease(time)", 0.25, 0, 1) // 0.25
 * @example controlValue(undefined, 0.25, 0, 1) // 0.25
 */
export function controlValue(raw, fallback, min, max) {
  const n = Number(raw);
  const v = Number.isFinite(n) ? n : fallback;
  return Math.max(min, Math.min(max, v));
}

/**
 * Pure function. The min/max/step Inspector rows every RANGED control node
 * (knob, slider) carries.
 *
 * Written once because the knob and the slider are the same control with two
 * pictures, and a range that meant different things on the two would be a bug
 * nobody would look for. They are ORDINARY number rows on flat leaves, which is
 * what makes a range itself keyframable — a knob whose maximum tweens is odd but
 * costs nothing to allow, and forbidding it would need code.
 *
 * @param {string} valueHelp - the help sentence for the `value` row (each widget
 *     describes its own gesture)
 * @returns {object[]} Inspector row descriptors
 *
 * @example controlRangeRows("turn it").length // 4
 * @example controlRangeRows("turn it")[0].key // "value"
 * @example controlRangeRows("turn it").map((r) => r.key) // ["value", "min", "max", "step"]
 */
export function controlRangeRows(valueHelp) {
  return [
    { key: "value", label: "Value", kind: "number", category: CONTROL_CAT, help: valueHelp },
    { key: "min", label: "Min", kind: "number", category: CONTROL_CAT, help: "The bottom of the range. The output at the control's lowest position." },
    { key: "max", label: "Max", kind: "number", category: CONTROL_CAT, help: "The top of the range. The output at the control's highest position." },
    { key: "step", label: "Step", kind: "number", min: 0, category: CONTROL_CAT, help: "Snap increment. 0 means continuous — leave it there for anything that is genuinely smooth, and set it to 1 for a control that counts." },
  ];
}

/**
 * Pure function. The `defaults` fragment every control node shares.
 *
 * `inputs: {}` is present-but-empty for the reason NF-CORE measured: NODE_ITEM_REFS
 * names a wildcard path THROUGH it, and a wildcard cannot expand over a slot that
 * does not exist — so a control node without this key would stay wired to the
 * original when it was copied.
 *
 * @param {string} type - the widget type
 * @param {number} w - default width
 * @param {number} h - default height
 * @param {object} own - the widget's own extra defaults
 * @returns {object}
 *
 * @example controlDefaults("node_knob", 96, 110, {value: 0.5}).type // "node_knob"
 * @example controlDefaults("node_knob", 96, 110, {value: 0.5}).value // 0.5
 * @example // the empty-but-present connection map, without which copies stay wired
 * @example JSON.stringify(controlDefaults("node_knob", 96, 110, {}).inputs) // "{}"
 */
export function controlDefaults(type, w, h, own) {
  return {
    type, x: 100, y: 100, w, h,
    z: 0, rotation: 0, scale: 1,
    rotationAnchor: { x: "self.anchors.center.x", y: "self.anchors.center.y" },
    inputs: {},
    ...own,
    ...bundleNestedDefaults("effects"),
  };
}

/**
 * Pure function. A COMPLETE plugin for one control node, from the parts that
 * differ between them.
 *
 * What the caller supplies: its type, title, icon, ports, defaults, its own
 * Inspector rows, a `paint(state)` returning the display-list ops INSIDE the
 * card, and optionally `computeOutputs`, `knobLayout` and an `activate` handler.
 * What this supplies: the card, the rim, the beads, the effects halo, the bounds
 * protocol, the anchors, the rim projection and the palette command — i.e. every
 * part where getting it wrong is a defect the registry docblock already names.
 *
 * @param {object} spec - the control node's differing parts
 * @returns {object} a plugin object for core/registry.js
 *
 * @example // controlNodePlugin({type: "node_knob", …}).capabilities.bbox // true
 * @example controlNodePlugin({type: "n", title: "N", defaults: {}, ports: {inputs: [], outputs: []}, paint: () => []}).type // "n"
 * @example controlNodePlugin({type: "n", title: "N", defaults: {}, ports: {inputs: [], outputs: []}, paint: () => []}).controlNode // true
 */
export function controlNodePlugin(spec) {
  const portsFn = () => spec.ports;
  const plugin = {
    type: spec.type,
    ephemeral: EPHEMERAL.NONE,
    title: spec.title,
    capabilities: { bbox: true, transform: true, resizable: true, backdrop: false },
    itemRefs: NODE_ITEM_REFS,
    // ── THE FAMILY MARKER THE MIRROR AND THE PALETTE BOTH READ ──────────────
    // `controlNode` is the declaration that this widget is a HUMAN INPUT rather
    // than an engine module. web/audioMirror reads `audioModule` to decide what
    // to instantiate and finds nothing here, which is right — a knob has no
    // engine counterpart, it produces a NUMBER that flows through the ordinary
    // node evaluator into whatever it is wired to. The flag exists so a sweep
    // can ask "which widgets are control surfaces" without a type-string list.
    controlNode: true,
    defaults: spec.defaults,
    inspector: [
      ...bundle("transform"),
      ...(spec.rows ?? []),
      ...props("opacity"),
      ...bundle("effects"),
    ],
    ports: portsFn,
    ...(spec.computeOutputs ? { computeOutputs: spec.computeOutputs } : {}),
    ...(spec.knobLayout ? { knobLayout: spec.knobLayout } : {}),
    ...(spec.activate ? { activate: spec.activate } : {}),
    ...(spec.extra ?? {}),
    /**
     * Pure function. The card, the widget's own face, the beads, the rim.
     *
     * STAYS PURE, and for a control node that is worth restating: whether a
     * button is CURRENTLY HELD is live input, not document state, so it is not
     * read here. The face painted here is the widget's resting form, which is
     * what every export and cli/render.js gets — the honest picture of a
     * document nobody is currently playing. The pressed highlight is a
     * screen-space overlay, the same seam the audio meters use.
     */
    emit(s, _target, world) {
      return applyEffects(spec.paint(s), s, world, { x: 0, y: 0, w: s.w ?? 0, h: s.h ?? 0 });
    },
    commands: [{
      id: `add-${spec.type.replace(/_/g, "-")}`,
      title: `Add ${spec.title}`,
      icon: spec.icon ?? "mdi:tune",
      category: "Control Nodes",
      run: (app) => app.armCrosshairPlacement(plugin),
    }],
    cullMargin: effectsCullMargin,
    localBounds: (state) => nodeInkBounds(plugin, state),
    anchors: standardBBoxAnchors,
    closestAnchor(state, wx, wy, world) {
      const local = T.apply(T.invert(world), wx, wy);
      return nodeCardRim(state, local.x, local.y);
    },
  };
  return plugin;
}
