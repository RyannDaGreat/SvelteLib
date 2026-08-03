/**
 * NODE CHROME — the shared visual language every node widget is drawn in.
 *
 * ── WHY A SHARED MODULE AND NOT A BASE PLUGIN ────────────────────────────────
 * No plugin may import another plugin (the registry law). But every node widget
 * must look like the SAME KIND OF OBJECT or the canvas stops reading as one editor
 * — a node whose title bar sits two pixels off, or whose bead is a different size,
 * reads as a bug even when nothing is wrong. So the chrome lives in core/ as pure
 * display-list construction and every node plugin's emit() spreads it, which is
 * exactly the composition route the law points at (shared core modules).
 *
 * ── THE TASTE ANCHOR IS AUDULUS (user, ADDENDUM 6, verbatim) ─────────────────
 * "you gotta make sure that because you're Claude, you don't get gouty and
 * disgusting. So actually, Audulous, A-U-D-U-L-U-S, is great for inspiration for
 * aesthetics."
 *
 * What that means concretely, and what each choice is FOR:
 *   FLAT, NOT SKEUOMORPHIC. No bevels, no gloss, no drop shadows baked into the
 *     chrome. A node is a card, not a hardware panel. (The universal EFFECTS
 *     bundle can still give one a shadow — that is the AUTHOR's choice on one
 *     widget, not a look every node is born wearing.)
 *   DARK BODY, LIGHT TEXT. Audulus is a black canvas with luminous line work.
 *     PowerRP's canvas default is WHITE, so a node cannot borrow the canvas as
 *     its background — it brings its own dark card, which is what makes a patch
 *     read as a distinct region of the slide rather than as scattered boxes.
 *   ONE ACCENT PER NODE, AND IT IS THE PORT COLOR. The palette does not grow with
 *     the node count; a node's identity comes from its title and its port types.
 *     That is the discipline that keeps a 40-node patch from looking like candy.
 *   THE RIM IS THE ONLY STROKE. One hairline border at one opacity. Every extra
 *     line in a node editor is a line the eye has to rule out as a wire.
 *   GENEROUS CORNERS, TIGHT SPACING. Rounded enough to read as soft (Audulus's
 *     signature), spaced tightly enough that a node stays small — a big node is a
 *     node you cannot fit ten of on a slide.
 *
 * ── WHY THE COLORS ARE LITERALS AND NOT CSS TOKENS ──────────────────────────
 * emit() produces a DEVICE-INDEPENDENT display list consumed by Skia (editor), the
 * PDF/SVG exporters, and bare-node cli/render.js. None of those has a DOM, so none
 * can resolve a CSS custom property. The DOM-side chrome (the SVG bead hit layer,
 * the ghost wire) DOES use --a-port-* tokens, and core/nodeflow.portTypeCssVars()
 * generates that block from the same table these literals come from — so the two
 * halves share one source of truth even though they cannot share one mechanism.
 */

import { ellipse, rect, text } from "../render_gpu/ir.js";
import { NODE_CORNER_R, PORT_BEAD_R, portColor, portLayout } from "./nodeflow.js";

// ── THE PALETTE (one place; every node widget reads these) ───────────────────

/** The card body: near-black with a touch of blue, so it sits against a white
 *  slide as a deliberate object rather than as a hole. */
export const NODE_BODY = "#1c2030";
/** The title strip: one step lighter than the body — the only value change in the
 *  card, so the eye finds the name without a second border. */
export const NODE_HEADER = "#262b3d";
/** The single hairline rim. Light at low opacity: it defines the silhouette
 *  without competing with the wires. */
export const NODE_RIM = "#4a5170";
/** Title text: not pure white. Pure white on a dark card glares and makes the
 *  value readout below it look dimmer than it is. */
export const NODE_TITLE_INK = "#c8cee6";
/** The VALUE readout ink — brighter than the title, because the number is the
 *  thing you are actually reading. */
export const NODE_VALUE_INK = "#e8ecf8";
/** Port labels: quiet. They name a bead you can also identify by color and
 *  position, so they must not shout. */
export const NODE_PORT_INK = "#8f97b8";

/** Rim stroke width and corner radius, in LOCAL units. */
export const NODE_RIM_WIDTH = 1.5;
/** The card's corner radius. Defined in core/nodeflow.js (which owns node GEOMETRY
 *  and imports no painter) and re-exported here, where a plugin author looks for
 *  the rest of the card's look — so the painted arc and the rim projection every
 *  node's `closestAnchor` uses cannot drift into two numbers. */
export const NODE_RADIUS = NODE_CORNER_R;
/** The title strip's height — also the top inset before the first port row
 *  (core/nodeflow.PORT_TOP_INSET clears it). */
export const NODE_HEADER_H = 24;
/** Type sizes. Small: this is chrome, not content. */
export const NODE_TITLE_SIZE = 12;
export const NODE_PORT_LABEL_SIZE = 10;
export const NODE_VALUE_SIZE = 22;
/** Horizontal padding from a node's edge to its text. */
export const NODE_PAD = 10;
/** The gap between a bead and its label — the label clears the bead's radius. */
export const PORT_LABEL_GAP = PORT_BEAD_R + 5;
/** The bead's dark core radius as a fraction of the bead: a filled ring, not a
 *  flat dot, so a bead reads as a SOCKET (something a wire enters) rather than as
 *  a decoration. Audulus's ports do exactly this. */
export const BEAD_CORE_FRACTION = 0.45;

// ── NODE FAMILIES (NF-BIND) ─────────────────────────────────────────────────

/**
 * THE FAMILY TABLE — the ONE place a node family's identity is defined.
 *
 * ── THE PROBLEM A FAMILY SOLVES ─────────────────────────────────────────────
 * The audio module set is 23 nodes and the user expects "upwards of a hundred"
 * (ADDENDUM 3). At that count a patch stops being readable as a graph: every card
 * is the same dark rectangle, so finding the reverb in a wall of nodes means
 * reading 40 title bars. The user asked for "visually distinct cool-looking
 * modules like the noise module, the reverb module, the echo module" (founding
 * message) — distinct, so the eye can sort them.
 *
 * ── AND THE PROBLEM A FAMILY MUST NOT CREATE ────────────────────────────────
 * User ruling, ADDENDUM 6, verbatim: "you gotta make sure that because you're
 * Claude, you don't get gouty and disgusting. So actually, Audulous ... is great
 * for inspiration for aesthetics."
 *
 * Twenty-three individually-coloured cards IS the gaudy failure. So the
 * discipline here is deliberately narrow, and every part of it is a restriction:
 *
 *   SIX FAMILIES, NOT 23 COLOURS. Colour sorts nodes into KINDS — sources,
 *     filters, effects, modulation, analysis, output. A hundred modules still
 *     only ever wear six accents, so the palette cannot grow with the catalogue.
 *   THE ACCENT IS A HEADER TINT AND A RIM, NEVER THE BODY. The body stays
 *     NODE_BODY for every node in the app, audio or not. That single shared
 *     value is what keeps a patch reading as one family of objects; tinting
 *     bodies would produce the candy wall the ruling forbids.
 *   THE TINTS ARE DESATURATED AND DARK. Each is a small step off NODE_HEADER,
 *     not a saturated hue — visible when two families sit side by side, invisible
 *     as "colour" when one sits alone. Audulus's own node chrome is monochrome
 *     line work; this is the smallest departure that buys sorting.
 *   THE PORT BEADS ARE UNTOUCHED. Bead colour means TYPE (the user's ruling,
 *     ADDENDUM 7) and nothing else. A family that recoloured its beads would
 *     overload the one signal that has to stay literal.
 *
 * `glyph` is a single character drawn at the header's right — a second,
 * colour-blind-safe channel for the same distinction, and the thing that actually
 * reads at the zoom where a whole patch fits on a slide and the title text does
 * not.
 */
export const NODE_FAMILIES = Object.freeze({
  /** SOURCES generate signal from nothing: oscillators, noise, samplers, the pad
   *  and the ding. Warm amber — the family that starts a chain. */
  source: Object.freeze({ label: "Source", header: "#3a3020", rim: "#7a6338", glyph: "∿" }),
  /** FILTERS shape a spectrum that already exists: filter, EQ, quantize, bitcrush.
   *  Cool teal, the complement of source — a chain reads warm→cool left to right. */
  filter: Object.freeze({ label: "Filter", header: "#1e3330", rim: "#3d7a6e", glyph: "⋀" }),
  /** EFFECTS act on time and space rather than on spectrum: delay, reverb. Violet,
   *  the family the user's "spacey ambience" lives in. */
  effect: Object.freeze({ label: "Effect", header: "#2b2440", rim: "#6b5aa8", glyph: "◇" }),
  /** MODULATION drives other nodes rather than being heard: LFO, ADSR, clock,
   *  sequencer, sample+hold, trigger, VCA, mixer. Muted blue — the control plane. */
  modulation: Object.freeze({ label: "Modulation", header: "#1f2b40", rim: "#4a6da8", glyph: "◠" }),
  /** ANALYSIS measures without changing: meter, spectrum. Near-neutral green, the
   *  instrument-panel family — these are the nodes with live overlays. */
  analysis: Object.freeze({ label: "Analysis", header: "#1f3326", rim: "#4a8a5c", glyph: "▤" }),
  /** OUTPUT is where sound leaves. Deliberately the most saturated rim in the
   *  table, because there is normally ONE of these and it is the node you look for
   *  first when a patch is silent. */
  output: Object.freeze({ label: "Output", header: "#3a2430", rim: "#a8557a", glyph: "◉" }),
});

/** Every declared family name — for validation sweeps and the plugin roster test. */
export const NODE_FAMILY_NAMES = Object.freeze(Object.keys(NODE_FAMILIES));

/**
 * Pure function. A family's chrome record, or the NEUTRAL default for a node that
 * declares none.
 *
 * The default is the plain (non-audio) node look — NODE_HEADER with NODE_RIM — so
 * the proof trio in plugins/node_*.js renders BYTE-IDENTICALLY to how it did
 * before families existed. A family is an opt-in a node CHOOSES; the absence of
 * one is not an error and must not be a different picture.
 *
 * @param {string} [name] - a NODE_FAMILIES key
 * @returns {{label: string, header: string, rim: string, glyph: string|null}}
 *
 * @example nodeFamily("effect").rim // "#6b5aa8"
 * @example nodeFamily("analysis").glyph // "▤"
 * @example // an undeclared family falls back to the neutral node look, not to an error
 * @example nodeFamily().header === NODE_HEADER // true
 * @example nodeFamily("nonsense").rim === NODE_RIM // true
 */
export function nodeFamily(name) {
  return NODE_FAMILIES[name] ?? { label: "Node", header: NODE_HEADER, rim: NODE_RIM, glyph: null };
}

/**
 * Pure function. The node CARD in a FAMILY's colours — nodeCard's audio-aware
 * sibling, and the one every plugins/audio_*.js emits.
 *
 * Identical geometry to nodeCard (same body, same header height, same radius, same
 * title position) so a family node and a plain node are the SAME OBJECT at
 * different tints rather than two different card designs. What it adds is exactly
 * three things: the header wears the family tint, the family glyph sits at the
 * header's right, and the caller gets a matching rim from familyRim().
 *
 * The glyph is placed from the RIGHT edge so it never collides with a long title:
 * a title that would overrun simply clips against it, which is the honest signal
 * that the node is too narrow.
 *
 * @param {object} s - the folded item state (w/h size the card)
 * @param {string} title - the node's display name
 * @param {string} [family] - a NODE_FAMILIES key; absent = the neutral node look
 * @returns {object[]} display-list commands, LOCAL coords
 *
 * @example familyCard({w: 140, h: 90}, "Reverb", "effect").length // 5
 * @example familyCard({w: 140, h: 90}, "Reverb", "effect")[3].text // "Reverb"
 * @example familyCard({w: 140, h: 90}, "Reverb", "effect")[4].text // "◇"
 * @example // a family-less card is the plain one plus nothing: no glyph op at all
 * @example familyCard({w: 140, h: 90}, "Plain").length // 4
 */
export function familyCard(s, title, family) {
  const f = nodeFamily(family);
  const w = s.w ?? 0, h = s.h ?? 0;
  const ops = [
    rect({ x: 0, y: 0, w, h, cornerRadius: NODE_RADIUS, fill: NODE_BODY }),
    rect({ x: 0, y: 0, w, h: NODE_HEADER_H, cornerRadius: NODE_RADIUS, fill: f.header }),
    rect({ x: 0, y: NODE_HEADER_H - NODE_RADIUS, w, h: NODE_RADIUS, fill: f.header }),
    text({ text: title, x: NODE_PAD, y: NODE_HEADER_H / 2 + NODE_TITLE_SIZE / 3, size: NODE_TITLE_SIZE, color: NODE_TITLE_INK, bold: true }),
  ];
  if (f.glyph) ops.push(text({
    text: f.glyph,
    x: 0,
    y: NODE_HEADER_H / 2 + NODE_TITLE_SIZE / 3,
    size: NODE_TITLE_SIZE,
    color: f.rim,
    boxW: Math.max(0, w - NODE_PAD),
    boxStyle: { align: "right" },
  }));
  return ops;
}

/**
 * Pure function. The card's rim in a FAMILY's colour — nodeRim's family-aware
 * sibling, emitted LAST for the same reason nodeRim is.
 *
 * @param {object} s - the folded item state
 * @param {string} [family] - a NODE_FAMILIES key
 * @returns {object[]} display-list commands
 *
 * @example familyRim({w: 140, h: 90}, "output").length // 1
 * @example familyRim({w: 140, h: 90}, "output")[0].op // "rect"
 * @example // ir.js parses colours to RGBA floats at construction; alpha 1 = opaque
 * @example familyRim({w: 140, h: 90}, "output")[0].stroke[3] // 1
 */
export function familyRim(s, family) {
  return [rect({ x: 0, y: 0, w: s.w ?? 0, h: s.h ?? 0, cornerRadius: NODE_RADIUS, fill: null, stroke: nodeFamily(family).rim, strokeWidth: NODE_RIM_WIDTH })];
}

/**
 * Pure function. The node CARD: body, title strip, rim, title text. Every node
 * widget emits this first, so a patch is visually one family.
 *
 * The title strip is drawn as a rounded rect the same radius as the body and then
 * squared off at its bottom by a plain rect, rather than as a clipped path: two
 * cheap ops with no clip beat one op the PDF/SVG exporters would have to emulate.
 *
 * @param {object} s - the folded item state (w/h size the card)
 * @param {string} title - the node's display name (its title bar text)
 * @returns {object[]} display-list commands, LOCAL coords
 *
 * @example nodeCard({w: 120, h: 80}, "Add").length // 4
 * @example nodeCard({w: 120, h: 80}, "Add")[0].op // "rect"
 * @example nodeCard({w: 120, h: 80}, "Add")[3].text // "Add"
 */
export function nodeCard(s, title) {
  const w = s.w ?? 0, h = s.h ?? 0;
  return [
    rect({ x: 0, y: 0, w, h, cornerRadius: NODE_RADIUS, fill: NODE_BODY }),
    // The header: rounded at the top (shares the card's radius), squared at the
    // bottom by overlapping the body's own fill for the lower half.
    rect({ x: 0, y: 0, w, h: NODE_HEADER_H, cornerRadius: NODE_RADIUS, fill: NODE_HEADER }),
    rect({ x: 0, y: NODE_HEADER_H - NODE_RADIUS, w, h: NODE_RADIUS, fill: NODE_HEADER }),
    text({ text: title, x: NODE_PAD, y: NODE_HEADER_H / 2 + NODE_TITLE_SIZE / 3, size: NODE_TITLE_SIZE, color: NODE_TITLE_INK, bold: true }),
  ];
}

/**
 * Pure function. The node card's RIM, emitted LAST so it draws over the header
 * seam and over any port bead that straddles the edge. Separated from nodeCard so
 * a plugin can put its own content between the two and still have the rim on top —
 * which is what makes the card read as a container rather than as a stack.
 *
 * @param {object} s - the folded item state
 * @returns {object[]} display-list commands
 *
 * @example nodeRim({w: 120, h: 80}).length // 1
 * @example nodeRim({w: 120, h: 80})[0].op // "rect"
 * @example // ir.js PARSES every colour at op construction, so the op carries RGBA
 * @example // floats, not the hex the caller passed. Alpha 1 = the rim is opaque.
 * @example nodeRim({w: 120, h: 80})[0].stroke[3] // 1
 */
export function nodeRim(s) {
  return [rect({ x: 0, y: 0, w: s.w ?? 0, h: s.h ?? 0, cornerRadius: NODE_RADIUS, fill: null, stroke: NODE_RIM, strokeWidth: NODE_RIM_WIDTH })];
}

/**
 * Pure function. Every PORT BEAD and its label, drawn from the ONE layout
 * (core/nodeflow.portLayout) that hit-testing also reads — so a bead cannot be
 * painted anywhere other than where it can be grabbed.
 *
 * A bead is a filled ring in its TYPE's color (the user's ruling that color
 * indicates type) with a dark core: the ring says "socket", the color says "what
 * fits". Labels sit INSIDE the card, beside their bead — an input's label runs
 * right from the left edge, an output's runs left from the right edge.
 *
 * @param {object} plugin - the node's own plugin (for its port declaration)
 * @param {object} s - the folded item state
 * @returns {object[]} display-list commands
 *
 * @example // three ops per port: the coloured ring, its dark core, and the label
 * @example portBeads({ports: () => ({inputs: [{key: "a", type: "number"}]})}, {w: 120, h: 80}).length // 3
 * @example portBeads({ports: () => ({inputs: [{key: "a", type: "number"}]})}, {w: 120, h: 80})[0].op // "ellipse"
 * @example // the ring is painted in the PORT TYPE's colour (ir.js has parsed it to RGBA)
 * @example portBeads({ports: () => ({inputs: [{key: "a", type: "number"}]})}, {w: 120, h: 80})[0].fill[2] > 0.9 // true
 * @example portBeads({}, {w: 120, h: 80}) // []
 */
export function portBeads(plugin, s) {
  const ops = [];
  for (const p of portLayout(plugin, s)) {
    const color = portColor(p.type);
    ops.push(ellipse({ cx: p.x, cy: p.y, rx: PORT_BEAD_R, ry: PORT_BEAD_R, fill: color }));
    ops.push(ellipse({ cx: p.x, cy: p.y, rx: PORT_BEAD_R * BEAD_CORE_FRACTION, ry: PORT_BEAD_R * BEAD_CORE_FRACTION, fill: NODE_BODY }));
    // The label reads INWARD from its own edge. `boxW`/`boxStyle` are left at
    // their defaults: these are one-word names, and a wrapped port label would
    // mean the node is too narrow, which is a sizing problem to see rather than
    // to hide.
    const isInput = p.side === "input";
    ops.push(text({
      text: p.label,
      x: isInput ? p.x + PORT_LABEL_GAP : p.x - PORT_LABEL_GAP,
      y: p.y + NODE_PORT_LABEL_SIZE / 3,
      size: NODE_PORT_LABEL_SIZE,
      color: NODE_PORT_INK,
      boxW: Math.max(0, (s.w ?? 0) / 2 - PORT_LABEL_GAP),
      boxStyle: isInput ? null : { align: "right" },
    }));
  }
  return ops;
}

/**
 * Pure function. The big VALUE READOUT a node shows in its body — the number a
 * source is emitting, the result a math node computed, the input a display
 * received. Centred in the space below the header, so a node with no ports on a
 * row still reads as a card with a number in it.
 *
 * @param {object} s - the folded item state
 * @param {string} str - the already-formatted string to show
 * @param {number} [y] - LOCAL baseline y; defaults to just below the header
 * @returns {object[]} display-list commands
 *
 * @example nodeValueText({w: 120, h: 80}, "6").length // 1
 * @example nodeValueText({w: 120, h: 80}, "6")[0].text // "6"
 * @example nodeValueText({w: 120, h: 80}, "6")[0].boxStyle.align // "center"
 */
export function nodeValueText(s, str, y) {
  const w = s.w ?? 0, h = s.h ?? 0;
  return [text({
    text: str,
    x: 0,
    y: y ?? (NODE_HEADER_H + h) / 2 + NODE_VALUE_SIZE / 3,
    size: NODE_VALUE_SIZE,
    color: NODE_VALUE_INK,
    boxW: w,
    boxStyle: { align: "center" },
  })];
}

/**
 * Pure function. Formats a number for a node readout: up to `decimals` places,
 * with trailing zeros TRIMMED, so 6 shows as "6" and 6.5 as "6.5" rather than as
 * "6.00" and "6.50". A node's readout is a glance, not a table column — fixed
 * decimals turn every integer into visual noise.
 *
 * A non-finite value shows as its mathematical name rather than as "NaN" leaking
 * from a formatter: it is a real answer (a division by zero) and reads better than
 * a blank.
 *
 * @param {number} v - the value
 * @param {number} [decimals] - maximum fractional places
 * @returns {string}
 *
 * @example formatNodeValue(6) // "6"
 * @example formatNodeValue(6.5) // "6.5"
 * @example formatNodeValue(1 / 3) // "0.333"
 * @example formatNodeValue(1 / 0) // "∞"
 * @example formatNodeValue(-1 / 0) // "-∞"
 * @example formatNodeValue(0 / 0) // "—"
 */
export function formatNodeValue(v, decimals = 3) {
  if (Number.isNaN(v)) return "—";
  if (v === Infinity) return "∞";
  if (v === -Infinity) return "-∞";
  return String(Number(Number(v).toFixed(decimals)));
}
