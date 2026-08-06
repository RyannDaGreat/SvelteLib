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
import { NODE_BODY_GAP, nodeBodyTop, nodeBox, nodeFaceBand, textLineH } from "./node_chrome.js";
import { AUDIO_READOUT_SIZE } from "./audio_nodes.js";
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
 * The value readout every ranged control node prints under its face, as a BAND:
 * one line of type plus the gap above it. Sized from the line rather than chosen,
 * for the reason core/node_chrome.textLineH records — the two constants this
 * replaces (`READOUT_BASELINE_GAP = 14` in BOTH plugins/node_knob.js and
 * plugins/node_slider.js) were each one plugin's attempt to guess how much room a
 * baseline needs beneath it, on a renderer that has no baseline.
 */
export const CONTROL_READOUT_H = NODE_BODY_GAP + textLineH(AUDIO_READOUT_SIZE);

/**
 * Pure function. THE FACE — the LOCAL rect a control node draws its own control
 * inside, and the guarantee that it is inside the card.
 *
 * ── THE ONE LAYOUT PATH, AND IT IS UNBYPASSABLE (R7-10) ─────────────────────
 * `.frenzy/round7/patchers_blueprints_report.md` §(a) states the rule this obeys
 * and the reason it is not optional: *"a control never has an authored `x`. The
 * moment it does, you have VCV Rack."* In Rack, `ModuleWidget::addParam()` is
 * `addChild(param)` with no bounds check, so an out-of-panel knob is never drawn
 * and receives no events while still serializing, randomizing and being read
 * every sample — an invisible, unreachable, LIVE control, which is strictly worse
 * than one sticking out of the box because there is nothing to notice.
 *
 * So a control node does not get to say WHERE. It declares WHAT (a natural
 * height, whether it stretches, what it reserves beneath) and this returns the
 * rect. Bespoke Synth is the measured cautionary tale for making that optional:
 * it has an excellent auto-layout macro and only 83 of ~265 modules use it,
 * because 191 headers override the sizing hook. There is no override here, the
 * same way core/audio_nodes.js:305-312 deliberately withholds one for `emit` and
 * `ports`.
 *
 * The vertical placement is `core/node_chrome.nodeFaceBand`, i.e. the SAME ladder
 * the audio modules' knob band descends; the horizontal is the card's own
 * resolved width inset by the face's declared margin. Neither is a free parameter.
 *
 * @param {object} face - {height, minScale?, grow?, bottomPad?, inset?}
 * @param {object} plugin - the node's own plugin (for its port rows)
 * @param {object} s - the folded item state
 * @returns {{x: number, y: number, w: number, h: number, scale: number}} LOCAL
 *
 * @example // a tall card gives an elastic face all the room under its ports
 * @example controlFace({height: 40, grow: true}, {ports: () => ({outputs: [{key: "out", type: "number"}]})}, {w: 100, h: 200}) // {x: 0, y: 48, w: 100, h: 152, scale: 1}
 * @example // an INSET narrows it symmetrically, and never below zero
 * @example controlFace({height: 40, grow: true, inset: 14}, {ports: () => ({outputs: [{key: "out", type: "number"}]})}, {w: 100, h: 200}).w // 72
 * @example // a RIGID face keeps its natural height and slides up when short
 * @example controlFace({height: 52}, {ports: () => ({outputs: [{key: "out", type: "number"}]})}, {w: 100, h: 200}).h // 52
 * @example // a FLIPPED card is a reflection, not a negative face
 * @example controlFace({height: 52}, {ports: () => ({outputs: [{key: "out", type: "number"}]})}, {w: -100, h: -200}).w // 100
 */
export function controlFace(face, plugin, s) {
  const { w, h } = nodeBox(s);
  const top = nodeBodyTop(plugin, s);
  const band = nodeFaceBand({ floorTop: top, top, ...face }, h);
  const inset = Math.max(0, face.inset ?? 0);
  return { x: inset, y: band.top, w: Math.max(0, w - inset * 2), h: band.height, scale: band.scale };
}

/**
 * Pure function. A control node's NATURAL height — the sum of its derived bands,
 * exactly as Axoloti computes a node's size from its declaration
 * (`AxoObjectInstanceAbstract.resizeToGrid`, research report Q2 §"Size
 * computation").
 *
 * ── NATURAL IS A FLOOR, NOT A LIMIT, AND THAT IS THE RECONCILIATION ─────────
 * Axoloti's size is computed and FINAL — an author cannot resize a node at all.
 * Ours must be resizable, because a node lives on a SLIDE and the slide decides
 * how big it may be; the founding ask has nodes at whatever size the deck needs.
 * The two are reconciled the way the lead directed: the derived sum is the
 * DEFAULT and the advisory floor, and `nodeFaceBand`'s ladder covers everything
 * below it — slide up, shrink, then clip visibly. So the author keeps the drag,
 * and the drag can no longer put a control outside the card.
 *
 * It is deliberately NOT snapped to a grid. Axoloti's ⌈h/14⌉·14 is what makes its
 * patches tile, and it works there because nothing is resizable and no row holds
 * a widget. Ours would fight two things that already exist: the author's own drag
 * and core/snap.js, which snaps a node to its NEIGHBOURS' edges rather than to an
 * absolute lattice. A second, invisible lattice underneath a visible snap solver
 * is a control that argues with the user.
 *
 * @param {object} face - the face declaration (its natural `height`)
 * @param {object} ports - the node's port declaration
 * @param {number} [bottomPad] - what the face reserves beneath it
 * @returns {number} a LOCAL height
 *
 * @example // header + one port row + gap + a 52-tall face + a readout band
 * @example controlNodeHeight({height: 52, bottomPad: CONTROL_READOUT_H}, {outputs: [{key: "out", type: "number"}]}) // 123.6
 * @example // no readout to reserve, so the card is exactly its face plus the stack
 * @example controlNodeHeight({height: 52}, {outputs: [{key: "out", type: "number"}]}) // 100
 */
export function controlNodeHeight(face, ports, bottomPad = face.bottomPad ?? 0) {
  return nodeBodyTop({ ports: () => ports }, {}) + Math.max(0, face.height ?? 0) + bottomPad;
}

/**
 * Pure function. THE DECLARED FLOOR — the height at which a control node's reflow
 * ladder bottoms out and its content begins to CLIP, visibly, on purpose.
 *
 * ── WHY A NODE HAS TWO SIZES AND NEITHER IS A LIMIT ─────────────────────────
 * `controlNodeHeight` is the NATURAL size: what the content wants, and the
 * default a fresh node is born at. This is the FLOOR: the smallest height at
 * which everything is still inside the card, after the band has slid up and
 * shrunk to its minimum scale. Between them the layout reflows and the
 * containment invariant HOLDS; below it the registry docblock's rule takes over
 * ("SHOW the overflow so the author can see the node is too small").
 *
 * IT IS ADVISORY, NOT ENFORCED, and that is a decision rather than an omission.
 * Enforcing it would mean refusing a resize the author asked for, and a node
 * lives on a SLIDE — the deck decides how much room a patch may have, and a
 * hard minimum would make some layouts simply impossible to author. The
 * alternative to enforcement is not "knobs escape": it is the ladder, which
 * keeps them in down to this line and then fails LOUDLY to the eye. What the
 * author loses below the floor is legibility, which they can see; what they
 * would lose under enforcement is the drag, which they cannot get back.
 *
 * It depends on the WIDTH because a face's natural height can too (a knob band
 * wraps), so it takes the state rather than a bare port list.
 *
 * @param {object} face - the face declaration
 * @param {object} plugin - the node's own plugin (for its port rows)
 * @param {object} s - the folded item state (its `w` decides any wrap)
 * @returns {number} a LOCAL height
 *
 * @example // 48 (below one port row) + 52/3 + a 23.6 readout band
 * @example Math.round(controlFloorHeight({height: 52, bottomPad: 23.6}, {ports: () => ({outputs: [{key: "out", type: "number"}]})}, {w: 104})) // 89
 */
export function controlFloorHeight(face, plugin, s) {
  const natural = Math.max(0, face.height ?? 0);
  const minScale = face.minScale ?? CONTROL_FACE_MIN_SCALE;
  return nodeBodyTop(plugin, { ...s, h: undefined }) + natural * minScale + Math.max(0, face.bottomPad ?? 0);
}

/** The tightest a control node's face may be squeezed, as a fraction of its
 *  natural height — the same floor a knob band takes (core/node_knobs
 *  .KNOB_BAND_MIN_SCALE), because it is the same judgement: past roughly a third
 *  a control is a smudge that still eats presses. Named here rather than
 *  imported bare so the two can diverge if a face ever needs a different floor,
 *  and so a reader of this file sees which number applies. */
export const CONTROL_FACE_MIN_SCALE = 1 / 3;

/**
 * Pure function. A COMPLETE plugin for one control node, from the parts that
 * differ between them.
 *
 * What the caller supplies: its type, title, icon, ports, defaults, its own
 * Inspector rows, a FACE DECLARATION, a `paint(state, face)` returning the
 * display-list ops inside that face, and optionally `computeOutputs`,
 * `knobLayout` and an `activate` handler.
 * What this supplies: the card, the rim, the beads, the effects halo, the bounds
 * protocol, the anchors, the rim projection, the palette command — and, since
 * R7-10, THE FACE ITSELF. A plugin no longer computes where its control goes; it
 * is handed the rect (see controlFace for why that is not negotiable).
 *
 * @param {object} spec - the control node's differing parts
 * @returns {object} a plugin object for core/registry.js
 *
 * @example // controlNodePlugin({type: "node_knob", …}).capabilities.bbox // true
 * @example controlNodePlugin({type: "n", title: "N", defaults: {}, ports: {inputs: [], outputs: []}, paint: () => []}).type // "n"
 * @example controlNodePlugin({type: "n", title: "N", defaults: {}, ports: {inputs: [], outputs: []}, paint: () => []}).controlNode // true
 * @example // the face is a QUERY on the plugin, so the painter, the hit test and
 * @example // any test all read one rect rather than three copies of the arithmetic
 * @example typeof controlNodePlugin({type: "n", title: "N", defaults: {}, ports: {inputs: [], outputs: []}, face: {height: 10}, paint: () => []}).controlFace // "function"
 */
export function controlNodePlugin(spec) {
  const portsFn = () => spec.ports;
  const face = spec.face ?? { height: 0, grow: true };
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
    /** Query. THIS NODE'S FACE in LOCAL coords — the ONE rect its picture, its
     *  hit test and the containment sweep all read. Declared on the plugin for
     *  the same reason `knobLayout` is: a mode must never have to know the
     *  roster to ask a widget where its control is. */
    controlFace: (state) => controlFace(face, plugin, state),
    /** Query. THE DECLARED FLOOR (see controlFloorHeight): the height below which
     *  this widget's content starts clipping. Declared on the plugin so a sweep,
     *  a resize handle or an Inspector hint can ask a widget its own minimum
     *  rather than a roster having to know. */
    nodeFloorHeight: (state) => controlFloorHeight(face, plugin, state ?? plugin.defaults),
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
      const box = nodeBox(s);
      return applyEffects(spec.paint(s, controlFace(face, plugin, s)), s, world, { x: 0, y: 0, w: box.w, h: box.h ?? 0 });
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
