/**
 * COUNTER — "an increment widget that increments by 1 each time it's triggered"
 * (user, 2026-08-06, naming it as one of the two demos triggers are FOR).
 *
 * ── IT IS THE ONE CASE THE DESIGN SAID WAS FORBIDDEN, AND WORKING OUT WHY IT IS
 *    NOT IS THE MOST USEFUL THING IN THIS FILE ────────────────────────────────
 * The manifest's rule (R7-8) reads *"require every effect to be IDEMPOTENT — `set X
 * to V`, never `add 1 to X`"*, and core/exec_flow.js makes that STRUCTURAL: the
 * effect vocabulary has one verb and an effect is never handed a writer. A counter
 * is literally `add 1 to X`. So either the rule is wrong or this widget is.
 *
 * NEITHER. The rule's stated PURPOSE is the sentence right after it: *"Then replaying
 * from slide 0 is cheap, correct and identical every time."* Idempotence is what lets
 * you compute slide k's state WITHOUT replaying. Our implementation replays anyway —
 * that is what the slide-grid schedule buys, and it is memoized per document and
 * independent of alpha — so the purpose is already met by the schedule rather than by
 * the effect. A count is then a pure function of `(document, slideIndex)`: it is the
 * number of pulses that reached this node at boundaries ≤ k. Δt = 0 is unchanged, a
 * frame-range shard is unchanged, an export is reproducible. Every law holds.
 *
 * ── AND THE STRUCTURAL RULE IS STILL INTACT, WHICH IS THE POINT ─────────────
 * This node does not `add`. It emits `set self.count to <base + step × n>`, where
 *   `base` is its OWN count in the pass's fixed pre-write snapshot, and
 *   `n`    is `ctx.runIndex + 1` — how many times the WALK has reached it at this
 *          boundary, which the walk knows and the node cannot influence.
 * So it is an ordinary idempotent `set`, computed from two things the effect cannot
 * modify. Re-running the boundary produces the identical write. What remains
 * impossible is the thing the rule was actually protecting against: there is still no
 * node an author can point at an ARBITRARY property to accumulate it. A counter
 * accumulates exactly one leaf — its own — and publishes it.
 *
 * ── WHY `runIndex` RATHER THAN "just read the value back" ───────────────────
 * Because reading back would defeat the double buffering, and the failure would be
 * silent and intermittent: two events into one counter at the same boundary would
 * both read the same unchanged base, both write base + 1, and the count would tick
 * once for two pulses. The walk's occurrence index is the only thing at hand that
 * distinguishes them, and it is deterministic (depth-first pre-order, declaration
 * order — core/exec_flow.js's ordering section).
 *
 * ── RESETTING IS NOT A FEATURE, IT IS THE `count` PROPERTY ──────────────────
 * `count` is an ordinary stored leaf, so keyframing it to 0 on a slide resets the
 * counter there, and the equation slot means the start value can be computed. No
 * Reset pin, no reset node: the document already had the mechanism.
 */

import { EXEC_NODE_CAT, execNodePlugin } from "../core/exec_nodes.js";
import { formatNodeValue } from "../core/node_chrome.js";

export const nodeCounterPlugin = execNodePlugin({
  type: "node_counter",
  title: "Counter",
  icon: "mdi:plus-box-multiple-outline",
  ports: {
    inputs: [{ key: "run", type: "exec", label: "Run" }],
    outputs: [{ key: "out", type: "number", label: "out" }, { key: "then", type: "exec", label: "Then" }],
  },
  own: { count: 0, step: 1 },
  rows: [
    { key: "count", label: "Count", kind: "number", category: EXEC_NODE_CAT, help: "The tally so far. Events add to it; keyframing it on a slide RESETS it there, which is how a counter is restarted — there is no reset pin because the property already is one. Read it from anywhere as \"= <this node's name>.out\"." },
    { key: "step", label: "Step", kind: "number", category: EXEC_NODE_CAT, help: "How much each pulse adds. Negative counts down; 0 makes the node a pass-through that only forwards its Then." },
  ],
  readout: (s) => formatNodeValue(Number(s.count ?? 0)),
  /**
   * Pure function. The counter's published value — its tally, so anything can read
   * it as `= counter1.out` or drive a Set Property's `value` socket from it.
   *
   * @param {object} s - the folded item state
   * @returns {{out: number}}
   *
   * @example nodeCounterPlugin.computeOutputs({count: 7}) // {out: 7}
   * @example nodeCounterPlugin.computeOutputs({}) // {out: 0}
   */
  computeOutputs(s) {
    return { out: Number(s.count ?? 0) };
  },
  /**
   * Pure function. THE SET that advances the tally — see the header for why an
   * increment is expressible here without giving up idempotence.
   *
   * @param {object} ctx - core/exec_flow.js's run context (uses `runIndex`)
   * @returns {Array} one [[path, value]] pair
   *
   * @example nodeCounterPlugin.execEffect({id: "c", self: {count: 4, step: 1}, runIndex: 0}) // [[["items", "c", "count"], 5]]
   * @example // SECOND pulse at the SAME boundary: the base is still 4, so the write is 6
   * @example nodeCounterPlugin.execEffect({id: "c", self: {count: 4, step: 1}, runIndex: 1}) // [[["items", "c", "count"], 6]]
   * @example // a negative step counts down, and a 0 step writes the value it already had
   * @example nodeCounterPlugin.execEffect({id: "c", self: {count: 4, step: -2}, runIndex: 0}) // [[["items", "c", "count"], 2]]
   */
  execEffect(ctx) {
    const step = Number(ctx.self.step ?? 1);
    const base = Number(ctx.self.count ?? 0);
    return [[["items", ctx.id, "count"], base + step * ((ctx.runIndex ?? 0) + 1)]];
  },
});
