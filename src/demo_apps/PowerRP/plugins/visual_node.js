/**
 * VISUAL NODE widget — a node that DOES NOTHING, for diagrams.
 *
 * ── THE ASK (user, 2026-08-21) ──────────────────────────────────────────────
 * "You know how audio nodes look right now? Well, I just want one so that I can do
 * visuals … it should share the same structure, the same data type as the audio
 * ones. It just doesn't do anything." With: a customizable name, colour and shape
 * (card, rounded / chamfered rectangle, circle or oval, diamond, triangle), a
 * customizable list of inputs and outputs with their own colours, a fill
 * material ("by default a singular color. It could be gradients"), and a
 * flowchart kind "where I double click it and it has text built into it … I'm
 * just editing the text on this singular widget. It's not a compound widget."
 *
 * ── WHAT THIS FILE IS ───────────────────────────────────────────────────────
 * The DECLARATION: defaults, Inspector rows, presets, and an emit() that spreads
 * the shared parts. Every piece of geometry — the silhouettes, the inscribed text
 * box, the ports-on-the-ink placement, the rim projection — is a pure function in
 * core/visual_node.js, which is where the reasoning for each lives and what
 * tests/visual_node_test.js runs in bare node. This is the audio_nodes.js split:
 * a plugin is its data plus one call into core.
 *
 * ── HOW IT SHARES THE AUDIO NODES' STRUCTURE ────────────────────────────────
 * It declares `ports(state)` (so it IS a node widget — core/registry.js: "a node
 * widget is an ordinary widget that declares ports"), `itemRefs: NODE_ITEM_REFS`
 * (so a copied diagram's wires follow the copies), an `inputs: {}` map (so the
 * wildcard has a slot to expand over), and it paints its beads through the SAME
 * core/node_chrome.portBeads every working node uses. A wire into it is the same
 * `inputs.<port> = {item, port}` leaf, drawn by the same wire layer, exported by
 * the same backends. What it lacks is `computeOutputs` — so it is a pure SINK in
 * the value evaluator's terms — and an engine binding, so the audio mirror never
 * sees it. Its ports are `visual`-typed (core/nodeflow.PORT_TYPES): the type that
 * carries nothing, which is why a visual node wires only to visual nodes and why
 * a wire into it can never make a number node compute something false.
 *
 * ── TEXT: THE PLAINTEXT IDIOM, INSIDE A SHAPE ───────────────────────────────
 * The body text is plaintext's exact contract — one plain `text` string, one
 * `text()` op with boxW/boxH + align/valign, `activate: "inline_text_edit"` —
 * with two descriptor fields plaintext never needed: `ink` (the glyph colour is
 * `textFill`, because `fill` is the SHAPE's material here) and `box` (the text is
 * laid out in the rect inscribed in the silhouette, core/visual_node.visualNodeTextBox,
 * and the in-place editor reads the same function so its caret lands on the same
 * glyphs). So "I should be able to control the font just like I would a plain
 * text" is literally the same five rows plaintext declares.
 *
 * ── PRESETS ARE WHOLE LOOKS, AND THEY WRITE THE PORT LISTS TOO ──────────────
 * "We can have presets for all of these" — the labeled card, the text-only
 * flowchart shapes, the unlabeled ones. A preset here writes EVERY look knob
 * (plugins/plaintext.js's rule: an omitted key keeps whatever the last hovered
 * row left there), INCLUDING the two port lists, because a Decision diamond with
 * one input and no outputs is not a decision. NO PRESET WRITES `text` — it is the
 * author's own words, and it may hold an `=` equation.
 */

import { EPHEMERAL } from "../core/ephemeral.js";
import { standardBBoxAnchors } from "../core/derive.js";
import { bundle, bundleNestedDefaults, defaults, props } from "../core/properties.js";
import { INHERIT_WIRE_STYLE, NODE_ITEM_REFS, nodeInkBounds, nodeInputRows, portColor } from "../core/nodeflow.js";
import {
  NODE_BODY, NODE_FAMILIES, NODE_HEADER, NODE_PAD, NODE_RIM, NODE_RIM_WIDTH, NODE_TITLE_INK,
  NODE_TITLE_SIZE, NODE_VALUE_INK, nodeBox, portBeads, titleLineTop,
} from "../core/node_chrome.js";
import {
  IN_PORTS_KEY, NODE_CORNER_R, OUT_PORTS_KEY, VISUAL_PORT_TYPE, VISUAL_SHAPES, VISUAL_SHAPE_LABELS,
  placeVisualPorts, visualCorners, visualHasHeader, visualHeaderPathD, visualLabelBox, visualNodePathD,
  visualNodePorts, visualNodeRim, visualNodeTextBox, visualShapeOf, visualTextIsEmpty,
} from "../core/visual_node.js";
import { CORNER_STYLES } from "../core/shapes.js";
import { path, text } from "../render_gpu/ir.js";
import { DEFAULT_FONT, fontOptions } from "../render_gpu/fonts.js";
import { applyEffects, effectsCullMargin } from "../render_gpu/effects.js";
import * as T from "../core/transform.js";

/** A fresh node's box: wide enough for a two-word label and a port label a side,
 *  tall enough for one port row plus two lines of body text under it. */
const DEFAULT_W = 180;
const DEFAULT_H = 110;

/** The body text's default size. Smaller than plaintext's 36 because this text
 *  lives INSIDE a node-sized shape; larger than the chrome's 12pt title because it
 *  is content, not chrome. */
const DEFAULT_TEXT_SIZE = 18;

/** A fresh port's colour: the visual type's own (core/nodeflow.PORT_TYPES.visual),
 *  so an un-recoloured socket reads as "a socket" rather than as a value hue. */
const VISUAL_COLOR = portColor(VISUAL_PORT_TYPE);

/** The Inspector category the shape rows land in, and the one the text rows
 *  share with plaintext. */
const SHAPE_CAT = "formatting";
const TEXT_CAT = "text";

// plaintext's alignment vocabulary, restated: a plugin may not import another
// plugin, and the registry declares no align/valign rows of its own.
const ALIGN_OPTIONS = ["left", "center", "right", "justify"];
const ALIGN_LABELS = { left: "Left", center: "Center", right: "Right", justify: "Justify" };
const VALIGN_OPTIONS = ["top", "middle", "bottom"];
const VALIGN_LABELS = { top: "Top", middle: "Middle", bottom: "Bottom" };
const CORNER_LABELS = { round: "Round", chamfer: "Chamfer" };

/**
 * Pure function. One port-list element.
 *
 * @param {string} label - the drawn name ("" for the jack alone)
 * @param {string} [color] - a hex colour; defaults to the visual type's
 * @param {boolean} [multiple] - an INPUT's "accept several" permission
 * @returns {{label: string, color: string, multiple?: boolean}}
 *
 * @example port("in") // {label: "in", color: "#a9b1d6", wire: "inherit"}
 * @example port("mix", "#ff8800", true) // {label: "mix", color: "#ff8800", multiple: true, wire: "inherit"}
 */
export function port(label, color = VISUAL_COLOR, multiple = false) {
  return { label, color, ...(multiple ? { multiple: true } : {}), wire: INHERIT_WIRE_STYLE };
}

/** Pure function. Is the shape one with corners to treat? (The ellipse has none.)
 *  @example hasCorners({shape: "ellipse"}) // false
 *  @example hasCorners({shape: "diamond"}) // true */
const hasCorners = (s) => visualShapeOf(s) !== "ellipse";

/**
 * Pure function. A whole-look preset row. Every look knob is written (the
 * plaintext family rule), `text` never is. `family` picks the header/rim pair off
 * core/node_chrome.NODE_FAMILIES so the flowchart looks share the node catalogue's
 * six restrained tints rather than minting new hues.
 *
 * @param {string} name - the preset's name
 * @param {string} description - what it is for
 * @param {object} look - {shape, cornerRadius, cornerStyle, label, family, inPorts, outPorts, size?}
 * @returns {{name: string, description: string, props: object}}
 *
 * @example look("X", "d", {shape: "diamond", cornerRadius: 0, cornerStyle: "round", label: "", family: "effect", inPorts: [], outPorts: []}).props.fill // "#2b2440"
 */
function look(name, description, { shape, cornerRadius, cornerStyle, label, family, inPorts, outPorts, size = DEFAULT_TEXT_SIZE }) {
  const f = family ? NODE_FAMILIES[family] : { header: NODE_HEADER, rim: NODE_RIM };
  const card = shape === "card";
  return {
    name, description,
    props: {
      shape, cornerRadius, cornerStyle, label,
      // A card's body is the shared dark NODE_BODY with the family tint in its
      // strip; a flowchart shape has no strip, so the tint IS its body.
      fill: card ? NODE_BODY : f.header,
      headerFill: f.header,
      stroke: f.rim, strokeWidth: NODE_RIM_WIDTH,
      labelFill: NODE_TITLE_INK, textFill: NODE_VALUE_INK,
      font: DEFAULT_FONT, size, bold: false, align: "center", valign: "middle",
      opacity: 1,
      [IN_PORTS_KEY]: inPorts, [OUT_PORTS_KEY]: outPorts,
    },
  };
}

/** The looks: the card every other node wears, then the flowchart vocabulary. */
const VISUAL_LOOKS = [
  look("Node Card", "The node-chrome card: a title strip, one input and one output, the body dark like every working node's. The default.",
    { shape: "card", cornerRadius: NODE_CORNER_R, cornerStyle: "round", label: "Node", family: null, inPorts: [port("in")], outPorts: [port("out")] }),
  look("Process", "A flowchart step: a rounded rectangle with the text in the middle, one wire in and one out, no title.",
    { shape: "rect", cornerRadius: 8, cornerStyle: "round", label: "", family: "modulation", inPorts: [port("")], outPorts: [port("")] }),
  look("Decision", "A flowchart branch: a diamond with the question in the middle, one input, and a green YES and a red NO leaving it.",
    { shape: "diamond", cornerRadius: 0, cornerStyle: "round", label: "", family: "effect", inPorts: [port("")], outPorts: [port("yes", NODE_FAMILIES.analysis.rim), port("no", NODE_FAMILIES.output.rim)] }),
  look("Terminal", "A flowchart start or end: an oval with the word in the middle and a single wire on each side.",
    { shape: "ellipse", cornerRadius: 0, cornerStyle: "round", label: "", family: "analysis", inPorts: [port("")], outPorts: [port("")] }),
  look("Chamfered Block", "A block with its corners cut straight — the industrial look — labelled along the top, text beneath.",
    { shape: "rect", cornerRadius: 14, cornerStyle: "chamfer", label: "Block", family: "source", inPorts: [port("in")], outPorts: [port("out")] }),
  look("Merge", "A triangle pointing up: two unlabelled inputs on its left slope, one output on its right — the join in a diagram.",
    { shape: "triangle", cornerRadius: 4, cornerStyle: "round", label: "", family: "filter", inPorts: [port(""), port("")], outPorts: [port("")], size: 14 }),
  look("Hub", "An oval whose single input ACCEPTS SEVERAL wires — the many-to-one collector — with one output.",
    { shape: "ellipse", cornerRadius: 0, cornerStyle: "round", label: "Hub", family: "modulation", inPorts: [port("all", VISUAL_COLOR, true)], outPorts: [port("")] }),
  look("Plain Label", "An unlabelled, unwired rounded rectangle with text in the middle — a caption box that happens to be a node, so wires can be added later.",
    { shape: "rect", cornerRadius: 12, cornerStyle: "round", label: "", family: null, inPorts: [], outPorts: [] }),
];

export const visualNodePlugin = {
  type: "visual_node",
  ephemeral: EPHEMERAL.NONE,
  title: "Visual Node",
  capabilities: { bbox: true, transform: true, resizable: true, backdrop: false },
  itemRefs: NODE_ITEM_REFS,
  presets: VISUAL_LOOKS,
  // DOUBLE-CLICK EDITS THE BODY TEXT IN PLACE — plaintext's handler, with the two
  // descriptor fields this widget needs (see the file header): the glyph ink is
  // `textFill`, and the box is the shape's inscribed text box.
  activate: "inline_text_edit",
  inlineTextEdit: { property: "text", plain: true, ink: "textFill", box: visualNodeTextBox },
  defaults: {
    type: "visual_node", x: 100, y: 100, w: DEFAULT_W, h: DEFAULT_H,
    z: 0, rotation: 0, scale: 1,
    rotationAnchor: { x: "self.anchors.center.x", y: "self.anchors.center.y" },
    shape: "card", cornerRadius: NODE_CORNER_R, cornerStyle: "round",
    label: "Node", labelFill: NODE_TITLE_INK, headerFill: NODE_HEADER,
    fill: NODE_BODY, stroke: NODE_RIM, strokeWidth: NODE_RIM_WIDTH,
    text: "", font: DEFAULT_FONT, size: DEFAULT_TEXT_SIZE, bold: false,
    align: "center", valign: "middle", textFill: NODE_VALUE_INK,
    [IN_PORTS_KEY]: [port("in")],
    [OUT_PORTS_KEY]: [port("out")],
    // THE CONNECTION MAP, empty at birth but PRESENT — NODE_ITEM_REFS names a
    // wildcard path through it, and a wildcard cannot expand over a slot that
    // does not exist (core/audio_nodes.js measured what forgetting this costs).
    inputs: {},
    ...defaults("opacity"),
    ...bundleNestedDefaults("effects"),
  },
  inspector: [
    ...bundle("transform"),
    { key: "shape", label: "Shape", kind: "select", options: [...VISUAL_SHAPES], optionLabels: VISUAL_SHAPE_LABELS, category: SHAPE_CAT, help: "The silhouette. Card is the node-chrome look (a title strip, beads down the sides); the others are flowchart shapes with the text inside and the beads on their outline." },
    { key: "cornerStyle", label: "Corners", kind: "select", options: [...CORNER_STYLES], optionLabels: CORNER_LABELS, category: SHAPE_CAT, visibleWhen: hasCorners, help: "How a corner is cut back by the corner radius: rounded with a curve, or chamfered with a straight cut." },
    ...props("cornerRadius", { cornerRadius: { visibleWhen: hasCorners, help: "How far each corner is cut back, in canvas units. Zero is a sharp point; the cut never exceeds half the shortest edge." } }),
    { key: "label", label: "Label", kind: "text", category: TEXT_CAT, help: "The node's name, drawn. On a card it is the title strip; on a shape it is a small caption above the text. Leave it blank for an unlabelled node — a card then has no strip at all." },
    { key: "labelFill", label: "Label color", kind: "color", category: TEXT_CAT, help: "The colour the label is drawn in." },
    { key: "headerFill", label: "Header", kind: "color", category: "fillMaterial", visibleWhen: (s) => visualShapeOf(s) === "card", help: "The title strip's tint on a card — one step off the body, like every working node's header." },
    ...props("fill", "stroke", "strokeWidth"),
    { key: "text", label: "Text", kind: "text", category: TEXT_CAT, help: "The text in the middle of the node. Double-click the node to edit it in place, or start with '=' to bind it to an equation." },
    { key: "font", label: "Font", kind: "select", options: fontOptions().map((o) => o.value), optionLabels: Object.fromEntries(fontOptions().map((o) => [o.value, o.label])), category: TEXT_CAT, help: "The typeface the text is drawn in." },
    { key: "size", label: "Size", kind: "number", min: 0, category: TEXT_CAT, help: "Font size in canvas units." },
    { key: "bold", label: "Bold", kind: "boolean", category: TEXT_CAT, help: "Draw the text in the font's bold weight." },
    { key: "align", label: "Align", kind: "select", options: ALIGN_OPTIONS, optionLabels: ALIGN_LABELS, category: TEXT_CAT, help: "Horizontal alignment of the text within its box." },
    { key: "valign", label: "V-Align", kind: "select", options: VALIGN_OPTIONS, optionLabels: VALIGN_LABELS, category: TEXT_CAT, help: "Vertical placement of the text within its box." },
    { key: "textFill", label: "Text fill", kind: "color", paint: true, category: TEXT_CAT, help: "How the glyphs are painted: a solid colour, a gradient, or a material. Distinct from the shape's own Fill." },
    ...props(IN_PORTS_KEY, OUT_PORTS_KEY),
    ...props("opacity"),
    ...bundle("effects"),
  ],
  /** Query. ONE WIRING ROW PER CURRENT INPUT PORT (core/nodeflow.nodeInputRows) —
   *  dynamic because the port list is itself a property the author grows, so the
   *  rows cannot be declared once. core/registry.js `dynamicInspector`. */
  dynamicInspector: (state) => nodeInputRows(visualNodePlugin, state),
  ports: visualNodePorts,
  placePorts: placeVisualPorts,
  // NO computeOutputs: the node does nothing, so it is a SINK in the value
  // evaluator's terms (and its ports are `visual`, which carries nothing anyway).
  /**
   * Pure function. The silhouette, the title strip or caption, the body text, the
   * beads, the rim — in that order, so the beads sit over the fill and the rim
   * over the beads' inner halves, exactly as every other node card is layered.
   *
   * @param {object} s - the folded item state
   * @param {*} _target - unused (bbox widget)
   * @param {object} world - the world transform (effects halo mapping)
   * @returns {object[]} display-list commands
   */
  emit(s, _target, world) {
    const { w, h: boxH } = nodeBox(s);
    const h = boxH ?? 0;
    const { cornerRadius, cornerStyle } = visualCorners(s);
    const d = visualNodePathD(visualShapeOf(s), w, h, cornerRadius, cornerStyle);
    const ops = [path({ d, fill: s.fill ?? NODE_BODY })];
    if (visualHasHeader(s)) {
      ops.push(path({ d: visualHeaderPathD(s), fill: s.headerFill ?? NODE_HEADER }));
      ops.push(text({ text: String(s.label), x: NODE_PAD, y: titleLineTop(), size: NODE_TITLE_SIZE, color: s.labelFill ?? NODE_TITLE_INK, bold: true, boxW: Math.max(0, w - 2 * NODE_PAD) }));
    } else {
      const lb = visualLabelBox(s);
      if (lb) ops.push(text({ text: String(s.label), x: lb.x, y: lb.y, size: NODE_TITLE_SIZE, color: s.labelFill ?? NODE_TITLE_INK, bold: true, boxW: lb.w, boxStyle: { align: "center" } }));
    }
    if (!visualTextIsEmpty(s)) {
      const tb = visualNodeTextBox(s);
      ops.push(text({
        text: String(s.text),
        x: tb.x, y: tb.y,
        size: s.size ?? DEFAULT_TEXT_SIZE,
        color: s.textFill ?? NODE_VALUE_INK,
        bold: s.bold ?? false,
        font: s.font ?? DEFAULT_FONT,
        boxW: tb.w > 0 ? tb.w : Infinity,
        boxH: tb.h > 0 ? tb.h : Infinity,
        boxStyle: { align: s.align ?? "center", valign: s.valign ?? "middle" },
      }));
    }
    ops.push(...portBeads(visualNodePlugin, s));
    const strokeWidth = Math.max(0, Number(s.strokeWidth) || 0);
    if (strokeWidth > 0) ops.push(path({ d, fill: null, stroke: s.stroke ?? NODE_RIM, strokeWidth }));
    return applyEffects(ops, s, world, { x: 0, y: 0, w, h });
  },
  commands: [{
    id: "add-visual-node",
    title: "Add Visual Node",
    icon: "mdi:vector-square",
    category: "Visual Nodes",
    run: (app) => app.armCrosshairPlacement(visualNodePlugin),
  }],
  cullMargin: effectsCullMargin,
  // THE BOUNDS PROTOCOL: the box plus the half-bead halo on the sides that carry
  // ports — a bead placed on a diamond's slope is still inside the box plus that
  // halo, so the node's shared answer holds for every shape.
  localBounds: (state) => nodeInkBounds(visualNodePlugin, state),
  anchors: standardBBoxAnchors,
  // The rim is THIS SHAPE's outline — a projection onto the diamond, the ellipse,
  // the chamfered corner — so a bound arrow lands on the ink (the ink rule).
  closestAnchor(state, wx, wy, world) {
    const local = T.apply(T.invert(world), wx, wy);
    return visualNodeRim(state, local.x, local.y);
  },
};
