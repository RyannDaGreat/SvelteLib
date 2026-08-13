/**
 * ON THRESHOLD — the node the user's requirement names directly: *"An output
 * property, followed by a trigger property, should trigger events"*, and
 * *"[event nodes are] better than needing a schmitt-trigger (tho thats good too)"*.
 *
 * A NUMBER goes in a data pin; an EXEC pulse comes out when that number crosses a
 * line between one slide boundary and the next. That junction — value in, control
 * out — is the whole reason the node exists, and it is the only place in the app
 * where a value becomes an event.
 *
 * ── IT COMPARES TWO BOUNDARIES, NOT TWO FRAMES, AND THAT IS THE DESIGN ──────
 * The reading it needs is "was it below the line, is it above it now". The two
 * samples are the values at slide boundaries j−1 and j — both pure functions of the
 * document — so the firing set stays enumerable and alpha-independent (core/
 * exec_flow.js: THE FIRING SCHEDULE IS THE SLIDE GRID). Sampling per FRAME instead
 * would make the same node fire a different number of times at 30 fps and at 60,
 * which is the `Event Tick` defect the manifest refuses.
 *
 * So a value that rises AND falls back again WITHIN one transition does not fire.
 * That is a real boundary, not an oversight: nothing in the document says how many
 * times it wiggled on the way, because a tween is an interpolation and not a
 * recording.
 *
 * ── NO HYSTERESIS *ON THIS AXIS*, AND THE REASON IS INSTRUCTIVE ─────────────
 * A real Schmitt trigger has two thresholds and a LATCH — its output depends on
 * which threshold it last crossed, which is history, not on the two samples in hand.
 * With exactly two samples, a "hysteresis" knob would be a control that changed
 * almost nothing while claiming to debounce, which is worse than not having it.
 *
 * ── AMENDED 2026-08-13: THAT ARGUMENT IS SCOPED TO THE SLIDE DOMAIN ─────────
 * It used to be stated without the scope, and read as a claim about the app. It is
 * not: the load-bearing clause is its own *"which is history"*, and since R7-9 there
 * IS a legal channel for history (SIMULATED state, core/simulation_history.js). On a
 * PER-FRAME axis samples arrive continuously, so there is a genuine stream for
 * hysteresis to debounce and the latch is one boolean per node per step — which is
 * exactly what the `prev`/`cur` tables hold.
 *
 * So the paragraph above STAYS TRUE WHERE IT STANDS, about THIS widget, and the
 * frame-domain Schmitt trigger is a different widget on a different axis:
 * `plugins/node_schmitt.js`, whose header carries the other half of this reasoning.
 * The audio-rate one is a third, where its input is continuous by construction:
 * `plugins/audio_trigger.js`. Three axes, three files, one idea.
 */

import { EXEC_NODE_CAT, execNodePlugin } from "../core/exec_nodes.js";
import { portIsWired } from "../core/node_chrome.js";
import { formatNodeValue } from "../core/node_chrome.js";

/** The two edges, plus the "any crossing" convenience. */
const MODES = ["rise", "fall", "both"];
const MODE_LABELS = { rise: "Rising past", fall: "Falling past", both: "Crossing" };

/** THE CARD'S readout, which is not the dropdown's label. `nodeValueText` shrinks a
 *  line against the card's HEIGHT but never its WIDTH, so "Rising past 0.5" runs
 *  past the rim of a default-width card — measured on a rendered still, the same way
 *  plugins/node_on_reveal.js found it. An arrow says the direction in one glyph. */
const MODE_MARKS = { rise: "\u2191", fall: "\u2193", both: "\u21c5" };

/** Pure function. The number this node is watching in one boundary's inputs: the
 *  WIRE when one is attached, else the node's own `level` property. This is R7-10's
 *  knob-or-input duality read at evaluation time — one source of truth, chosen by
 *  whether the socket is occupied. */
const watched = (self, inputs) => (portIsWired(self, "in") ? Number(inputs?.in ?? 0) : Number(self?.level ?? 0));

export const nodeOnThresholdPlugin = execNodePlugin({
  type: "node_on_threshold",
  title: "On Threshold",
  icon: "mdi:sine-wave",
  ports: {
    inputs: [{ key: "in", type: "number", label: "in" }],
    outputs: [{ key: "then", type: "exec", label: "Then" }],
  },
  own: { threshold: 0.5, level: 0, mode: "rise" },
  rows: [
    { key: "threshold", label: "Threshold", kind: "number", category: EXEC_NODE_CAT, help: "The line the watched number has to cross for this to fire. Compared at slide boundaries: the value on the previous slide against the value on this one." },
    { key: "level", label: "Level", kind: "number", category: EXEC_NODE_CAT, help: "The number to watch when nothing is wired into the 'in' socket. Wire something in and this is ignored — the wire wins. It is an ordinary keyframable slot, so keyframing it across slides is itself a way to make this fire." },
    { key: "mode", label: "Fires", kind: "select", options: MODES, optionLabels: MODE_LABELS, category: EXEC_NODE_CAT, help: "Which crossing fires the chain: upward through the threshold, downward through it, or either." },
  ],
  readout: (s) => `${MODE_MARKS[s.mode] ?? MODE_MARKS.rise} ${formatNodeValue(Number(s.threshold ?? 0))}`,
  /**
   * Pure function. Did the watched number cross the threshold in the listened-for
   * direction between the previous boundary and this one?
   *
   * At slide 0 there is no previous boundary, so nothing has crossed anything and
   * nothing fires. That differs from On Reveal on purpose: appearing IS an edge,
   * whereas "already above the line when the deck opened" is not a crossing, and
   * treating it as one would fire every threshold node on the title slide.
   *
   * @param {object} ctx - core/exec_flow.js's run context
   * @returns {boolean}
   *
   * @example // 0.2 → 0.8 past a 0.5 line, rising:
   * @example nodeOnThresholdPlugin.execEvent({self: {threshold: 0.5, level: 0.8, mode: "rise"}, inputs: {}, prevInputs: {}, prevSelf: {threshold: 0.5, level: 0.2, mode: "rise"}}) // true
   * @example // the same pair read by a `fall` node does not fire
   * @example nodeOnThresholdPlugin.execEvent({self: {threshold: 0.5, level: 0.8, mode: "fall"}, inputs: {}, prevInputs: {}, prevSelf: {threshold: 0.5, level: 0.2, mode: "fall"}}) // false
   * @example // staying above the line is not a crossing
   * @example nodeOnThresholdPlugin.execEvent({self: {threshold: 0.5, level: 0.9, mode: "rise"}, inputs: {}, prevInputs: {}, prevSelf: {threshold: 0.5, level: 0.8, mode: "rise"}}) // false
   * @example // and slide 0 has nothing to compare against
   * @example nodeOnThresholdPlugin.execEvent({self: {threshold: 0.5, level: 0.9, mode: "rise"}, inputs: {}, prevInputs: {}, prevSelf: null}) // false
   */
  execEvent(ctx) {
    if (!ctx.prevSelf) return false;
    const line = Number(ctx.self.threshold ?? 0);
    const now = watched(ctx.self, ctx.inputs);
    const before = watched(ctx.prevSelf, ctx.prevInputs);
    const rose = before < line && now >= line;
    const fell = before >= line && now < line;
    return ctx.self.mode === "both" ? rose || fell : ctx.self.mode === "fall" ? fell : rose;
  },
});
