/**
 * KNOB node — a dial you turn, whose value goes out on a `number` port.
 *
 * ── THE ASK (user, 2026-08-03, verbatim) ────────────────────────────────────
 * "I'll also like to have a knob node, for example. … I need to be able to play
 * with them myself."
 *
 * ── IT IS ONE BIG KNOB, AND THE GESTURE IS ALREADY BUILT ────────────────────
 * A module's knobs are a BAND of small dials in its body (core/node_knobs.js);
 * this widget is a single large dial that IS the widget. But it declares the
 * same `knobLayout` contract, so it inherits the whole landed knob-focus
 * machinery — double-click to enter, drag up for more, Shift for fine control,
 * one release = one undo unit, a bound (equation) value refused rather than
 * overwritten — with no new gesture code anywhere. That reuse is the reason the
 * layout record grew a `stateKey`: this widget's leaf is a plain `value`, and
 * the mode used to derive `audioValue` by prefixing.
 *
 * ── THE VALUE IS ORDINARY PROPERTY STATE ────────────────────────────────────
 * `value` is a plain numeric leaf, so it is an equation slot for free, keyframable
 * for free, and tweens across slides for free (the same argument
 * plugins/node_number.js makes). A knob keyframed 0.2 → 0.9 sweeps whatever it
 * drives across the transition, and that sweep RENDERS IN AN EXPORT because it is
 * document state. Playing the knob live in the editor writes that same leaf. See
 * core/control_nodes.js for where the live/stored boundary actually falls.
 */

import { controlDefaults, controlNodePlugin, controlRangeRows, controlValue, CONTROL_FAMILY } from "../core/control_nodes.js";
import { familyCard, familyRim, formatNodeValue, knobOps, nodeFamily, nodeValueText, portBeads, NODE_HEADER_H } from "../core/node_chrome.js";
import { knobFraction } from "../core/node_knobs.js";

const DEFAULT_W = 104;
const DEFAULT_H = 108;
const DEFAULT_VALUE = 0.5;
const DEFAULT_MIN = 0;
const DEFAULT_MAX = 1;

/** The big dial's radius, and where its centre sits below the header. Sized to
 *  the card rather than to core/node_knobs.KNOB_R, which is the SMALL dial a
 *  module wears several of — this is one control filling its own widget. */
const DIAL_R = 26;
const DIAL_CY_GAP = 12;
/** How far above the card's bottom rim the value readout's baseline sits. */
const READOUT_BASELINE_GAP = 10;

const PORTS = { inputs: [], outputs: [{ key: "out", type: "number", label: "out" }] };

/** Pure function. This knob's range, defaulted and ordered.
 *
 *  A max BELOW the min is not refused — it is CLAMPED to the min, which makes
 *  the dial a constant rather than an error. An inverted range is reachable by
 *  keyframing max below min mid-tween, and a throw on the render path would kill
 *  the frame for a state the author will pass through in half a second.
 *
 *  @example knobRange({}) // {min: 0, max: 1}
 *  @example knobRange({min: 20, max: 20000}) // {min: 20, max: 20000}
 *  @example knobRange({min: 5, max: 1}) // {min: 5, max: 5}
 */
export function knobRange(s) {
  const min = Number.isFinite(Number(s?.min)) ? Number(s.min) : DEFAULT_MIN;
  const maxRaw = Number.isFinite(Number(s?.max)) ? Number(s.max) : DEFAULT_MAX;
  return { min, max: Math.max(min, maxRaw) };
}

/**
 * Pure function. The ONE dial, as a core/node_knobs layout record — the same
 * shape a module's knob band produces, which is what lets web/knobFocus.js turn
 * this widget with no knowledge of it.
 *
 * Built by hand rather than through `knobLayout` because that function LAYS OUT
 * a row of dials across a card's width, and this widget has exactly one dial
 * that is centred and larger. The RECORD is identical, which is the part the
 * mode reads.
 *
 * @param {object} s - the folded item state
 * @returns {Array<object>} one knobLayout record
 *
 * @example nodeKnobPlugin.knobLayout({w: 104, h: 108, value: 0.5}).length // 1
 * @example nodeKnobPlugin.knobLayout({w: 104, h: 108, value: 0.5})[0].stateKey // "value"
 * @example nodeKnobPlugin.knobLayout({w: 104, h: 108, value: 0.5})[0].fraction // 0.5
 * @example // an equation in the slot marks it BOUND, so the drag refuses it
 * @example nodeKnobPlugin.knobLayout({w: 104, h: 108, value: "= ease(time)"})[0].bound // true
 */
function knobLayoutOf(s) {
  const { min, max } = knobRange(s);
  const raw = s?.value ?? DEFAULT_VALUE;
  const bound = typeof raw !== "number" || !Number.isFinite(raw);
  const value = bound ? min : raw;
  const step = Number(s?.step);
  return [{
    key: "value",
    // THE DECLARATION, not a guess. web/knobFocus.js reads this rather than
    // prefixing "audio" onto the knob's name, which is what it used to do and
    // which would have written `audioValue` into a widget that has no such leaf.
    stateKey: "value",
    label: "",
    cx: (s?.w ?? DEFAULT_W) / 2,
    cy: NODE_HEADER_H + DIAL_CY_GAP + DIAL_R,
    r: DIAL_R,
    min, max,
    step: Number.isFinite(step) && step > 0 ? step : undefined,
    unit: "",
    value,
    fraction: knobFraction(value, min, max),
    bound,
  }];
}

export const nodeKnobPlugin = controlNodePlugin({
  type: "node_knob",
  title: "Knob",
  icon: "mdi:knob",
  ports: PORTS,
  defaults: controlDefaults("node_knob", DEFAULT_W, DEFAULT_H, {
    value: DEFAULT_VALUE, min: DEFAULT_MIN, max: DEFAULT_MAX, step: 0,
  }),
  rows: controlRangeRows("What the knob is set to, between Min and Max. Double-click the node to turn the dial by hand; it is also an ordinary number slot, so you can type it, bind it with '=' or keyframe it across slides."),
  // DOUBLE-CLICK ENTERS KNOB FOCUS — the landed mode, unchanged. The widget
  // declares `knobLayout` (its content declaration) and names the handler, and
  // web/widget_handlers.migrationPlan requires both, so declaring one without
  // the other fails the suite rather than silently losing the gesture.
  activate: "knob_focus",
  knobLayout: knobLayoutOf,
  /**
   * Pure function. The node protocol's compute step. A knob reads nothing and
   * publishes its own value, CLAMPED to its declared range — a knob reporting
   * past its own maximum would be lying about what it is.
   *
   * @example nodeKnobPlugin.computeOutputs({value: 0.5, min: 0, max: 1}) // {out: 0.5}
   * @example nodeKnobPlugin.computeOutputs({value: 5, min: 0, max: 1}) // {out: 1}
   * @example nodeKnobPlugin.computeOutputs({}) // {out: 0.5}
   */
  computeOutputs(s) {
    const { min, max } = knobRange(s);
    return { out: controlValue(s?.value, DEFAULT_VALUE, min, max) };
  },
  /**
   * Pure function. The card, the dial, the value readout, the bead, the rim.
   *
   * The dial is drawn by `knobOps` — THE shared painter, so this widget's dial
   * and a filter module's dial cannot drift apart. The focus ring is deliberately
   * NOT passed (no `ui` argument): a ring is transient editor state and belongs
   * to the screen-space overlay, because putting it in the display list would
   * make a PNG export depend on where the mouse was.
   */
  paint(s) {
    const dial = knobLayoutOf(s);
    return [
      ...familyCard(s, "Knob", CONTROL_FAMILY),
      // THE VALUE, ALWAYS SHOWN — unlike a module's knob band, where a number
      // under every one of eight dials is a wall of digits. This widget has one
      // dial and its entire purpose is that number, so hiding it until you drag
      // would make the node unreadable at a glance on a slide.
      ...nodeValueText(s, formatNodeValue(dial[0].value), (s?.h ?? DEFAULT_H) - READOUT_BASELINE_GAP),
      // No `ui` argument: the focus ring is transient editor state and belongs
      // to the screen-space overlay. The dial's SIZE rides on the record itself
      // (its `r`), so the painter and the hit test read one number.
      ...knobOps(dial, nodeFamily(CONTROL_FAMILY).rim),
      ...portBeads(nodeKnobPlugin, s),
      ...familyRim(s, CONTROL_FAMILY),
    ];
  },
});
