/**
 * SCHMITT TRIGGER — the node the whole per-frame ask is about.
 *
 * > *"so we can have something like a schmitt trigger reading from a boolean node
 * > that on transition to high might trigger a thing"* (user, 2026-08-12)
 *
 * A NUMBER goes in a data pin; an EXEC pulse comes out on the frame its input
 * crosses the band. It is the FRAME-DOMAIN sibling of `plugins/node_on_threshold.js`
 * — two nodes, two axes, one file each, exactly as `plugins/audio_trigger.js` is the
 * audio-rate one. Which axis a widget lives on is the whole of the difference and it
 * is worth reading the three headers together.
 *
 * ── THE HYSTERESIS ARGUMENT IS DISSOLVED HERE, AND PRECISELY ────────────────
 * `plugins/node_on_threshold.js` argues that hysteresis is meaningless for IT — *"A
 * real Schmitt trigger has two thresholds and a LATCH … which is history, not the
 * two samples in hand. With exactly two samples, a 'hysteresis' knob would be a
 * control that changed almost nothing while claiming to debounce"*. That paragraph is
 * CORRECT about the slide domain and INAPPLICABLE here, and the reason is in its own
 * second clause: *"which is history"*. Since R7-9 there is a legal channel for
 * history. On the frame axis samples arrive continuously, so there is a genuine
 * stream for hysteresis to debounce, the latch is one boolean per node per step —
 * exactly what the `prev`/`cur` tables hold — and `firstStep` gives it a stated
 * initial condition rather than an implicit one. That header has been AMENDED rather
 * than deleted (it stays true where it stands).
 *
 * ── SIMULATED, AND THE COSTS ARE THE STANDARD ONES ──────────────────────────
 * Declaring `frameStep` IS declaring simulated (core/exec_frame.js), so a deck
 * containing this node is contiguous-shard-only (`core/document.stridedShardRefusal`
 * answers it through the registry, not through an equation scan), resets with
 * `resetSimulation()`, and is structurally unable to advance inside
 * `withSimulationFrozen()`. Δt = 0 still means a byte-identical frame: the latch is
 * read from `prev`, which rolls only when the clock moves, so a hover repaint cannot
 * double-fire it. That last property is the one this widget would most plausibly get
 * wrong, and it is the reason the state does not live in `computeOutputs`.
 *
 * ── THE PURE FUNCTION IS core/exec_frame.schmittStep ────────────────────────
 * Thresholds and latch in, `{fired, armed, released}` out — the caller owns the
 * storage, which is what lets it stay pure while the history table carries it. This
 * plugin is that function with `armed` threaded through the table and a `mode` row
 * deciding which edge reaches the pin.
 */

import { EXEC_NODE_CAT, execNodePlugin } from "../core/exec_nodes.js";
import { SCHMITT_HIGH, SCHMITT_LOW, schmittBandProblem, schmittStep } from "../core/exec_frame.js";
import { formatNodeValue, portIsWired } from "../core/node_chrome.js";
import { reportOnce } from "../core/report.js";

/** The three edges. Same vocabulary as plugins/node_on_threshold.js's `mode`, on
 *  purpose: the two nodes ask the same question on different axes, and an author who
 *  learns one should not have to learn a second word for the other. */
const MODES = ["rise", "fall", "both"];
const MODE_LABELS = { rise: "Rising past High", fall: "Falling past Low", both: "Either edge" };

/** THE CARD'S readout marks. One glyph, for plugins/node_on_threshold.js's measured
 *  reason: a spelled-out mode label runs past the rim of a default-width card. */
const MODE_MARKS = { rise: "↑", fall: "↓", both: "⇅" };

/** Pure function. The number this node is watching: the WIRE when one is attached,
 *  else the node's own `level` property. R7-10's knob-or-input duality, read the same
 *  way plugins/node_on_threshold.js reads it. */
const watched = (self, inputs) => (portIsWired(self, "in") ? Number(inputs?.in ?? 0) : Number(self?.level ?? 0));

export const nodeSchmittPlugin = execNodePlugin({
  type: "node_schmitt",
  title: "Schmitt Trigger",
  icon: "mdi:square-wave",
  ports: {
    inputs: [{ key: "in", type: "number", label: "in" }],
    outputs: [
      { key: "then", type: "exec", label: "Then" },
      // THE LATCH AS A READABLE NUMBER, 1 while high and 0 while low. It is the
      // node's continuous output beside its instantaneous one, and it is what makes
      // the trigger usable as a debounced BOOLEAN rather than only as an event — the
      // "reading from a boolean node" half of the ask, seen from the other end.
      { key: "state", type: "number", label: "state" },
    ],
  },
  own: { low: SCHMITT_LOW, high: SCHMITT_HIGH, level: 0, mode: "rise" },
  rows: [
    { key: "high", label: "High", kind: "number", category: EXEC_NODE_CAT, help: "The rising threshold. The input going at or above this is what fires the trigger — once, no matter how long it stays there." },
    { key: "low", label: "Low", kind: "number", category: EXEC_NODE_CAT, help: "The falling threshold, at or below High. The gap between the two is the band the input may wobble in WITHOUT re-firing, which is what stops a noisy signal machine-gunning. Set both to the same number for a plain comparator with no hysteresis — right for a 0/1 signal, where there is no noise to debounce." },
    { key: "level", label: "Level", kind: "number", category: EXEC_NODE_CAT, help: "The number to watch when nothing is wired into the 'in' socket. Wire something in and this is ignored — the wire wins. An ordinary keyframable slot, so keyframing it across slides is itself a way to make this fire." },
    { key: "mode", label: "Fires", kind: "select", options: MODES, optionLabels: MODE_LABELS, category: EXEC_NODE_CAT, help: "Which edge pulses the Then pin: crossing up past High, crossing back down past Low, or either. The 'state' output is 1 while high and 0 while low in every mode." },
  ],
  readout: (s) => `${MODE_MARKS[s.mode] ?? MODE_MARKS.rise} ${formatNodeValue(Number(s.low ?? SCHMITT_LOW))}–${formatNodeValue(Number(s.high ?? SCHMITT_HIGH))}`,
  /**
   * Pure function. The latch as a readable number, for the frames BEFORE this node
   * has stepped and for every still consumer.
   *
   * It reports 0 rather than reading the history table, and that is deliberate:
   * `computeOutputs` runs in the ordinary node evaluator, which has no business
   * advancing or even consulting a simulation step (core/exec_frame.js's whole
   * design). The LIVE value is published by `frameStep` and merged over this one, so
   * what a wire carries during a presentation is the latch and what it carries in a
   * frozen still is the resting state.
   *
   * @param {object} s - the folded item state
   * @returns {{state: number}}
   *
   * @example nodeSchmittPlugin.computeOutputs({}) // {state: 0}
   */
  computeOutputs() {
    return { state: 0 };
  },
  /**
   * ONE FRAME of the trigger — core/exec_frame.js's frame-domain contract.
   *
   * Near-pure function (its answer depends on the caller-supplied `prev`; it mutates
   * nothing). Reads the watched number, steps the latch, and fires `then` on the
   * edge this node's `mode` names.
   *
   * ── THE FIRST STEP DOES NOT FIRE, AND THAT IS THE SAME RULE ON_THRESHOLD HAS ─
   * On the first step the latch is taken from the input's CURRENT side of the band
   * rather than from `false`. Starting it at `false` would mean a chain whose input
   * is ALREADY high when the presentation opens fires on frame 1 — "already above the
   * line when the deck opened" is not a crossing, and treating it as one would pulse
   * every trigger on the title slide. plugins/node_on_threshold.js refuses the same
   * thing for the same reason (its slide-0 branch).
   *
   * @param {object} ctx - {self, inputs, prev, firstStep}
   * @returns {{state: object, fired: string[], outputs: object}}
   *
   * @example // a signal already high at t=0 latches WITHOUT firing
   * @example nodeSchmittPlugin.frameStep({self: {low: 0.1, high: 0.5, level: 0.9, mode: "rise"}, inputs: {}, firstStep: true}) // {state: {armed: true}, fired: [], outputs: {state: 1}}
   * @example // rising past High on a later step fires once
   * @example nodeSchmittPlugin.frameStep({self: {low: 0.1, high: 0.5, level: 0.9, mode: "rise"}, inputs: {}, prev: {armed: false}}) // {state: {armed: true}, fired: ["then"], outputs: {state: 1}}
   * @example // …and staying there does not fire again
   * @example nodeSchmittPlugin.frameStep({self: {low: 0.1, high: 0.5, level: 0.9, mode: "rise"}, inputs: {}, prev: {armed: true}}) // {state: {armed: true}, fired: [], outputs: {state: 1}}
   * @example // a `fall` node pulses on the way back down instead
   * @example nodeSchmittPlugin.frameStep({self: {low: 0.1, high: 0.5, level: 0, mode: "fall"}, inputs: {}, prev: {armed: true}}) // {state: {armed: false}, fired: ["then"], outputs: {state: 0}}
   */
  frameStep(ctx) {
    const low = Number(ctx.self.low ?? SCHMITT_LOW);
    const high = Number(ctx.self.high ?? SCHMITT_HIGH);
    const value = watched(ctx.self, ctx.inputs);
    // AN INVERTED BAND IS REPORTED, NOT SWAPPED. Swapping would make a control mean
    // the opposite of what it says; the node then runs on the thresholds as written,
    // which fires on every sample — visibly wrong, next to a sentence saying why.
    const problem = schmittBandProblem(low, high);
    if (problem) reportOnce(`node_schmitt:band:${ctx.id}`, `node_schmitt: ${problem}`);
    // THE FIRST STEP TAKES ITS LATCH FROM THE SIGNAL, not from `false` — see above.
    const armed = ctx.firstStep ? value >= high : !!ctx.prev?.armed;
    const step = schmittStep(value, armed, low, high);
    const mode = ctx.self.mode ?? "rise";
    const edge = mode === "both" ? step.fired || step.released : mode === "fall" ? step.released : step.fired;
    return {
      state: { armed: step.armed },
      fired: edge ? ["then"] : [],
      outputs: { state: step.armed ? 1 : 0 },
    };
  },
});
