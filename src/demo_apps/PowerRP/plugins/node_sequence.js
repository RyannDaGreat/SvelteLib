/**
 * SEQUENCE — fire several things, in a stated order, from one pulse.
 *
 * ── IT IS THE PROOF THAT `exec OUT ≤ 1` IS A GOOD RULE, NOT A LIMITATION ────
 * An exec output fires exactly one thing (core/nodeflow.js's EXEC WIRES: the
 * cardinality mirror). That is what makes "what happens next" a single, readable
 * answer instead of an unordered set — and Unreal's own failure is the counterexample
 * the manifest names, since its Event Dispatcher multicast order is undefined and
 * must not be inherited. When an author genuinely wants three things, they say so,
 * and the saying IS the order.
 *
 * ── IT NEEDS NO CODE, WHICH IS THE POINT OF THE DEFAULT `execNext` ──────────
 * core/exec_flow.js fires every declared exec output in DECLARATION order unless a
 * plugin overrides `execNext`. So this widget is nothing but a port declaration that
 * varies with a `count` property: the sequencing is the default semantics, not a
 * behaviour this file implements. A second copy of the ordering logic here is exactly
 * the duplication that would let the two drift.
 */

import { EXEC_NODE_CAT, execNodePlugin } from "../core/exec_nodes.js";

/** How many outputs a fresh Sequence is born with. Two is the smallest count that
 *  MEANS anything (one is a plain forward, which needs no node), and three is where
 *  a "do this, then this, then this" reads without immediately needing a resize. */
const DEFAULT_COUNT = 3;

/** The widest fan a single card stays legible at. Beyond this the port column
 *  reflows into a wall of identical beads and a second Sequence is clearer than a
 *  taller one — the same judgement core/nodeflow.portPitchFor makes about a squeeze
 *  that has stopped buying anything. */
const MAX_COUNT = 12;

export const nodeSequencePlugin = execNodePlugin({
  type: "node_sequence",
  title: "Sequence",
  icon: "mdi:format-list-numbered",
  /**
   * Pure function. One exec input, and `count` exec outputs numbered from 1.
   *
   * A FUNCTION OF STATE, which is the contract core/nodeflow.declaredPorts states
   * and the reason a mixer does not need one widget type per channel count.
   *
   * @param {object} s - the folded item state
   * @returns {object} a port declaration
   *
   * @example nodeSequencePlugin.ports({count: 2}).outputs.map((p) => p.key) // ["then_1", "then_2"]
   * @example nodeSequencePlugin.ports({}).outputs.length // 3 (the default count)
   * @example nodeSequencePlugin.ports({count: 99}).outputs.length // 12 (clamped to MAX_COUNT)
   */
  ports: (s) => {
    const count = Math.max(1, Math.min(MAX_COUNT, Math.round(Number(s?.count ?? DEFAULT_COUNT)) || DEFAULT_COUNT));
    return {
      inputs: [{ key: "run", type: "exec", label: "Run" }],
      outputs: Array.from({ length: count }, (_, i) => ({ key: `then_${i + 1}`, type: "exec", label: `Then ${i + 1}` })),
    };
  },
  own: { count: DEFAULT_COUNT },
  rows: [
    { key: "count", label: "Outputs", kind: "number", category: EXEC_NODE_CAT, help: `How many things this fires, in order: output 1's whole chain runs to completion before output 2 starts. Up to ${MAX_COUNT}; past that a second Sequence reads better than a taller card. An output with nothing wired to it is simply skipped.` },
  ],
  readout: (s) => `1 … ${Math.max(1, Math.min(MAX_COUNT, Math.round(Number(s?.count ?? DEFAULT_COUNT)) || DEFAULT_COUNT))}`,
});
