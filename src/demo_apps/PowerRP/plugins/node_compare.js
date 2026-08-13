/**
 * COMPARE node — two `number` inputs, one comparison, one `number` output that is
 * 1 or 0. The user's *"an is == 0 and is== to a number==1 nodes"* (2026-08-12).
 *
 * ── IT EMITS 1/0, NOT A BOOLEAN, AND THAT IS SETTLED DOCTRINE ───────────────
 * The user calls the upstream thing a "boolean node", and the honest implementation
 * is a NUMBER node that emits 1 or 0. `core/nodeflow.js` has no boolean port type,
 * and `plugins/node_gate.js` already ruled on adding one: *"`trigger` already coerces
 * to 1/0 … so `> 0` is the one reading every existing port type already agrees on.
 * Adding a boolean type for one node's convenience would put a fifth entry in a table
 * whose entries are supposed to be VALUE KINDS."* So the WIRE speaks the type table's
 * language and the CARD speaks the user's: the readout prints `true`/`false`.
 *
 * ── THE OPERATION IS A SELECT, FOR plugins/node_math.js's REASONS VERBATIM ──
 * Six comparisons share one shape, one port list and one chrome; they differ by one
 * symbol. As a select it is one keyframable leaf, so a patch can switch comparison
 * between slides — and, more usefully, changing your mind does not mean deleting a
 * node and rewiring both its inputs.
 *
 * ── EQUALITY ON FLOATS IS EXACT, DELIBERATELY, AND THE DEMO IS WHY IT WORKS ─
 * `eq` is `===`, with no epsilon. An epsilon would be a hidden policy with a
 * magnitude nobody chose, and it would make `== 0` true for a value that is merely
 * small — which on a `time mod 2` chain would fire the trigger over a WINDOW instead
 * of at an instant, silently widening every pulse. Authors comparing continuous
 * quantities want `lt`/`ge` (which is what a Schmitt trigger downstream is for);
 * `eq` is for the discrete case, where it is exactly right.
 */

import { EPHEMERAL } from "../core/ephemeral.js";
import { standardBBoxAnchors } from "../core/derive.js";
import { bundle, bundleNestedDefaults, props } from "../core/properties.js";
import { NODE_ITEM_REFS, minimumNodeHeight, nodeCardRim, nodeInkBounds } from "../core/nodeflow.js";
import { formatNodeValue, nodeCard, nodeRim, nodeValueText, portBeads, portIsWired } from "../core/node_chrome.js";
import { applyEffects, effectsCullMargin } from "../render_gpu/effects.js";
import * as T from "../core/transform.js";

const DEFAULT_W = 150;
const CAT = "node";

const PORTS = {
  inputs: [{ key: "a", type: "number", label: "a" }, { key: "b", type: "number", label: "b" }],
  outputs: [{ key: "out", type: "number", label: "out" }],
};

/**
 * THE COMPARISONS. One table, the `MATH_OPS` shape: the key stored in state, the
 * human label, the symbol shown on the card, and the pure predicate. Adding one is
 * a single entry — the Inspector's options, the readout symbol and the test all come
 * from here, so they cannot disagree.
 */
export const COMPARE_OPS = Object.freeze({
  eq: Object.freeze({ label: "Equal to", symbol: "=", test: (a, b) => a === b }),
  ne: Object.freeze({ label: "Not equal to", symbol: "≠", test: (a, b) => a !== b }),
  lt: Object.freeze({ label: "Less than", symbol: "<", test: (a, b) => a < b }),
  le: Object.freeze({ label: "At most", symbol: "≤", test: (a, b) => a <= b }),
  gt: Object.freeze({ label: "Greater than", symbol: ">", test: (a, b) => a > b }),
  ge: Object.freeze({ label: "At least", symbol: "≥", test: (a, b) => a >= b }),
});

const OP_KEYS = Object.keys(COMPARE_OPS);
const OP_LABELS = Object.fromEntries(OP_KEYS.map((k) => [k, COMPARE_OPS[k].label]));
const DEFAULT_OP = "eq";

/**
 * Pure function. Applies a comparison by key, yielding 1 or 0.
 *
 * An UNKNOWN key (a document written by a newer version, or a hand-edit) falls back
 * to the default and is NOT silent about it in the picture: `compareSymbol` returns
 * "?" for the same key, so the card visibly shows it does not recognise its own
 * operation instead of quietly testing equality — `applyMathOp`'s rule verbatim.
 *
 * @param {string} op - a COMPARE_OPS key
 * @param {number} a - the left operand
 * @param {number} b - the right operand
 * @returns {number} 1 or 0
 *
 * @example applyCompareOp("eq", 0, 0) // 1
 * @example applyCompareOp("eq", 1, 0) // 0
 * @example applyCompareOp("ne", 1, 0) // 1
 * @example applyCompareOp("lt", 1, 2) // 1
 * @example applyCompareOp("ge", 2, 2) // 1
 * @example applyCompareOp("nonsense", 3, 3) // 1 (unknown op falls back; the card shows "?")
 */
export function applyCompareOp(op, a, b) {
  return (COMPARE_OPS[op] ?? COMPARE_OPS[DEFAULT_OP]).test(a, b) ? 1 : 0;
}

/**
 * Pure function. The symbol a compare node shows for an operation key. "?" for an
 * unknown key — see applyCompareOp for why that visibility matters.
 *
 * @param {string} op - a COMPARE_OPS key
 * @returns {string}
 *
 * @example compareSymbol("eq") // "="
 * @example compareSymbol("ge") // "≥"
 * @example compareSymbol("nonsense") // "?"
 */
export function compareSymbol(op) {
  return COMPARE_OPS[op]?.symbol ?? "?";
}

/**
 * Pure function. The line the card prints: the test it is applying, with the
 * right-hand side spelled out when it is a KNOB rather than a wire.
 *
 * A wired `b` prints just the symbol, because the number is already visible on the
 * wire and on the node feeding it; an unwired one prints the constant, which is the
 * thing an author actually wants to read off a `== 1` card at a glance.
 *
 * @param {object} s - the folded item state
 * @returns {string}
 *
 * @example compareReadout({op: "eq", b: 1}) // "= 1"
 * @example compareReadout({op: "ge", b: 0.5}) // "≥ 0.5"
 * @example compareReadout({op: "eq", b: 1, inputs: {b: {item: "k", port: "out"}}}) // "="
 */
export function compareReadout(s) {
  const symbol = compareSymbol(s.op ?? DEFAULT_OP);
  return portIsWired(s, "b") ? symbol : `${symbol} ${formatNodeValue(Number(s.b ?? 0))}`;
}

export const nodeComparePlugin = {
  type: "node_compare",
  ephemeral: EPHEMERAL.NONE,
  title: "Compare Node",
  capabilities: { bbox: true, transform: true, resizable: true, backdrop: false },
  itemRefs: NODE_ITEM_REFS,
  defaults: {
    type: "node_compare", x: 300, y: 100, w: DEFAULT_W,
    h: minimumNodeHeight({ ports: () => PORTS }, {}),
    z: 0, rotation: 0, scale: 1,
    rotationAnchor: { x: "self.anchors.center.x", y: "self.anchors.center.y" },
    op: DEFAULT_OP,
    // THE RIGHT-HAND SIDE AS A KNOB — R7-10's knob-or-input duality, which is what
    // makes `== 1` a single node rather than a compare plus a number source. Wire
    // the `b` socket and the wire wins; leave it unwired and this ordinary
    // keyframable slot decides.
    b: 0,
    // THE CONNECTION MAP, empty at birth (NODE_ITEM_REFS names a path THROUGH it,
    // and a wildcard cannot expand over a slot that does not exist).
    inputs: {},
    ...bundleNestedDefaults("effects"),
  },
  inspector: [
    ...bundle("transform"),
    { key: "op", label: "Comparison", kind: "select", options: OP_KEYS, optionLabels: OP_LABELS, category: CAT, help: "What this node tests. The output is 1 when the test passes and 0 when it does not — there is no boolean wire type, so 1/0 is how every node in this app spells true/false. An ordinary keyframable leaf, so the test can change between slides." },
    { key: "b", label: "Compare to", kind: "number", category: CAT, help: "The number the 'a' input is tested against, used when nothing is wired into the 'b' socket. Wire the socket and the wire wins. Equality is EXACT — no tolerance — so use 'At least' or 'Less than' for continuous values." },
    ...props("opacity"),
    ...bundle("effects"),
  ],
  ports: () => PORTS,
  /**
   * Pure function. The node protocol's compute step: `a <op> b` as 1 or 0.
   *
   * @param {object} s - the folded item state (its `op` and knob `b`)
   * @param {object} inputs - every declared input, unconnected ones already zeroed
   * @returns {{out: number}}
   *
   * @example nodeComparePlugin.computeOutputs({op: "eq", b: 0}, {a: 0, b: 0}) // {out: 1}
   * @example nodeComparePlugin.computeOutputs({op: "eq", b: 1}, {a: 0, b: 0}) // {out: 0}
   * @example // an unwired `b` reads the KNOB, not the zeroed port
   * @example nodeComparePlugin.computeOutputs({op: "eq", b: 1}, {a: 1, b: 0}) // {out: 1}
   * @example // …and a wired one reads the wire
   * @example nodeComparePlugin.computeOutputs({op: "eq", b: 1, inputs: {b: {item: "k", port: "out"}}}, {a: 5, b: 5}) // {out: 1}
   */
  computeOutputs(s, inputs) {
    const b = portIsWired(s, "b") ? Number(inputs.b ?? 0) : Number(s.b ?? 0);
    return { out: applyCompareOp(s.op ?? DEFAULT_OP, Number(inputs.a ?? 0), b) };
  },
  /**
   * Pure function. The shared node chrome plus the test as the card's readout.
   *
   * IT PRINTS THE TEST, NOT THE ANSWER, which is the same choice
   * plugins/node_math.js makes for its operator symbol: a compare node's identity is
   * what it asks, and the answer is already visible as the value on its output wire
   * and in whatever display is downstream of it. Printing `true`/`false` here would
   * also be reading `nodePorts`, and the point of the card is what the node IS.
   */
  emit(s, _target, world) {
    const ops = [
      ...nodeCard(s, "Compare"),
      ...nodeValueText(s, compareReadout(s)),
      ...portBeads(nodeComparePlugin, s),
      ...nodeRim(s),
    ];
    return applyEffects(ops, s, world, { x: 0, y: 0, w: s.w ?? 0, h: s.h ?? 0 });
  },
  commands: [{ id: "add-node-compare", title: "Add Compare Node", icon: "mdi:code-equal", run: (app) => app.armCrosshairPlacement(nodeComparePlugin) }],
  cullMargin: effectsCullMargin,
  localBounds: (state) => nodeInkBounds(nodeComparePlugin, state),
  anchors: standardBBoxAnchors,
  closestAnchor(state, wx, wy, world) {
    const local = T.apply(T.invert(world), wx, wy);
    return nodeCardRim(state, local.x, local.y);
  },
};
