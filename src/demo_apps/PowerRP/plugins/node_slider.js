/**
 * SLIDER node — a linear strip you drag, whose value goes out on a `number` port.
 *
 * ── THE ASK (user, 2026-08-03, verbatim) ────────────────────────────────────
 * "I'll also like to have a knob node, for example. Slider nodes, button nodes
 * for triggers."
 *
 * ── IT IS THE KNOB WITH A DIFFERENT PICTURE, AND THAT IS THE POINT ──────────
 * Identical contract to plugins/node_knob.js: a `value` leaf between `min` and
 * `max`, snapped by `step`, out on one `number` port, played through the landed
 * knob-focus mode. What differs is the FACE — a vertical track with a handle
 * instead of a dial with a pointer.
 *
 * They are two widgets rather than one with a `style` knob because the shape of
 * a control is not a setting, it is what the author chose to put on the slide;
 * a "knob that is drawn as a slider" would be a widget whose name and picture
 * disagree. They share their behaviour through core/control_nodes.js, which is
 * where the identical parts actually live.
 *
 * ── WHY VERTICAL, AND WHY DRAG-UP IS MORE ───────────────────────────────────
 * Vertical because knob focus's drag law is vertical (core/node_knobs.knobDragValue:
 * "UP is more … the near-universal convention in audio software"), and a
 * horizontal strip driven by vertical drag would be a control whose picture and
 * gesture point in different directions. A mixer fader is vertical for the same
 * reason, so the picture is also the familiar one.
 */

import {
  controlDefaults, controlFace, controlNodeHeight, controlNodePlugin, controlRangeRows,
  controlValue, CONTROL_FAMILY, CONTROL_READOUT_H,
} from "../core/control_nodes.js";
import { familyCard, familyRim, formatNodeValue, nodeBox, nodeFamily, portBeads, NODE_BODY_GAP, NODE_VALUE_INK } from "../core/node_chrome.js";
import { AUDIO_READOUT_SIZE } from "../core/audio_nodes.js";
import { knobFraction } from "../core/node_knobs.js";
import { rect, text } from "../render_gpu/ir.js";

const DEFAULT_W = 84;
const DEFAULT_VALUE = 0.5;
const DEFAULT_MIN = 0;
const DEFAULT_MAX = 1;

/** The track's width. */
const TRACK_W = 6;
/** The handle: wider than the track so it reads as a grip, and tall enough to
 *  be an obvious target rather than a line. */
const HANDLE_W = 30;
const HANDLE_H = 11;
/** The grab radius for the handle, in LOCAL units — knob focus hit-tests a dial
 *  as a CIRCLE (core/node_knobs.knobAt), so the strip declares the radius that
 *  covers its handle rather than pretending to be a dial the size of the card. */
const HANDLE_GRAB_R = 15;

/**
 * THE FACE DECLARATION — an ELASTIC band, and the contrast with the Knob's rigid
 * one is the whole reason `nodeFaceBand` has two kinds.
 *
 * A DIAL'S internal proportions carry its reading (an oval dial reads its angle
 * wrong everywhere but the axes), so it may only scale uniformly. A TRACK'S
 * length is not a proportion, it is a RANGE: a fader on a tall card should BE
 * tall, and stretching it costs nothing. So this one says `grow: true` and takes
 * the room under the ports, reserving the readout's line beneath.
 *
 * The natural height is what the old hand-rolled `TRACK_TOP_GAP`/`TRACK_BOTTOM_GAP`
 * pair produced at the default size, so a Slider at its own default is the
 * picture it always was, one band lower.
 */
const TRACK_NATURAL_H = 85;
const FACE = { height: TRACK_NATURAL_H, grow: true, bottomPad: CONTROL_READOUT_H, inset: HANDLE_W / 2 };

const PORTS = { inputs: [], outputs: [{ key: "out", type: "number", label: "out" }] };

/** The card's default height: the derived sum of its bands. */
const DEFAULT_H = controlNodeHeight(FACE, PORTS);

/**
 * Pure function. This slider's range, defaulted and ordered — identical rule to
 * the knob's: an inverted range CLAMPS to a constant rather than throwing, since
 * a tween can pass through one and a throw on the render path kills the frame.
 *
 * @example sliderRange({}) // {min: 0, max: 1}
 * @example sliderRange({min: -1, max: 1}) // {min: -1, max: 1}
 * @example sliderRange({min: 5, max: 1}) // {min: 5, max: 5}
 */
export function sliderRange(s) {
  const min = Number.isFinite(Number(s?.min)) ? Number(s.min) : DEFAULT_MIN;
  const maxRaw = Number.isFinite(Number(s?.max)) ? Number(s.max) : DEFAULT_MAX;
  return { min, max: Math.max(min, maxRaw) };
}

/**
 * Pure function. The track's geometry in LOCAL coordinates.
 *
 * ONE function, read by the painter AND by the layout the drag hit-tests, which
 * is the same one-source rule core/nodeflow.portLayout states for the beads: a
 * handle drawn where it cannot be grabbed is a defect invisible in a screenshot.
 *
 * SINCE R7-10 IT DERIVES NOTHING ITSELF. It used to compute `top` from a constant
 * off the header and `bottom` from `h - TRACK_BOTTOM_GAP` — the second of the
 * three hand-rolled placement schemes, and the one that at least reflowed, which
 * is why it was the least broken of them. It now reads the face
 * `core/control_nodes.controlFace` hands back, so a Slider and a Knob and a
 * Mixer's dial band all reflow by the same arithmetic, and a NEGATIVE width is a
 * reflection rather than a track at negative x (which is what `w / 2` on a raw
 * signed width produced).
 *
 * @param {object} s - the folded item state
 * @returns {{x: number, top: number, bottom: number, height: number}}
 *
 * @example sliderTrack({w: 84, h: 160}).x // 42
 * @example // TOP = nodeBodyTop: one bead (y 34) + its radius + one gap. It was 36
 * @example // (a constant 12 under the header) and is now derived, which is the
 * @example // unification — the track starts below the PORTS like every other face.
 * @example sliderTrack({w: 84, h: 160}).top // 48
 * @example // BOTTOM = h - CONTROL_READOUT_H, i.e. 160 - (8 gap + a 15.6 line) =
 * @example // 136.4. The old pair reserved READOUT_BASELINE_GAP(14) + SIZE(13) = 27,
 * @example // a guess at how much room a BASELINE needs beneath it; the renderer has
 * @example // no baseline, so the reservation is now the line's real height.
 * @example sliderTrack({w: 84, h: 160}).bottom // 136.4
 * @example // a TALLER card stretches the track rather than leaving a gap: the same
 * @example // 23.6 is reserved, so 260 - 23.6 - 48 = 188.4.
 * @example sliderTrack({w: 84, h: 260}).height // 188.4
 * @example // a FLIPPED card is a reflection, not a negative x
 * @example sliderTrack({w: -84, h: 160}).x // 42
 */
export function sliderTrack(s) {
  const face = controlFace(FACE, nodeSliderPlugin, s);
  return { x: nodeBox(s).w / 2, top: face.y, bottom: face.y + face.h, height: face.h };
}

/**
 * Pure function. The handle's centre for a value fraction. Fraction 0 is the
 * BOTTOM of the track and 1 the top, because up is more.
 *
 * @param {object} s - the folded item state
 * @param {number} fraction - in [0, 1]
 * @returns {{cx: number, cy: number}}
 *
 * @example // the ends ARE the track's ends (136.4 and 48 — see sliderTrack for why
 * @example // each moved), and the middle is their midpoint. Nothing here is chosen.
 * @example sliderHandle({w: 84, h: 160}, 0).cy // 136.4
 * @example sliderHandle({w: 84, h: 160}, 1).cy // 48
 * @example sliderHandle({w: 84, h: 160}, 0.5).cy // 92.2
 */
export function sliderHandle(s, fraction) {
  const track = sliderTrack(s);
  return { cx: track.x, cy: track.bottom - fraction * track.height };
}

/**
 * Pure function. The slider's ONE control, as a core/node_knobs layout record.
 *
 * It declares the same record shape a dial does, which is the whole reason this
 * widget needs no gesture code: web/knobFocus.js hit-tests `knobLayout`, drags
 * by `knobDragValue` (an absolute measure from the grab, in the SAME vertical
 * direction), refuses a `bound` value and writes `stateKey`. None of that knows
 * or cares that the picture is a strip.
 *
 * @param {object} s - the folded item state
 * @returns {Array<object>} one knobLayout record
 *
 * @example nodeSliderPlugin.knobLayout({w: 84, h: 160, value: 0.5})[0].stateKey // "value"
 * @example nodeSliderPlugin.knobLayout({w: 84, h: 160, value: 1, min: 0, max: 1})[0].fraction // 1
 * @example // the record's centre TRACKS THE VALUE, so the grab target is under
 * @example // the handle rather than at a fixed point on the card
 * @example nodeSliderPlugin.knobLayout({w: 84, h: 160, value: 1})[0].cy < nodeSliderPlugin.knobLayout({w: 84, h: 160, value: 0})[0].cy // true
 * @example nodeSliderPlugin.knobLayout({w: 84, h: 160, value: "= ease(time)"})[0].bound // true
 */
function sliderLayoutOf(s) {
  const { min, max } = sliderRange(s);
  const raw = s?.value ?? DEFAULT_VALUE;
  const bound = typeof raw !== "number" || !Number.isFinite(raw);
  const value = bound ? min : raw;
  const fraction = knobFraction(value, min, max);
  const handle = sliderHandle(s, fraction);
  const step = Number(s?.step);
  return [{
    key: "value",
    stateKey: "value",
    label: "",
    cx: handle.cx,
    cy: handle.cy,
    r: HANDLE_GRAB_R,
    // THE DRAG SPAN IS THE TRACK'S OWN LENGTH, so the handle stays under the
    // cursor. With the shared KNOB_DRAG_SPAN a full-track drag reached 0.79 of
    // the range and the handle visibly lagged the pointer — measured, and the
    // one thing a slider must not do (core/node_knobs.knobDragValue records it).
    span: sliderTrack(s).height,
    min, max,
    step: Number.isFinite(step) && step > 0 ? step : undefined,
    unit: "",
    value,
    fraction,
    bound,
    driven: false,
  }];
}

export const nodeSliderPlugin = controlNodePlugin({
  type: "node_slider",
  title: "Slider",
  icon: "mdi:tune-vertical",
  ports: PORTS,
  defaults: controlDefaults("node_slider", DEFAULT_W, DEFAULT_H, {
    value: DEFAULT_VALUE, min: DEFAULT_MIN, max: DEFAULT_MAX, step: 0,
  }),
  rows: controlRangeRows("What the slider is set to, between Min and Max. Double-click the node to drag the handle by hand; it is also an ordinary number slot, so you can type it, bind it with '=' or keyframe it across slides."),
  activate: "knob_focus",
  knobLayout: sliderLayoutOf,
  /**
   * Pure function. The compute step: the slider's own value, clamped to its
   * declared range.
   *
   * @example nodeSliderPlugin.computeOutputs({value: 0.25, min: 0, max: 1}) // {out: 0.25}
   * @example nodeSliderPlugin.computeOutputs({value: -3, min: 0, max: 1}) // {out: 0}
   * @example nodeSliderPlugin.computeOutputs({}) // {out: 0.5}
   */
  computeOutputs(s) {
    const { min, max } = sliderRange(s);
    return { out: controlValue(s?.value, DEFAULT_VALUE, min, max) };
  },
  /**
   * Pure function. The card, the track, the filled portion, the handle, the
   * readout, the bead, the rim.
   *
   * The FILL below the handle is what makes the value readable at a glance
   * without reading the number — the same job a dial's value arc does, which is
   * why both exist. Restrained per ADDENDUM 6: a track, a fill, a handle. No
   * bevel, no gradient, no tick marks.
   */
  face: FACE,
  paint(s, face) {
    const control = sliderLayoutOf(s)[0];
    const track = sliderTrack(s);
    const accent = nodeFamily(CONTROL_FAMILY).rim;
    const fillTop = control.cy;
    return [
      ...familyCard(s, "Slider", CONTROL_FAMILY),
      rect({ x: track.x - TRACK_W / 2, y: track.top, w: TRACK_W, h: track.height, cornerRadius: TRACK_W / 2, fill: TRACK_INK }),
      rect({ x: track.x - TRACK_W / 2, y: fillTop, w: TRACK_W, h: Math.max(0, track.bottom - fillTop), cornerRadius: TRACK_W / 2, fill: accent }),
      rect({ x: control.cx - HANDLE_W / 2, y: control.cy - HANDLE_H / 2, w: HANDLE_W, h: HANDLE_H, cornerRadius: HANDLE_RADIUS, fill: HANDLE_INK, stroke: accent, strokeWidth: 1 }),
      // At the audio readout's size, not nodeValueText's 22pt — see node_knob.js.
      // Placed from the FACE's bottom as a line box, for the reason recorded
      // there: the retired `READOUT_BASELINE_GAP` was guessing room for a
      // baseline the renderer does not have.
      text({
        text: formatNodeValue(control.value),
        x: 0, y: face.y + face.h + NODE_BODY_GAP,
        size: AUDIO_READOUT_SIZE, color: NODE_VALUE_INK,
        boxW: nodeBox(s).w, boxStyle: { align: "center" },
      }),
      ...portBeads(nodeSliderPlugin, s),
      ...familyRim(s, CONTROL_FAMILY),
    ];
  },
});

/** The unfilled track — the same value as the card's rim, so it reads as chrome
 *  rather than as content (the dial's track makes the same choice). */
const TRACK_INK = "#2a3040";
/** The handle's body: the card's own body colour, so the handle reads as a piece
 *  of the node sitting on the track rather than as a foreign object. */
const HANDLE_INK = "#1c2030";
const HANDLE_RADIUS = 3;
