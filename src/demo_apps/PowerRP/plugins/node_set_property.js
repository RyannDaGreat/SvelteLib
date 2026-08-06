/**
 * SET PROPERTY — the ONLY effect node, and the only way an event changes anything.
 *
 * THAT IT IS THE ONLY ONE IS THE FEATURE, not a stage the roster is at. The manifest
 * rule this whole subsystem rests on is *"require every effect to be IDEMPOTENT —
 * `set X to V`, never `add 1 to X`"*, and the way that is made STRUCTURAL rather
 * than remembered is that the vocabulary has one verb. There is no Add node, no
 * Toggle node and no Increment node to reach for, so a chain that accumulates is not
 * something an author has to be told not to write — it is something they cannot
 * spell. (Same shape as this round's audio mute placed downstream of the capture tap:
 * a rule turned into an impossible mistake.)
 *
 * ── THE VALUE IS THE WIRE, OR THE KNOB — R7-10's DUALITY ────────────────────
 * Wire a number into `value` and the wire decides; leave it unwired and the node's
 * own `value` property decides, which is an ordinary keyframable equation slot. One
 * of the two is live at a time and which one is visible on the canvas, which is what
 * the duality is for.
 *
 * ── WHAT IT CAN AND CANNOT WRITE, STATED PLAINLY ────────────────────────────
 * It writes a NUMBER to a property path on one widget. It cannot write a colour or a
 * string, and that is a consequence of the equation-slot rule rather than a choice
 * here: a property is an equation slot iff its plugin default is a NUMBER
 * (core/expressions.js), so a text-valued `value` row could not be bound, keyframed
 * or driven by a wire — it would be the only dead field on the card. A deck that
 * wants an event to change a colour keyframes the colour and has the event drive the
 * NUMBER the colour's equation reads.
 *
 * ── IT FORWARDS, SO EFFECTS CHAIN ───────────────────────────────────────────
 * `then` fires after the write, which is how a total order over several effects is
 * expressed — the thing dataflow structurally cannot do. Several effects from ONE
 * event go through a Sequence node.
 */

import { EXEC_NODE_CAT, execNodePlugin } from "../core/exec_nodes.js";
import { formatNodeValue, portIsWired } from "../core/node_chrome.js";

export const nodeSetPropertyPlugin = execNodePlugin({
  type: "node_set_property",
  title: "Set Property",
  icon: "mdi:pencil-box-outline",
  itemRefs: [["target"]],
  ports: {
    inputs: [{ key: "run", type: "exec", label: "Run" }, { key: "value", type: "number", label: "value" }],
    outputs: [{ key: "then", type: "exec", label: "Then" }],
  },
  own: { target: "", path: "", value: 0 },
  rows: [
    { key: "target", label: "Target", kind: "select", optionsFrom: "items", options: [], category: EXEC_NODE_CAT, help: "The widget this writes to. A target that is not on the slide where the event fires is simply not written — the same rule a wire to an absent source follows." },
    { key: "path", label: "Property", kind: "text", category: EXEC_NODE_CAT, help: "Which property to set, written the way an equation names it: \"x\", \"opacity\", \"rotation\". A nested one uses dots — \"origin.x\". Leave it empty and this node does nothing." },
    { key: "value", label: "Value", kind: "number", category: EXEC_NODE_CAT, help: "The number to write, used when nothing is wired into the 'value' socket. An ordinary keyframable slot: bind it with '=' to compute what the event writes. Wire the socket and the wire wins." },
  ],
  readout: (s) => (s.path ? `${s.path} → ${portIsWired(s, "value") ? "wire" : formatNodeValue(Number(s.value ?? 0))}` : "—"),
  /**
   * Pure function. THE SET PAIR this effect writes, or nothing.
   *
   * It returns pairs rather than performing a write, which is not a style choice:
   * it is the app's universal edit vocabulary (`connectPairs`, `disconnectPairs`,
   * `setPreview`), and it is what makes the effect unable to READ what it is about
   * to overwrite. An effect handed a mutable state could accumulate; an effect that
   * returns `[[path, value]]` cannot.
   *
   * @param {object} ctx - core/exec_flow.js's run context
   * @returns {Array} [[path, value]] pairs
   *
   * @example nodeSetPropertyPlugin.execEffect({self: {target: "b", path: "x", value: 42}, inputs: {}}) // [[["items", "b", "x"], 42]]
   * @example // a dotted path is split, so a nested leaf is reachable
   * @example nodeSetPropertyPlugin.execEffect({self: {target: "b", path: "origin.x", value: 7}, inputs: {}}) // [[["items", "b", "origin", "x"], 7]]
   * @example // a wired socket wins over the knob
   * @example nodeSetPropertyPlugin.execEffect({self: {target: "b", path: "x", value: 42, inputs: {value: {item: "k", port: "out"}}}, inputs: {value: 3}}) // [[["items", "b", "x"], 3]]
   * @example // nothing named, nothing written — and no error, because a half-built node is a normal state to be in
   * @example nodeSetPropertyPlugin.execEffect({self: {target: "", path: "x"}, inputs: {}}) // []
   */
  execEffect(ctx) {
    const { target, path } = ctx.self;
    if (!target || typeof path !== "string" || path === "") return [];
    const value = portIsWired(ctx.self, "value") ? Number(ctx.inputs?.value ?? 0) : Number(ctx.self.value ?? 0);
    return [[["items", target, ...path.split(".")], value]];
  },
});
