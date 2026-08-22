/**
 * SET VAR — the sample-and-hold. A pulse on `run` LATCHES whatever is on its `value`
 * socket, and it publishes that number until the next pulse changes it.
 *
 * > *"…a node that hooks into a set global var node, that sets the var to a value
 * > upon triggering"* (user, 2026-08-12)
 *
 * ── IT PUBLISHES; IT DOES NOT WRITE THE DOCUMENT, AND HERE IS WHY ───────────
 * The name in the ask is "set global var", and the literal reading — write
 * `vars.<name>` on every pulse — is the one thing the frame domain must not do. A
 * document variable is PROPERTY STATE: it folds from the slide deltas, it is saved,
 * it is undoable. A node writing one sixty times a second would make an authored
 * deck's SAVED BYTES depend on how long it had been played, and its undo history a
 * transcript of a presentation. `core/exec_flow.js`'s slide-domain effects can write
 * the document precisely because their firing positions are FINITE AND ENUMERABLE;
 * frames are not that set.
 *
 * So this node is the same IDEA with a lawful home: the latched value lives in the
 * simulation table (SIMULATED state, core/exec_frame.js) and is published on an
 * output port. Everything an author wanted a variable for still works —
 * `= <this node's name>.out` reads it from ANY equation on the slide
 * (core/output_properties.js: an output property is read through the ordinary
 * property resolver, so it needs no new grammar), and a wire carries it to any node.
 * WHAT IS GENUINELY DIFFERENT, stated rather than glossed: this value is not saved
 * and does not survive a reload, exactly as `= @ + dt` does not. A number that must
 * be saved is a document variable set by hand or by a SLIDE-domain Set Property
 * node, which is the right tool for that job and remains available.
 *
 * ── WHY A SAMPLE-AND-HOLD IS THE USEFUL NODE, NOT A PASS-THROUGH ────────────
 * Without the latch this would be a wire: `value` in, `value` out, and the `run` pin
 * decorative. The latch is what makes it mean something — the output changes ONLY on
 * a pulse, so a continuously-varying input becomes a staircase that steps when the
 * trigger says so. In the user's demo that is the difference between a display that
 * blurs through every intermediate number and one that ticks once every two seconds.
 */

import { EXEC_NODE_CAT, execNodePlugin } from "../core/exec_nodes.js";
import { formatNodeValue, portIsWired } from "../core/node_chrome.js";

export const nodeSetVarPlugin = execNodePlugin({
  type: "node_set_var",
  title: "Set Var",
  icon: "mdi:content-save-outline",
  ports: {
    inputs: [
      { key: "run", type: "exec", label: "Run" },
      { key: "value", type: "number", label: "value" },
    ],
    outputs: [
      { key: "out", type: "number", label: "out" },
      { key: "then", type: "exec", label: "Then" },
    ],
  },
  own: { value: 0, initial: 0 },
  rows: [
    { key: "value", label: "Value", kind: "number", category: EXEC_NODE_CAT, help: "The number to latch, used when nothing is wired into the 'value' socket. Wire the socket and the wire wins — R7-10's knob-or-input duality, the same rule Set Property follows." },
    { key: "initial", label: "Initial", kind: "number", category: EXEC_NODE_CAT, help: "What this holds before the first pulse, and what it returns to when the presentation restarts. The latched value is not saved with the document — read it live as \"= <this node's name>.out\"." },
  ],
  readout: (s) => (portIsWired(s, "value") ? "⇥ wire" : `⇥ ${formatNodeValue(Number(s.value ?? 0))}`),
  /**
   * Pure function. The resting published value — the `initial`, for every still
   * consumer and for the frames before this node has stepped. The LIVE latch is
   * published by `frameStep` and merged over this (plugins/node_schmitt.js's rule).
   *
   * @param {object} s - the folded item state
   * @returns {{out: number}}
   *
   * @example nodeSetVarPlugin.computeOutputs({initial: 7}) // {out: 7}
   * @example nodeSetVarPlugin.computeOutputs({}) // {out: 0}
   */
  computeOutputs(s) {
    return { out: Number(s.initial ?? 0) };
  },
  /**
   * ONE FRAME of the sample-and-hold — core/exec_frame.js's frame-domain contract.
   *
   * Near-pure function (its answer depends on the caller-supplied `prev`; it mutates
   * nothing). Latches on a pulse, holds otherwise, and forwards `then` on the frame
   * it latched so an effect can be chained behind it.
   *
   * @param {object} ctx - {self, inputs, prev, entered}
   * @returns {{state: object, fired: boolean, outputs: object}}
   *
   * @example // no pulse: it HOLDS, and the moving input does not reach the output
   * @example nodeSetVarPlugin.frameStep({self: {initial: 0, value: 9}, inputs: {}, prev: {held: 3}}) // {state: {held: 3}, fired: false, outputs: {out: 3}}
   * @example // a pulse latches the knob and forwards
   * @example nodeSetVarPlugin.frameStep({self: {initial: 0, value: 9}, inputs: {}, prev: {held: 3}, entered: "run"}) // {state: {held: 9}, fired: true, outputs: {out: 9}}
   * @example // a WIRED value socket wins over the knob
   * @example nodeSetVarPlugin.frameStep({self: {initial: 0, value: 9, inputs: {value: {item: "c", port: "out"}}}, inputs: {value: 42}, prev: {held: 3}, entered: "run"}) // {state: {held: 42}, fired: true, outputs: {out: 42}}
   * @example // before the first pulse it holds its `initial`
   * @example nodeSetVarPlugin.frameStep({self: {initial: 5, value: 9}, inputs: {}, firstStep: true}) // {state: {held: 5}, fired: false, outputs: {out: 5}}
   */
  frameStep(ctx) {
    const incoming = portIsWired(ctx.self, "value") ? Number(ctx.inputs?.value ?? 0) : Number(ctx.self.value ?? 0);
    const resting = ctx.prev && Number.isFinite(ctx.prev.held) ? ctx.prev.held : Number(ctx.self.initial ?? 0);
    const held = ctx.entered ? incoming : resting;
    return { state: { held }, fired: !!ctx.entered, outputs: { out: held } };
  },
});
