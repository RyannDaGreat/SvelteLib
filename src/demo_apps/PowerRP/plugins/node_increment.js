/**
 * INCREMENT — the `++` node. It owns a tally, and a pulse on its `run` pin advances
 * it by one step.
 *
 * > *"…that sets the var to a value upon triggering, which in this case is that var
 * > node's read output connected to a ++ node, so it increments once every 2
 * > seconds"* (user, 2026-08-12)
 *
 * ── THE COUNTER OWNS ITS STATE; THE VARIABLE IS A PUBLICATION ───────────────
 * Read literally, the sketch above is a CYCLE: the variable feeds `++`, `++` feeds
 * the setter, the setter writes the variable. That reading is the one this design
 * deliberately does not take, and `refs/blueprints_control_flow_research.md` §6.2
 * works both through:
 *
 *   (A) THE VARIABLE IS THE STORAGE, and the cycle is broken by a one-frame delay.
 *       `connectionRefusal` refuses that at connect time, and it would also write the
 *       document once every two seconds — so an authored deck's SAVED BYTES would
 *       depend on how long it had been played.
 *   (B) THE COUNTER IS THE STORAGE and the variable is a PUBLICATION of it. No
 *       cycle, no read-modify-write, and the tally is directly wirable to a display
 *       without going through the variable at all.
 *
 * (B) is what shipped, and it is `plugins/node_counter.js`'s own argument — *"A
 * counter accumulates exactly one leaf — its own — and publishes it"* — transplanted
 * from the slide axis to the frame axis. Worth flagging as the ONE place the user's
 * sketch and the architecture disagree: the wire from the variable back into `++` is
 * unnecessary, and a deck that still wants a variable wires `increment.out` into a
 * Set Var node's `value`.
 *
 * ── IT IS NOT plugins/node_counter.js, AND BOTH SHOULD EXIST ────────────────
 * The Counter is the SLIDE-domain accumulator: its tally is a document leaf, written
 * by an idempotent `set` computed from `ctx.runIndex`, and a pure function of
 * `(document, slideIndex)`. This one is the FRAME-domain accumulator: its tally lives
 * in the simulation table, is NOT saved, and resets with `resetSimulation()`. Same
 * word, two axes, two costs — and picking the wrong one is the difference between a
 * count that survives a save and a count that survives sixty pulses a second.
 *
 * ── WHY THE TALLY IS NOT A DOCUMENT WRITE ──────────────────────────────────
 * `core/exec_flow.js`'s effect vocabulary has ONE verb and no writer, so accumulation
 * is structurally inexpressible there — and that rule is INTACT. This node does not
 * reach for an `add` effect; its output port is a SIMULATED value, the same thing
 * `= @ + dt` is, reached through a card instead of through a typed equation. There is
 * still no node an author can point at an ARBITRARY property to accumulate it.
 */

import { EXEC_NODE_CAT, execNodePlugin } from "../core/exec_nodes.js";
import { formatNodeValue } from "../core/node_chrome.js";

export const nodeIncrementPlugin = execNodePlugin({
  type: "node_increment",
  title: "Increment",
  icon: "mdi:plus-box-outline",
  ports: {
    inputs: [
      { key: "run", type: "exec", label: "Run" },
      // RESET IS AN EXEC IN, NOT A PROPERTY, because a reset is a MOMENT and this
      // node's tally is not document state for a keyframe to overwrite. That is the
      // one place it must differ from plugins/node_counter.js, whose `count` IS a
      // stored leaf and whose header therefore says (correctly, for it) "there is no
      // reset pin because the property already is one".
      { key: "reset", type: "exec", label: "Reset" },
    ],
    outputs: [
      { key: "out", type: "number", label: "out" },
      { key: "then", type: "exec", label: "Then" },
    ],
  },
  own: { start: 0, step: 1 },
  rows: [
    { key: "start", label: "Start", kind: "number", category: EXEC_NODE_CAT, help: "The tally's value before the first pulse, and what a Reset pulse returns it to. An ordinary keyframable slot, so it can be computed." },
    { key: "step", label: "Step", kind: "number", category: EXEC_NODE_CAT, help: "How much each pulse adds. Negative counts down; 0 makes this a pass-through that only forwards its Then." },
  ],
  readout: (s) => `+${formatNodeValue(Number(s.step ?? 1))}`,
  /**
   * Pure function. The tally's resting value — its `start`, for every still consumer
   * and for the frames before this node has stepped.
   *
   * The LIVE tally is published by `frameStep` and merged over this, exactly as
   * plugins/node_schmitt.js's latch is: `computeOutputs` runs in the ordinary node
   * evaluator, which must not consult a simulation step.
   *
   * @param {object} s - the folded item state
   * @returns {{out: number}}
   *
   * @example nodeIncrementPlugin.computeOutputs({start: 5}) // {out: 5}
   * @example nodeIncrementPlugin.computeOutputs({}) // {out: 0}
   */
  computeOutputs(s) {
    return { out: Number(s.start ?? 0) };
  },
  /**
   * ONE FRAME of the counter — core/exec_frame.js's frame-domain contract.
   *
   * Near-pure function (its answer depends on the caller-supplied `prev`; it mutates
   * nothing). This node is a SINK for pulses rather than a source of them, so it
   * advances only when `core/exec_frame.stepFrameDomain`'s chain walk reaches it —
   * which is what `ctx.entered` reports.
   *
   * ── ONE ADVANCE PER FRAME, NOT ONE PER PULSE, AND THAT IS THE HONEST ANSWER ─
   * The slide domain distinguishes two pulses at one boundary through `ctx.runIndex`,
   * because a boundary is instantaneous and two events genuinely both happened. A
   * FRAME is not instantaneous — it covers `dt` seconds — and the chain walk visits
   * each node once per frame on purpose (`entered`), so two triggers firing into one
   * counter on one frame advance it once. That is the reading a per-frame counter
   * wants: the alternative makes a tally depend on how many upstream branches
   * happened to converge, which is a graph-shape fact rather than a timing one.
   *
   * @param {object} ctx - {self, prev, entered}
   * @returns {{state: object, fired: boolean, outputs: object}}
   *
   * @example // no pulse this frame: the tally holds, and nothing is forwarded
   * @example nodeIncrementPlugin.frameStep({self: {start: 0, step: 1}, prev: {count: 3}}) // {state: {count: 3}, fired: false, outputs: {out: 3}}
   * @example // a pulse advances it by one step and forwards Then
   * @example nodeIncrementPlugin.frameStep({self: {start: 0, step: 1}, prev: {count: 3}, entered: "run"}) // {state: {count: 4}, fired: true, outputs: {out: 4}}
   * @example // the FIRST pulse counts from `start`, so a start of 10 publishes 11
   * @example nodeIncrementPlugin.frameStep({self: {start: 10, step: 1}, firstStep: true, entered: "run"}) // {state: {count: 11}, fired: true, outputs: {out: 11}}
   * @example // Reset returns it to `start` and forwards, so a chain can react to it
   * @example nodeIncrementPlugin.frameStep({self: {start: 0, step: 1}, prev: {count: 9}, entered: "reset"}) // {state: {count: 0}, fired: true, outputs: {out: 0}}
   */
  frameStep(ctx) {
    const start = Number(ctx.self.start ?? 0);
    const step = Number(ctx.self.step ?? 1);
    const held = ctx.prev && Number.isFinite(ctx.prev.count) ? ctx.prev.count : start;
    const count = ctx.entered === "reset" ? start : ctx.entered ? held + step : held;
    return { state: { count }, fired: !!ctx.entered, outputs: { out: count } };
  },
});
