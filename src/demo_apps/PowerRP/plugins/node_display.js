/**
 * DISPLAY node — one `number` input, no outputs, and its picture IS the value it
 * received. The end of the proof trio, and the widget that makes the whole feature
 * VISIBLE: wire a source through a math node into a display and the number on the
 * slide is the number the graph computed.
 *
 * ── WHY THIS NODE NEEDED A DERIVE SEAM ──────────────────────────────────────
 * Every other widget's picture is a function of its own state. This one's is not:
 * the number it shows arrived over a WIRE, so it is nowhere in this item's state by
 * construction. emit()'s signature carries only the item state, which is exactly
 * the situation the graph family hit with document variables — and the answer is
 * the same one, the same shape, in the same place: core/derive.js evaluates the
 * node graph once per derive and injects each node's resolved ports as
 * `state.nodePorts` (see THE NODE-GRAPH SEAM there, and withDerivedInjections).
 *
 * So this plugin reads `s.nodePorts.inputs.in` and does no graph work of its own.
 * It cannot: a plugin that walked the item map to find its own source would be
 * reaching outside its own state, would duplicate the topological order, and would
 * be one more place for the readout and the wire to disagree by a frame.
 *
 * ── DERIVED, NOT STORED ─────────────────────────────────────────────────────
 * The displayed number is NEVER written back into the document. It is derived
 * output, recomputed from the fold every time — which is what keeps it correct
 * under a tween (the source's value lerps, so the readout lerps) and under undo,
 * and what keeps a display from being a second copy of the truth that can go stale.
 *
 * ── UNCONNECTED SHOWS ZERO, NOT AN ERROR ────────────────────────────────────
 * core/nodeflow.evaluateNodeGraph zeroes an unconnected input, so a freshly
 * inserted display reads "0" rather than blank or "—". A blank card looks broken; a
 * zero is the honest value of a wire carrying nothing.
 */

import { EPHEMERAL } from "../core/ephemeral.js";
import { standardBBoxAnchors } from "../core/derive.js";
import { bundle, bundleNestedDefaults, props } from "../core/properties.js";
import { NODE_ITEM_REFS, minimumNodeHeight } from "../core/nodeflow.js";
import { formatNodeValue, nodeCard, nodeRim, nodeValueText, portBeads } from "../core/node_chrome.js";
import { applyEffects, effectsCullMargin } from "../render_gpu/effects.js";
import * as T from "../core/transform.js";

const DEFAULT_W = 140;
const DEFAULT_DECIMALS = 3;
const CAT = "node";

const PORTS = { inputs: [{ key: "in", type: "number", label: "in" }], outputs: [] };

/**
 * Pure function. The string a display node shows for a given resolved input.
 * Exported so the readout has ONE spelling that tests and the canvas can both call
 * without going through emit() and reading a display list back.
 *
 * @param {object} s - the folded item state (its `decimals`, and its injected `nodePorts`)
 * @returns {string}
 *
 * @example displayReadout({nodePorts: {inputs: {in: 6}}}) // "6"
 * @example displayReadout({nodePorts: {inputs: {in: 1 / 3}}}) // "0.333"
 * @example displayReadout({nodePorts: {inputs: {in: 1 / 3}}, decimals: 1}) // "0.3"
 * @example displayReadout({}) // "0" (nothing wired, and no graph evaluated yet)
 * @example displayReadout({nodePorts: {inputs: {in: 2}}, prefix: "$"}) // "$2"
 * @example displayReadout({nodePorts: {inputs: {in: 50}}, suffix: "%"}) // "50%"
 */
export function displayReadout(s) {
  const v = Number(s?.nodePorts?.inputs?.in ?? 0);
  return `${s?.prefix ?? ""}${formatNodeValue(v, s?.decimals ?? DEFAULT_DECIMALS)}${s?.suffix ?? ""}`;
}

export const nodeDisplayPlugin = {
  type: "node_display",
  ephemeral: EPHEMERAL.NONE,
  title: "Display Node",
  capabilities: { bbox: true, transform: true, resizable: true, backdrop: false },
  itemRefs: NODE_ITEM_REFS,
  defaults: {
    type: "node_display", x: 520, y: 100, w: DEFAULT_W,
    h: minimumNodeHeight({ ports: () => PORTS }, {}),
    z: 0, rotation: 0, scale: 1,
    rotationAnchor: { x: "self.anchors.center.x", y: "self.anchors.center.y" },
    decimals: DEFAULT_DECIMALS,
    prefix: "",
    suffix: "",
    // THE CONNECTION MAP, empty at birth. Declared in `defaults` rather than left
    // absent because `itemRefs` names a path THROUGH it (NODE_ITEM_REFS), and a
    // wildcard cannot expand over a slot that does not exist — a node with no
    // `inputs` key could never have a wire remapped when it was copied.
    inputs: {},
    ...bundleNestedDefaults("effects"),
  },
  inspector: [
    ...bundle("transform"),
    { key: "decimals", label: "Decimals", kind: "number", min: 0, max: 10, category: CAT, help: "The most fractional places to show. Trailing zeros are trimmed, so 6 reads as '6' and not '6.000'. The value itself is not rounded — only its readout." },
    { key: "prefix", label: "Prefix", kind: "text", category: CAT, help: "Text placed before the number ('$', 'x'). Cosmetic only." },
    { key: "suffix", label: "Suffix", kind: "text", category: CAT, help: "Text placed after the number ('%', ' Hz', ' dB'). Cosmetic only." },
    ...props("opacity"),
    ...bundle("effects"),
  ],
  ports: () => PORTS,
  // NO computeOutputs: a display is a pure SINK. The absence is the declaration —
  // core/nodeflow.evaluateNodeGraph stores an empty outputs map for a plugin that
  // has none, so nothing downstream can wire to it and there is no empty function
  // sitting here pretending otherwise.
  /**
   * Pure function. The shared node chrome with the RECEIVED value as the readout.
   *
   * @param {object} s - the folded item state, with `nodePorts` injected by derive
   * @param {*} _target - unused (bbox widget)
   * @param {object} world - the world transform (effects halo mapping)
   * @returns {object[]} display-list commands
   */
  emit(s, _target, world) {
    const ops = [
      ...nodeCard(s, "Display"),
      ...nodeValueText(s, displayReadout(s)),
      ...portBeads(nodeDisplayPlugin, s),
      ...nodeRim(s),
    ];
    return applyEffects(ops, s, world, { x: 0, y: 0, w: s.w ?? 0, h: s.h ?? 0 });
  },
  // Palette + toolbar entry. Placed with the crosshair like every other widget
  // (armCrosshairPlacement), so inserting a node is the SAME gesture as inserting
  // a rectangle — a node is an ordinary widget and its insertion must not feel
  // like a special mode.
  commands: [{ id: "add-node-display", title: "Add Display Node", icon: "mdi:monitor-eye", run: (app) => app.armCrosshairPlacement(nodeDisplayPlugin) }],
  cullMargin: effectsCullMargin,
  anchors: standardBBoxAnchors,
  closestAnchor(state, wx, wy, world) {
    const local = T.apply(T.invert(world), wx, wy);
    return { x: Math.max(0, Math.min(state.w ?? 0, local.x)), y: Math.max(0, Math.min(state.h ?? 0, local.y)) };
  },
};
