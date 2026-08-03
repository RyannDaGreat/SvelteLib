/**
 * BUTTON node — press it and one rising edge leaves its `trigger` output.
 *
 * ── THE ASK (user, 2026-08-03, verbatim) ────────────────────────────────────
 * "Slider nodes, button nodes for triggers. I need nodes in the UI so that some
 * of these patches I can play with them."
 *
 * ── ONE PRESS IS EXACTLY ONE EDGE ───────────────────────────────────────────
 * Not one per pointermove, not one per frame while held, and not a second one on
 * release. The engine's trigger semantics are a RISING EDGE (synth/dsp.schmittStep
 * — a low-to-high crossing, with hysteresis so a noisy signal fires once), and a
 * button is the hand-operated version of that. Holding the button down does not
 * repeat: a repeating button is a clock, and there is a Clock module for that.
 *
 * ── THE PRESS IS LIVE, AND DOES NOT TOUCH THE DOCUMENT ──────────────────────
 * This is the part that decides the whole design, and CLAUDE.md's taxonomy is
 * what settles it. There is no leaf whose value means "pressed just now" — a
 * moment is not a value. Inventing one (a counter, a timestamp) would write a
 * live human event into the saved document, i.e. EPHEMERAL state, which the
 * project has none of and is designed to avoid.
 *
 * So the press is routed as an EVENT (core/live_control.triggerRoutes decides
 * where it goes, from the document's own wires) straight to the engine, and
 * NOTHING is written. Consequences, stated rather than discovered:
 *   - a press is not undoable, because nothing changed. Cmd+Z after playing a
 *     patch undoes your last EDIT, which is what you want;
 *   - a press does not dirty the document, so playing a deck does not ask you to
 *     save it;
 *   - A RECORDED EXPORT DOES NOT REPLAY PRESSES, and that is CORRECT. Rendering
 *     a deck containing this widget produces frames in which nobody pressed it,
 *     because nobody did. To fire a trigger in an export, drive it from a Clock
 *     or Sequencer — those are RECORDABLE (pure functions of elapsed time), so
 *     they reproduce exactly. This is the same boundary the video player sits on.
 *
 * ── IT WORKS IN THE PRESENTER, WHICH IS THE POINT ───────────────────────────
 * "I need to be able to play with them myself" is not an editor-only request. A
 * press in PresentMode is the same live-consumer input as the presenter's mouse
 * and reaches the engine by the same route. That is why the press is a plain
 * pointer gesture on the node rather than an editor MODE: knob focus is right for
 * a dial (a sustained state you enter to adjust something), and wrong for a
 * button, where requiring a double-click first would put a mode between the
 * performer and the note.
 */

import { controlDefaults, controlNodePlugin, CONTROL_CAT, CONTROL_FAMILY } from "../core/control_nodes.js";
import { familyCard, familyRim, nodeFamily, portBeads, NODE_HEADER_H } from "../core/node_chrome.js";
import { rect, text } from "../render_gpu/ir.js";

const DEFAULT_W = 104;
const DEFAULT_H = 96;

/** The pressable face's inset from the card's edges, and its corner radius. */
const FACE_INSET = 14;
const FACE_TOP_GAP = 10;
const FACE_BOTTOM_GAP = 14;
const FACE_RADIUS = 5;
const LABEL_SIZE = 11;

const PORTS = { inputs: [], outputs: [{ key: "out", type: "trigger", label: "out" }] };

/**
 * Pure function. The pressable FACE's rect in LOCAL coordinates — the ONE
 * geometry the painter and the hit test both read, so the thing that looks
 * pressable is exactly the thing that is.
 *
 * @param {object} s - the folded item state
 * @returns {{x: number, y: number, w: number, h: number}}
 *
 * @example buttonFace({w: 104, h: 96}) // {x: 14, y: 34, w: 76, h: 48}
 * @example // a card squeezed shorter than its own face still reports a valid
 * @example // rect rather than a negative one; it clips, which is the visible signal
 * @example buttonFace({w: 104, h: 20}).h // 0
 */
export function buttonFace(s) {
  const w = s?.w ?? DEFAULT_W;
  const h = s?.h ?? DEFAULT_H;
  const y = NODE_HEADER_H + FACE_TOP_GAP;
  return { x: FACE_INSET, y, w: Math.max(0, w - FACE_INSET * 2), h: Math.max(0, h - y - FACE_BOTTOM_GAP) };
}

/**
 * Pure function. Does a LOCAL point land on the pressable face?
 *
 * Read by the canvas gesture. Separate from the geometry so the ANSWER is
 * testable in bare node without a browser — the same discipline
 * web/knobFocus.knobPressKind follows for the dial.
 *
 * @param {object} s - the folded item state
 * @param {number} lx - LOCAL x
 * @param {number} ly - LOCAL y
 * @returns {boolean}
 *
 * @example buttonPressed({w: 104, h: 96}, 52, 58) // true
 * @example // the header is not the button: a press there drags the node
 * @example buttonPressed({w: 104, h: 96}, 52, 10) // false
 * @example buttonPressed({w: 104, h: 96}, 2, 58) // false
 */
export function buttonPressed(s, lx, ly) {
  const f = buttonFace(s);
  return lx >= f.x && lx <= f.x + f.w && ly >= f.y && ly <= f.y + f.h;
}

export const nodeButtonPlugin = controlNodePlugin({
  type: "node_button",
  title: "Button",
  icon: "mdi:gesture-tap-button",
  ports: PORTS,
  defaults: controlDefaults("node_button", DEFAULT_W, DEFAULT_H, { label: "Fire" }),
  rows: [
    { key: "label", label: "Label", kind: "text", category: CONTROL_CAT, help: "The word on the button's face. Name it after what it does — 'Strike', 'Fire', 'Boom' — so a patch with three buttons is readable at a glance." },
  ],
  // ── NO `activate` HANDLER, DELIBERATELY ──────────────────────────────────
  // A dial gets knob focus because turning is a sustained adjustment you enter a
  // mode for. A button is one instant, and requiring a double-click to arm it
  // would put a mode between the performer and the note — in the PRESENTER,
  // where there is no editing at all. The press is an ordinary pointer gesture
  // the canvas routes by `buttonPressed`.
  extra: {
    /** The declaration the canvas and the presenter both read: this widget takes
     *  a live press, and `buttonPressed` says where. Named rather than
     *  type-matched so a future control (a pad, a switch) joins by declaring it. */
    livePress: { hit: buttonPressed, port: "out", kind: "trigger" },
  },
  /**
   * Pure function. A button's `trigger` output as the graph reads it.
   *
   * ALWAYS ZERO, and that is not a stub. The graph's value at any instant is
   * "not currently firing", because a press is not a value that persists — it is
   * an event delivered out of band (core/live_control.js). A node downstream that
   * reads this port through the value evaluator correctly sees a resting gate;
   * what actually strikes the bell is the event, which never passes through here.
   *
   * @example nodeButtonPlugin.computeOutputs({}) // {out: 0}
   */
  computeOutputs() {
    return { out: 0 };
  },
  /**
   * Pure function. The card, the face, its label, the bead, the rim.
   *
   * THE FACE IS PAINTED IN ITS RESTING STATE, ALWAYS. Whether the button is
   * currently held is live input, not document state — reading it here would make
   * Δt = 0 produce two different pictures and break the determinism law outright.
   * The pressed highlight is a screen-space overlay, the same seam the audio
   * meters use, so an export gets the honest picture of a document nobody is
   * playing.
   */
  paint(s) {
    const face = buttonFace(s);
    const accent = nodeFamily(CONTROL_FAMILY).rim;
    const label = typeof s?.label === "string" ? s.label : "";
    return [
      ...familyCard(s, "Button", CONTROL_FAMILY),
      rect({ x: face.x, y: face.y, w: face.w, h: face.h, cornerRadius: FACE_RADIUS, fill: FACE_INK, stroke: accent, strokeWidth: 1 }),
      ...(label ? [text({
        text: label, x: face.x, y: face.y + face.h / 2 + LABEL_SIZE / 3,
        size: LABEL_SIZE, color: FACE_LABEL_INK, boxW: face.w, boxStyle: { align: "center" },
      })] : []),
      ...portBeads(nodeButtonPlugin, s),
      ...familyRim(s, CONTROL_FAMILY),
    ];
  },
});

/** The button's face: lighter than the card body so it reads as a raised
 *  surface, without a bevel or a gradient (ADDENDUM 6 — never gaudy). */
const FACE_INK = "#252b3d";
const FACE_LABEL_INK = "#e8ecf8";
