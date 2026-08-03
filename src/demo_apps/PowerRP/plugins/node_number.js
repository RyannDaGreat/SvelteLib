/**
 * NUMBER SOURCE node — the simplest possible node widget, and the one that proves
 * the node system is made of ORDINARY PowerRP state.
 *
 * It holds one number and emits it on one `number` output. That is all it does,
 * and that is the point: `value` is a plain numeric leaf, so it is an EQUATION
 * SLOT for free (core/expressions.js: a property is an equation slot iff the
 * plugin's default is a NUMBER and the folded value is a STRING), it is
 * KEYFRAMABLE for free, and it TWEENS for free. Keyframe it 3 on slide 1 and 10 on
 * slide 2 and every node downstream of it animates — with no code in this file, in
 * core/nodeflow.js, or in any consumer, because the value flows through the same
 * fold every other property does.
 *
 * That is the whole determinism story for the node system (blueprint §7): the
 * GRAPH and every knob are PROPERTY STATE, so a patch is reproducible under a
 * shuffle of time and needs no history.
 *
 * ── WHY A DEDICATED WIDGET AND NOT "any widget with an output" ───────────────
 * A node needs somewhere for a value to ENTER the graph. Binding a math node's
 * input directly to an equation would work, but it would make the value invisible
 * on the canvas — and the user's whole framing is direct manipulation ("I want to
 * be able to grab nodes and move them, not just use the properties tab"). A source
 * node puts the number on the slide where you can see it, drag it, and keyframe it.
 */

import { EPHEMERAL } from "../core/ephemeral.js";
import { standardBBoxAnchors } from "../core/derive.js";
import { bundle, bundleNestedDefaults, props } from "../core/properties.js";
import { NODE_ITEM_REFS, minimumNodeHeight } from "../core/nodeflow.js";
import { formatNodeValue, nodeCard, nodeRim, nodeValueText, portBeads } from "../core/node_chrome.js";
import { applyEffects, effectsCullMargin } from "../render_gpu/effects.js";
import * as T from "../core/transform.js";

const DEFAULT_W = 130;
const DEFAULT_VALUE = 1;
const CAT = "node";

/** The port declaration, hoisted so `defaults.h` can size the card to fit it —
 *  the plugin object cannot reference itself while it is being built. */
const PORTS = { inputs: [], outputs: [{ key: "out", type: "number", label: "out" }] };

export const nodeNumberPlugin = {
  type: "node_number",
  ephemeral: EPHEMERAL.NONE,
  title: "Number Node",
  capabilities: { bbox: true, transform: true, resizable: true, backdrop: false },
  itemRefs: NODE_ITEM_REFS,
  defaults: {
    type: "node_number", x: 100, y: 100, w: DEFAULT_W,
    h: minimumNodeHeight({ ports: () => PORTS }, {}),
    z: 0, rotation: 0, scale: 1,
    rotationAnchor: { x: "self.anchors.center.x", y: "self.anchors.center.y" },
    // THE bindable, keyframable, tweenable value. A plain number default is what
    // makes it an equation slot.
    value: DEFAULT_VALUE,
    // THE CONNECTION MAP, empty at birth. Declared in `defaults` rather than left
    // absent because `itemRefs` names a path THROUGH it (NODE_ITEM_REFS), and a
    // wildcard cannot expand over a slot that does not exist — a node with no
    // `inputs` key could never have a wire remapped when it was copied.
    inputs: {},
    ...bundleNestedDefaults("effects"),
  },
  inspector: [
    ...bundle("transform"),
    { key: "value", label: "Value", kind: "number", category: CAT, help: "The number this node sends out. An ordinary numeric slot: type a number, bind it with '=' to a live value, or keyframe it across slides — everything wired downstream follows, and tweens when it tweens." },
    ...props("opacity"),
    ...bundle("effects"),
  ],
  ports: () => PORTS,
  /**
   * Pure function. The node protocol's compute step: this node's outputs given its
   * state and its (empty) inputs. A source has nothing to read, so it simply
   * publishes its own value.
   *
   * @param {object} s - the folded item state
   * @returns {{out: number}}
   *
   * @example nodeNumberPlugin.computeOutputs({value: 3}) // {out: 3}
   * @example nodeNumberPlugin.computeOutputs({}) // {out: 0}
   */
  computeOutputs(s) {
    return { out: Number(s.value ?? 0) };
  },
  /**
   * Pure function. The card, the value readout, the beads, the rim — the shared
   * node chrome (core/node_chrome.js), so this widget cannot drift from its
   * siblings' look.
   *
   * @param {object} s - the folded item state
   * @param {*} _target - unused (bbox widget)
   * @param {object} world - the world transform (effects halo mapping)
   * @returns {object[]} display-list commands
   */
  emit(s, _target, world) {
    const ops = [
      ...nodeCard(s, "Number"),
      ...nodeValueText(s, formatNodeValue(Number(s.value ?? 0))),
      ...portBeads(nodeNumberPlugin, s),
      ...nodeRim(s),
    ];
    return applyEffects(ops, s, world, { x: 0, y: 0, w: s.w ?? 0, h: s.h ?? 0 });
  },
  // Palette + toolbar entry. Placed with the crosshair like every other widget
  // (armCrosshairPlacement), so inserting a node is the SAME gesture as inserting
  // a rectangle — a node is an ordinary widget and its insertion must not feel
  // like a special mode.
  commands: [{ id: "add-node-number", title: "Add Number Node", icon: "mdi:numeric", run: (app) => app.armCrosshairPlacement(nodeNumberPlugin) }],
  cullMargin: effectsCullMargin,
  anchors: standardBBoxAnchors,
  closestAnchor(state, wx, wy, world) {
    const local = T.apply(T.invert(world), wx, wy);
    return { x: Math.max(0, Math.min(state.w ?? 0, local.x)), y: Math.max(0, Math.min(state.h ?? 0, local.y)) };
  },
};
