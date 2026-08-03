/**
 * MATH node — two `number` inputs, one operation, one `number` output. The middle
 * of the proof trio: it is where a value actually FLOWS THROUGH a node rather than
 * originating or terminating in one.
 *
 * ── WHY THE OPERATION IS A SELECT AND NOT FOUR WIDGET TYPES ──────────────────
 * `add`/`subtract`/`multiply`/`divide` share one shape, one port list and one
 * chrome; they differ by one symbol. Four types would mean four Inspector
 * declarations, four entries in the insert menu and four things to keep in sync,
 * and — worse — changing your mind about an operation would mean DELETING a node
 * and rewiring both its inputs. As a select, it is one keyframable leaf: an
 * operation can even CHANGE ACROSS SLIDES (discretely, like every non-number), so
 * a patch can switch from summing to scaling mid-deck.
 *
 * ── AN UNCONNECTED INPUT IS NOT AN ERROR ────────────────────────────────────
 * core/nodeflow.evaluateNodeGraph hands every declared input its type's ZERO when
 * nothing is wired to it, so this node always computes. That is deliberate: a
 * half-built patch must still render a picture, because the picture is how you see
 * what you are building. `a + 0` is the honest answer for a half-wired adder.
 *
 * Division by zero produces Infinity rather than throwing — it is a real IEEE
 * value, the readout names it "∞" (core/node_chrome.formatNodeValue), and refusing
 * it would mean a node that crashes a slide because a knob passed through zero
 * mid-tween.
 */

import { EPHEMERAL } from "../core/ephemeral.js";
import { standardBBoxAnchors } from "../core/derive.js";
import { bundle, bundleNestedDefaults, props } from "../core/properties.js";
import { NODE_ITEM_REFS, minimumNodeHeight } from "../core/nodeflow.js";
import { formatNodeValue, nodeCard, nodeRim, nodeValueText, portBeads } from "../core/node_chrome.js";
import { applyEffects, effectsCullMargin } from "../render_gpu/effects.js";
import * as T from "../core/transform.js";

const DEFAULT_W = 150;
const CAT = "node";

const PORTS = {
  inputs: [{ key: "a", type: "number", label: "a" }, { key: "b", type: "number", label: "b" }],
  outputs: [{ key: "out", type: "number", label: "out" }],
};

/**
 * THE OPERATIONS. One table: the key stored in state, the human label, the symbol
 * shown on the card, and the pure function. Adding an operation is one entry — the
 * Inspector's options, the readout symbol and the arithmetic all come from here, so
 * they cannot disagree.
 */
export const MATH_OPS = Object.freeze({
  add: Object.freeze({ label: "Add", symbol: "+", apply: (a, b) => a + b }),
  subtract: Object.freeze({ label: "Subtract", symbol: "−", apply: (a, b) => a - b }),
  multiply: Object.freeze({ label: "Multiply", symbol: "×", apply: (a, b) => a * b }),
  divide: Object.freeze({ label: "Divide", symbol: "÷", apply: (a, b) => a / b }),
});

const OP_KEYS = Object.keys(MATH_OPS);
const OP_LABELS = Object.fromEntries(OP_KEYS.map((k) => [k, MATH_OPS[k].label]));
const DEFAULT_OP = "add";

/**
 * Pure function. Applies a math operation by key. An UNKNOWN key (a document
 * written by a newer version, or a hand-edit) falls back to the default operation
 * and is NOT silent about it in the picture: `mathSymbol` returns "?" for the same
 * key, so the node visibly shows it does not recognise its own operation instead of
 * quietly adding.
 *
 * @param {string} op - a MATH_OPS key
 * @param {number} a - the first operand
 * @param {number} b - the second operand
 * @returns {number}
 *
 * @example applyMathOp("add", 2, 3) // 5
 * @example applyMathOp("multiply", 3, 2) // 6
 * @example applyMathOp("subtract", 2, 3) // -1
 * @example applyMathOp("divide", 3, 2) // 1.5
 * @example applyMathOp("divide", 1, 0) // Infinity
 * @example applyMathOp("nonsense", 2, 3) // 5 (unknown op falls back; the card shows "?")
 */
export function applyMathOp(op, a, b) {
  return (MATH_OPS[op] ?? MATH_OPS[DEFAULT_OP]).apply(a, b);
}

/**
 * Pure function. The symbol a math node shows on its card for an operation key.
 * "?" for an unknown key — see applyMathOp for why that visibility matters.
 *
 * @param {string} op - a MATH_OPS key
 * @returns {string}
 *
 * @example mathSymbol("multiply") // "×"
 * @example mathSymbol("add") // "+"
 * @example mathSymbol("nonsense") // "?"
 */
export function mathSymbol(op) {
  return MATH_OPS[op]?.symbol ?? "?";
}

export const nodeMathPlugin = {
  type: "node_math",
  ephemeral: EPHEMERAL.NONE,
  title: "Math Node",
  capabilities: { bbox: true, transform: true, resizable: true, backdrop: false },
  itemRefs: NODE_ITEM_REFS,
  defaults: {
    type: "node_math", x: 300, y: 100, w: DEFAULT_W,
    h: minimumNodeHeight({ ports: () => PORTS }, {}),
    z: 0, rotation: 0, scale: 1,
    rotationAnchor: { x: "self.anchors.center.x", y: "self.anchors.center.y" },
    op: DEFAULT_OP,
    ...bundleNestedDefaults("effects"),
  },
  inspector: [
    ...bundle("transform"),
    { key: "op", label: "Operation", kind: "select", options: OP_KEYS, optionLabels: OP_LABELS, category: CAT, help: "What this node does with its two inputs. An ordinary keyframable leaf, so a patch can switch operation between slides (discretely, like every non-numeric value). An input with nothing wired to it reads as 0." },
    ...props("opacity"),
    ...bundle("effects"),
  ],
  ports: () => PORTS,
  /**
   * Pure function. The node protocol's compute step: `a <op> b`.
   *
   * @param {object} s - the folded item state (its `op`)
   * @param {object} inputs - every declared input, unconnected ones already zeroed
   * @returns {{out: number}}
   *
   * @example nodeMathPlugin.computeOutputs({op: "multiply"}, {a: 3, b: 2}) // {out: 6}
   * @example nodeMathPlugin.computeOutputs({op: "add"}, {a: 3, b: 0}) // {out: 3}
   */
  computeOutputs(s, inputs) {
    return { out: applyMathOp(s.op ?? DEFAULT_OP, Number(inputs.a ?? 0), Number(inputs.b ?? 0)) };
  },
  /**
   * Pure function. The shared node chrome plus a large OPERATION SYMBOL as the
   * card's readout — a math node's identity is its operator, so the operator is
   * what belongs in the body where other nodes show a number. The live result is
   * already visible: it is on the wire, and on whatever the wire feeds.
   *
   * @param {object} s - the folded item state
   * @param {*} _target - unused (bbox widget)
   * @param {object} world - the world transform (effects halo mapping)
   * @returns {object[]} display-list commands
   */
  emit(s, _target, world) {
    const ops = [
      ...nodeCard(s, "Math"),
      ...nodeValueText(s, mathSymbol(s.op ?? DEFAULT_OP)),
      ...portBeads(nodeMathPlugin, s),
      ...nodeRim(s),
    ];
    return applyEffects(ops, s, world, { x: 0, y: 0, w: s.w ?? 0, h: s.h ?? 0 });
  },
  cullMargin: effectsCullMargin,
  anchors: standardBBoxAnchors,
  closestAnchor(state, wx, wy, world) {
    const local = T.apply(T.invert(world), wx, wy);
    return { x: Math.max(0, Math.min(state.w ?? 0, local.x)), y: Math.max(0, Math.min(state.h ?? 0, local.y)) };
  },
};

/** The formatted result a math node's inputs produce — exported for the display
 *  node's own readout path and for tests, so "what this node computes" has ONE
 *  spelling that is not buried in emit(). */
export function mathReadout(s, inputs) {
  return formatNodeValue(applyMathOp(s.op ?? DEFAULT_OP, Number(inputs?.a ?? 0), Number(inputs?.b ?? 0)));
}
