/**
 * GATE — the branch. One of the two things dataflow structurally cannot express.
 *
 * The manifest's argument for exec being a separate wire kind at all is that
 * *"dataflow cannot express 'do A then B when neither reads the other', cannot
 * express zero occurrences, and cannot branch"*. Sequence answers the first. This
 * answers the other two: `Then` or `Else`, and an unwired arm means the chain simply
 * does not happen — zero occurrences, spelled by leaving a socket empty.
 *
 * ── ITS CONDITION IS A NUMBER, NOT A BOOLEAN, AND DELIBERATELY ──────────────
 * A wire carries a number, and there is no boolean port type — the type table's
 * `trigger` already coerces to 1/0 (core/nodeflow.js COERCIONS), so `> 0` is the one
 * reading every existing port type already agrees on. Adding a boolean type for one
 * node's convenience would put a fifth entry in a table whose entries are supposed to
 * be VALUE KINDS that flow down wires.
 */

import { EXEC_NODE_CAT, execNodePlugin } from "../core/exec_nodes.js";
import { formatNodeValue, portIsWired } from "../core/node_chrome.js";

/** Pure function. The condition in force: the wire if one is attached, else the
 *  node's own knob. R7-10's duality, read the same way plugins/node_set_property.js
 *  reads its value. */
const condition = (self, inputs) => (portIsWired(self, "if") ? Number(inputs?.if ?? 0) : Number(self?.condition ?? 0));

export const nodeGatePlugin = execNodePlugin({
  type: "node_gate",
  title: "Gate",
  icon: "mdi:call-split",
  ports: {
    inputs: [{ key: "run", type: "exec", label: "Run" }, { key: "if", type: "number", label: "if" }],
    outputs: [{ key: "then", type: "exec", label: "Then" }, { key: "else", type: "exec", label: "Else" }],
  },
  own: { condition: 1 },
  rows: [
    { key: "condition", label: "Condition", kind: "number", category: EXEC_NODE_CAT, help: "Which way the chain goes: above zero takes Then, zero or below takes Else. Used when nothing is wired into the 'if' socket — wire it and the wire wins. An ordinary keyframable slot, so '=' can compute the branch." },
  ],
  readout: (s) => (portIsWired(s, "if") ? "if wire > 0" : `if ${formatNodeValue(Number(s.condition ?? 0))} > 0`),
  /**
   * Pure function. THE ONE arm this gate takes — the override of core/exec_flow.js's
   * "every exec output, in order" default, and the whole of what makes this a branch
   * rather than a two-output Sequence.
   *
   * It always names exactly one pin, even when that pin is unwired: choosing a dead
   * end is a real outcome (zero occurrences), and returning nothing would make an
   * unwired Else indistinguishable from a gate that had not decided.
   *
   * @param {object} ctx - core/exec_flow.js's run context
   * @returns {string[]} exactly one exec output key
   *
   * @example nodeGatePlugin.execNext({self: {condition: 1}, inputs: {}}) // ["then"]
   * @example nodeGatePlugin.execNext({self: {condition: 0}, inputs: {}}) // ["else"]
   * @example // a wired socket decides instead of the knob
   * @example nodeGatePlugin.execNext({self: {condition: 1, inputs: {if: {item: "k", port: "out"}}}, inputs: {if: -3}}) // ["else"]
   */
  execNext(ctx) {
    return [condition(ctx.self, ctx.inputs) > 0 ? "then" : "else"];
  },
});
