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

import { ellipse, path, rect, text } from "../render_gpu/ir.js";
import { NODE_CORNER_R, PORT_BEAD_R, portColor, portLayout, wireBezierPath } from "./nodeflow.js";
import {
  KNOB_LABEL_GAP, KNOB_LABEL_SIZE, KNOB_PITCH_X, KNOB_R, KNOB_TRACK_WIDTH, knobRadius,
  KNOB_VALUE_SIZE, knobArcPath, knobPoint, knobReadout,
} from "./node_knobs.js";

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
 * `mark` is a small DRAWN emblem at the header's right — a second,
 * colour-blind-safe channel for the same distinction, and the thing that actually
 * reads at the zoom where a whole patch fits on a slide and the title text does
 * not.
 *
 * ── IT IS A PATH AND NOT A CHARACTER, AND THAT IS WORKSTREAM CA ─────────────
 * User, 2026-08-03, verbatim: "The text of these widgets it not placed in the top
 * right. Why many say "No Glyph"?"
 *
 * This table used to hold a `glyph`: one Unicode character per family — ∿ (U+223F
 * SINE WAVE), ⋀ (U+22C0 N-ARY LOGICAL AND), ◇, ◠ (U+25E0 UPPER HALF CIRCLE), ▤,
 * ◉ — typeset by the ordinary text op at the header's right. Three of those six
 * are in NO face PowerRP registers. MEASURED with fontkit against every file in
 * fonts/: Inter (the `system` stand-in) and Noto Sans have none of the six;
 * ◇ ▤ ◉ survive only because the CJK fallbacks (Noto Sans JP/SC/KR) happen to
 * carry them; ∿ ⋀ ◠ are in nothing at all. Skia's fallback therefore found no
 * face, drew the font's .notdef box, and at 12pt a .notdef box is a narrow tall
 * rectangle — the "tiny illegible VERTICAL text badge" in the corner of every
 * source, filter and modulation node. The literal words "No Glyph" are nowhere in
 * this codebase and nowhere in a library string either; they are what a reader
 * says about a tofu box, which is the honest reading of a mark the font could not
 * supply.
 *
 * The three that DID render were not healthy either: they came from a CJK face at
 * that face's metrics, so `▤` sat a third of a line lower than `◇` and overflowed
 * the 24-unit header strip.
 *
 * So the emblem is now VECTOR. A path in a unit box cannot be missing, cannot
 * arrive from a different face with different metrics, and cannot change with the
 * fonts a machine has — which matters twice over here, because the same display
 * list is painted by Skia in the editor, by the PDF and SVG exporters, and by
 * bare-node cli/render.js. A picture that depended on font coverage was a picture
 * that could differ between those four, and the determinism law does not allow it.
 */
export const NODE_FAMILIES = Object.freeze({
  /** SOURCES generate signal from nothing: oscillators, noise, samplers, the pad
   *  and the ding. Warm amber — the family that starts a chain.
   *  MARK: a sine wave — the signal a source makes out of nothing. */
  source: Object.freeze({
    label: "Source", header: "#3a3020", rim: "#7a6338",
    mark: "M 0 0.5 C 0.17 0.05, 0.33 0.05, 0.5 0.5 C 0.67 0.95, 0.83 0.95, 1 0.5",
  }),
  /** FILTERS shape a spectrum that already exists: filter, EQ, quantize, bitcrush.
   *  Cool teal, the complement of source — a chain reads warm→cool left to right.
   *  MARK: a resonant lowpass response — flat, a peak, then the roll-off. */
  filter: Object.freeze({
    label: "Filter", header: "#1e3330", rim: "#3d7a6e",
    mark: "M 0 0.35 L 0.45 0.35 L 0.62 0.05 L 1 0.95",
  }),
  /** EFFECTS act on time and space rather than on spectrum: delay, reverb. Violet,
   *  the family the user's "spacey ambience" lives in.
   *  MARK: a diamond — the ◇ the table used to spell, now drawn. */
  effect: Object.freeze({
    label: "Effect", header: "#2b2440", rim: "#6b5aa8",
    mark: "M 0.5 0 L 1 0.5 L 0.5 1 L 0 0.5 Z",
  }),
  /** MODULATION drives other nodes rather than being heard: LFO, ADSR, clock,
   *  sequencer, sample+hold, trigger, VCA, mixer. Muted blue — the control plane.
   *  MARK: a rising ramp into a hold — an envelope, the shape of a control. */
  modulation: Object.freeze({
    label: "Modulation", header: "#1f2b40", rim: "#4a6da8",
    mark: "M 0 0.95 L 0.35 0.05 L 0.65 0.05 L 1 0.95",
  }),
  /** ANALYSIS measures without changing: meter, spectrum. Near-neutral green, the
   *  instrument-panel family — these are the nodes with live overlays.
   *  MARK: three stacked bars — a level meter's static form. */
  analysis: Object.freeze({
    label: "Analysis", header: "#1f3326", rim: "#4a8a5c",
    mark: "M 0 0.12 L 1 0.12 M 0 0.5 L 1 0.5 M 0 0.88 L 1 0.88",
  }),
  /** OUTPUT is where sound leaves. Deliberately the most saturated rim in the
   *  table, because there is normally ONE of these and it is the node you look for
   *  first when a patch is silent.
   *  MARK: a ring — the jack sound leaves through. */
  output: Object.freeze({
    label: "Output", header: "#3a2430", rim: "#a8557a",
    mark: "M 0.5 0.02 A 0.48 0.48 0 1 1 0.4999 0.02 Z",
  }),
});

/** The family mark's box, in LOCAL units: a square whose right edge sits one
 *  NODE_PAD in from the card's right and which is vertically centred in the
 *  header strip. Sized to the title's cap height so the two read as one line of
 *  chrome rather than as a badge stuck on afterwards. */
export const NODE_MARK_SIZE = 9;
/** The mark's stroke width. One hairline, like the rim — the emblem is chrome. */
export const NODE_MARK_STROKE = 1.4;

/**
 * Pure function. A family MARK's display-list op, placed in a node's header.
 *
 * The `mark` path is authored in a UNIT BOX (0..1 in both axes) so the table
 * states a SHAPE and this function states its SIZE and PLACE — the same split
 * every other piece of chrome here uses, and what lets the mark be re-sized in
 * one number rather than by re-authoring six paths.
 *
 * Stroked and not filled, with one exception per shape: the diamond and the ring
 * are closed and read as solid emblems, so they carry a fill too. A stroke-only
 * mark at 9 units is a line drawing, which is the Audulus register (ADDENDUM 6)
 * and stays quiet in a wall of forty cards.
 *
 * @param {object} s - the folded item state (its `w` finds the right edge)
 * @param {string} [family] - a NODE_FAMILIES key; absent = no mark at all
 * @returns {object[]} display-list commands, LOCAL coords (empty for no family)
 *
 * @example familyMarkOps({w: 150, h: 90}, "effect").length // 1
 * @example familyMarkOps({w: 150, h: 90}, "effect")[0].op // "path"
 * @example // the unit path is scaled and translated into the header's right end
 * @example familyMarkOps({w: 150, h: 90}, "effect")[0].d.startsWith("M 135") // true
 * @example // a family-less card gets no mark op at all — byte-identical to before
 * @example familyMarkOps({w: 150, h: 90}) // []
 * @example // FLIP-SAFE: a negative width is a REFLECTION, and the mark still lands
 * @example // at the card's right end rather than off the left of the world
 * @example familyMarkOps({w: -150, h: 90}, "effect")[0].d === familyMarkOps({w: 150, h: 90}, "effect")[0].d // true
 */
export function familyMarkOps(s, family) {
  const f = nodeFamily(family);
  if (!f.mark) return [];
  // THE RESOLVED WIDTH. A stored `w` may be NEGATIVE — a REFLECTION, how Flip H
  // is stored — and a plugin never sees the sign (CLAUDE.md's NEGATIVE EXTENTS
  // law). emit() receives RAW folded state, one of the pre-derivation readers the
  // law names, so the sign is resolved here.
  const w = Math.abs(s?.w ?? 0);
  const x0 = w - NODE_PAD - NODE_MARK_SIZE;
  const y0 = (NODE_HEADER_H - NODE_MARK_SIZE) / 2;
  // CLOSED marks (the ones whose path ends in Z) are emblems and take a fill at
  // the family's own rim colour; open ones are line drawings and take only the
  // stroke. One rule read off the path itself, so a new family cannot forget it.
  const closed = f.mark.trimEnd().endsWith("Z");
  return [path({
    d: scaleUnitPath(f.mark, x0, y0, NODE_MARK_SIZE),
    fill: closed ? f.rim : null,
    stroke: f.rim,
    strokeWidth: NODE_MARK_STROKE,
  })];
}

/**
 * Pure function. A unit-box SVG path (`0..1` in both axes) placed at `(x, y)` and
 * scaled to `size` — the one transform between a family's authored shape and the
 * card it lands on.
 *
 * Only the commands the mark table uses are handled: M, L, C, A and Z. That is
 * deliberate rather than lazy — an UNKNOWN command THROWS rather than passing
 * through unscaled, because a silently unscaled subpath would draw a unit-sized
 * smudge at the card's corner and look like a rendering bug rather than like the
 * authoring mistake it is.
 *
 * The arc command's first two numbers are RADII and its next three are flags, so
 * they scale on different rules — radii by `size`, flags not at all, and the
 * endpoint like any other point. Getting that wrong is why this is a function
 * with a test rather than a regex.
 *
 * @param {string} d - an SVG path in the unit box
 * @param {number} x - LOCAL x of the box's left edge
 * @param {number} y - LOCAL y of the box's top edge
 * @param {number} size - the box's side length in LOCAL units
 * @returns {string} an SVG path in LOCAL units
 *
 * @example scaleUnitPath("M 0 0 L 1 1", 10, 20, 4) // "M 10 20 L 14 24"
 * @example scaleUnitPath("M 0.5 0 L 1 0.5 Z", 0, 0, 10) // "M 5 0 L 10 5 Z"
 * @example // a cubic's three control points all scale
 * @example scaleUnitPath("M 0 0 C 0 1, 1 0, 1 1", 0, 0, 2) // "M 0 0 C 0 2, 2 0, 2 2"
 * @example // an arc scales its RADII and its endpoint but never its three flags
 * @example scaleUnitPath("M 0.5 0 A 0.5 0.5 0 1 1 0.5 1", 0, 0, 10) // "M 5 0 A 5 5 0 1 1 5 10"
 * @example // an unhandled command is an authoring error and says so
 * @example // scaleUnitPath("M 0 0 Q 1 1 0 1", 0, 0, 4) // throws
 */
export function scaleUnitPath(d, x, y, size) {
  const round = (n) => Number(n.toFixed(4));
  const px = (n) => round(x + n * size);
  const py = (n) => round(y + n * size);
  const tokens = String(d).trim().split(/[\s,]+/);
  const out = [];
  let i = 0;
  const num = () => Number(tokens[i++]);
  while (i < tokens.length) {
    const cmd = tokens[i++];
    switch (cmd) {
      case "M": case "L": out.push(cmd, px(num()), py(num())); break;
      case "C": {
        const c = [px(num()), py(num()), px(num()), py(num()), px(num()), py(num())];
        out.push("C", `${c[0]} ${c[1]},`, `${c[2]} ${c[3]},`, `${c[4]} ${c[5]}`);
        break;
      }
      case "A": {
        // rx ry rotation largeArc sweep x y — the middle three are FLAGS/degrees
        // and must pass through untouched.
        const rx = round(num() * size), ry = round(num() * size);
        const rot = tokens[i++], large = tokens[i++], sweep = tokens[i++];
        out.push("A", rx, ry, rot, large, sweep, px(num()), py(num()));
        break;
      }
      case "Z": out.push("Z"); break;
      default:
        throw new Error(`scaleUnitPath: unhandled SVG path command ${JSON.stringify(cmd)} in ${JSON.stringify(d)} — the node family mark table uses only M, L, C, A and Z`);
    }
  }
  return out.join(" ");
}

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
 * @returns {{label: string, header: string, rim: string, mark: string|null}}
 *
 * @example nodeFamily("effect").rim // "#6b5aa8"
 * @example nodeFamily("analysis").mark.startsWith("M 0 0.12") // true
 * @example // an undeclared family falls back to the neutral node look, not to an error
 * @example nodeFamily().header === NODE_HEADER // true
 * @example nodeFamily("nonsense").rim === NODE_RIM // true
 * @example nodeFamily().mark // null
 */
export function nodeFamily(name) {
  return NODE_FAMILIES[name] ?? { label: "Node", header: NODE_HEADER, rim: NODE_RIM, mark: null };
}

/**
 * Pure function. The node CARD in a FAMILY's colours — nodeCard's audio-aware
 * sibling, and the one every plugins/audio_*.js emits.
 *
 * Identical geometry to nodeCard (same body, same header height, same radius, same
 * title position) so a family node and a plain node are the SAME OBJECT at
 * different tints rather than two different card designs. What it adds is exactly
 * three things: the header wears the family tint, the family MARK sits at the
 * header's right, and the caller gets a matching rim from familyRim().
 *
 * ── THE TITLE IS BOXED SO IT CANNOT RUN UNDER THE MARK (workstream CA) ──────
 * The title used to be an unbounded text op, and the mark an unbounded one drawn
 * right-aligned over the same strip. Two unbounded runs on one line means the
 * longer title simply draws THROUGH the emblem — "Ambience Pad" on a 150-wide
 * card reaches within a few units of it, and any longer name overlaps. The title
 * now carries a `boxW` that stops one gap short of the mark's left edge, so a
 * name too long for its card CLIPS rather than colliding, which is the signal the
 * registry docblock asks for rather than one to hide. A family-LESS card keeps
 * the full width, so the plain node trio is byte-identical to before.
 *
 * @param {object} s - the folded item state (w/h size the card)
 * @param {string} title - the node's display name
 * @param {string} [family] - a NODE_FAMILIES key; absent = the neutral node look
 * @returns {object[]} display-list commands, LOCAL coords
 *
 * @example familyCard({w: 140, h: 90}, "Reverb", "effect").length // 5
 * @example familyCard({w: 140, h: 90}, "Reverb", "effect")[3].text // "Reverb"
 * @example // the fifth op is the DRAWN mark, not a typeset character
 * @example familyCard({w: 140, h: 90}, "Reverb", "effect")[4].op // "path"
 * @example // a family-less card is the plain one plus nothing: no mark op at all
 * @example familyCard({w: 140, h: 90}, "Plain").length // 4
 * @example // and its title keeps the full unbounded width it always had
 * @example familyCard({w: 140, h: 90}, "Plain")[3].boxW // Infinity
 */
export function familyCard(s, title, family) {
  const f = nodeFamily(family);
  const w = s.w ?? 0, h = s.h ?? 0;
  const markOps = familyMarkOps(s, family);
  // The title's box ends one pad short of the mark's own left edge. With no mark
  // there is nothing to clear, and the box stays Infinity — the pre-CA op exactly.
  const titleBoxW = markOps.length
    ? Math.max(0, Math.abs(w) - NODE_PAD - NODE_MARK_SIZE - NODE_PAD - NODE_PAD)
    : Infinity;
  return [
    rect({ x: 0, y: 0, w, h, cornerRadius: NODE_RADIUS, fill: NODE_BODY }),
    rect({ x: 0, y: 0, w, h: NODE_HEADER_H, cornerRadius: NODE_RADIUS, fill: f.header }),
    rect({ x: 0, y: NODE_HEADER_H - NODE_RADIUS, w, h: NODE_RADIUS, fill: f.header }),
    text({ text: title, x: NODE_PAD, y: NODE_HEADER_H / 2 + NODE_TITLE_SIZE / 3, size: NODE_TITLE_SIZE, color: NODE_TITLE_INK, bold: true, boxW: titleBoxW }),
    ...markOps,
  ];
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

/** The knob's TRACK: the unfilled part of the dial, and the same value as the
 *  card's rim so a dial reads as part of the chrome rather than as content. */
export const KNOB_TRACK_INK = NODE_RIM;
/** The knob's LABEL ink — the port-label grey, because a knob label is the same
 *  kind of thing as a port label and must not shout louder. */
export const KNOB_LABEL_INK = NODE_PORT_INK;
/** The pointer line's ink. The brightest thing on the dial, because it is the
 *  one part you actually read at a glance. */
export const KNOB_POINTER_INK = NODE_VALUE_INK;
/** The pointer's inner end, as a fraction of the dial radius: it is a stub from
 *  the rim inward, not a spoke from the centre — an Audulus dial's pointer does
 *  not cross its own hub, and a full spoke turns the dial into a clock face. */
export const KNOB_POINTER_INNER = 0.45;
/** The FOCUS RING's radius beyond the dial, drawn only in knob focus. */
export const KNOB_FOCUS_GAP = 4;
/** The gap between one knob label's box and the next. Without it adjacent labels
 *  abut and a row of four reads as one sentence. */
export const KNOB_LABEL_GUTTER = 6;

/**
 * Pure function. The display-list ops for one node's KNOBS — the dials on a
 * module's face (core/node_knobs.js states the design and the founding ask).
 *
 * ── THIS RUNS IN emit(), SO IT IS DOCUMENT STATE ONLY ───────────────────────
 * The dial's ANGLE comes from the folded knob value and nothing else, so a knob
 * paints identically in the editor, in a PNG export, in the PDF and in bare-node
 * cli/render.js, and Δt = 0 produces the same picture twice. Nothing here reads
 * a clock, an engine or a pointer.
 *
 * The `ui` argument is the ONE exception and it is why the parameter is optional
 * and defaulted to `{}`: a focus ring and a live readout are TRANSIENT EDITOR
 * STATE (which knob the pointer is on), not document state, so `emit()` never
 * passes it — every pixel consumer gets `{}` and the honest static dial. It
 * exists because web/AudioOverlay.svelte paints the same knobs into its
 * screen-space layer, the seam wave 2 established for the live meters, and
 * building that overlay from THIS function is what stops the focused dial from
 * being drawn a second, slightly different way.
 *
 * ── WHAT IS DRAWN, AND WHAT IS DELIBERATELY NOT ─────────────────────────────
 * Four ops per knob: the track arc, the value arc, the pointer stub, the label.
 * A fifth (the live value readout) appears only for the knob being TURNED,
 * because a number under every dial is a wall of digits at the zoom where a
 * whole patch fits on a slide — and the number matters exactly while you are
 * changing it. No tick marks, no hub circle, no bevel, no shadow: ADDENDUM 6's
 * "don't get gouty and disgusting", spent where it is cheapest to obey.
 *
 * `accent` is the node's FAMILY rim colour, so a knob's fill is the same one
 * accent its card already wears — the palette does not grow with the knob count,
 * which is the same discipline NODE_FAMILIES states for the cards.
 *
 * @param {Array<object>} layout - from core/node_knobs.knobLayout
 * @param {string} accent - the value arc's colour (the node's family rim)
 * @param {{focusKey?: string|null, activeKey?: string|null}} [ui] - transient
 *        editor state: which knob wears the focus ring, which is being turned
 * @returns {object[]} display-list commands, LOCAL coords
 *
 * @example // four ops for one knob: track arc, value arc, pointer, label
 * @example knobOps([{key: "q", label: "Q", cx: 40, cy: 60, min: 0, max: 10, value: 5, fraction: 0.5, unit: ""}], "#6b5aa8").length // 4
 * @example knobOps([{key: "q", label: "Q", cx: 40, cy: 60, min: 0, max: 10, value: 5, fraction: 0.5, unit: ""}], "#6b5aa8")[3].text // "Q"
 * @example // the FOCUSED knob gains a fifth op: the ring behind its dial
 * @example knobOps([{key: "q", label: "Q", cx: 40, cy: 60, min: 0, max: 10, value: 5, fraction: 0.5, unit: ""}], "#6b5aa8", {focusKey: "q"}).length // 5
 * @example // the one being TURNED wears the ring AND its live readout — six
 * @example knobOps([{key: "q", label: "Q", cx: 40, cy: 60, min: 0, max: 10, value: 5, fraction: 0.5, unit: ""}], "#6b5aa8", {activeKey: "q"}).length // 6
 * @example knobOps([{key: "q", label: "Q", cx: 40, cy: 60, min: 0, max: 10, value: 5, fraction: 0.5, unit: ""}], "#6b5aa8", {activeKey: "q"})[5].text // "5"
 * @example // an UNLABELLED dial (the Knob control node's, whose card title already
 * @example // names it) emits no label op at all — three, not four
 * @example knobOps([{key: "value", label: "", cx: 40, cy: 60, min: 0, max: 1, value: 0.5, fraction: 0.5, unit: ""}], "#6b5aa8").length // 3
 * @example // a record's own `r` sizes its arc: a bigger dial reaches further left
 * @example knobOps([{key: "v", label: "", r: 26, cx: 40, cy: 60, min: 0, max: 1, value: 0, fraction: 0, unit: ""}], "#6b5aa8")[0].d.includes("26") // true
 * @example knobOps([], "#6b5aa8") // []
 */
export function knobOps(layout, accent, ui = {}) {
  const ops = [];
  for (const k of layout) {
    // PER-DIAL RADIUS (BV, 2026-08-03). A module's knob band is many small dials
    // at the shared KNOB_R; the KNOB control node is ONE large dial that is the
    // whole widget. `knobRadius` is the one lookup this painter, core/node_knobs
    // .knobAt and the editor overlay all make, so a dial cannot be drawn at one
    // size and grabbed at another — a defect that is invisible in a screenshot,
    // because the picture looks right and only the click misses.
    const r = knobRadius(k);
    // THE FOCUS RING IS FIRST so everything else draws over it — it is a halo
    // behind the dial, not an outline on top of it.
    if (ui.focusKey === k.key || ui.activeKey === k.key) {
      ops.push(ellipse({
        cx: k.cx, cy: k.cy, rx: r + KNOB_FOCUS_GAP, ry: r + KNOB_FOCUS_GAP,
        fill: null, stroke: accent, strokeWidth: 1,
      }));
    }
    ops.push(path({ d: knobArcPath(k, r, 0, 1), fill: null, stroke: KNOB_TRACK_INK, strokeWidth: KNOB_TRACK_WIDTH }));
    ops.push(path({ d: knobArcPath(k, r, 0, k.fraction), fill: null, stroke: accent, strokeWidth: KNOB_TRACK_WIDTH }));
    const tip = knobPoint(k, r, k.fraction);
    const heel = knobPoint(k, r * KNOB_POINTER_INNER, k.fraction);
    ops.push(path({
      d: `M ${heel.x.toFixed(4)} ${heel.y.toFixed(4)} L ${tip.x.toFixed(4)} ${tip.y.toFixed(4)}`,
      fill: null, stroke: KNOB_POINTER_INK, strokeWidth: 1.5,
    }));
    // THE LABEL BOX IS NARROWER THAN THE PITCH, by one gutter. At the full pitch
    // two adjacent labels touch edge to edge, which on the mixer (four dials in a
    // row, all named "Level N") read as one continuous run of words rather than as
    // four labels — caught by eye on a rendered patch. The inset costs a long
    // label its last character or two, which is the honest signal that the name is
    // too long for the space, and is what the port labels already do.
    //
    // AN EMPTY LABEL EMITS NO OP AT ALL. The KNOB control node's dial is unlabelled
    // (the card's own title says what it is, and a second word under the dial would
    // be the gaudy repetition ADDENDUM 6 refuses). An empty text op is not free —
    // it reaches the glyph atlas and lands in every export's display list.
    //
    // THE PITCH, THE GAP AND THE SIZE COME OFF THE RECORD (workstream CD), for
    // exactly the reason the radius above does. A knob band on a card too short
    // to hold it is drawn SCALED (core/node_knobs.knobBandScale) so it stays
    // inside the box the author dragged; reading the module constants here
    // instead would put a full-size label under a shrunken dial, which is the
    // draw-here/grab-there class of defect one line up, in text. The constants
    // remain the fallback for a hand-built record (the KNOB and SLIDER control
    // nodes), which is unscaled by construction.
    const pitchX = Number.isFinite(k.pitchX) && k.pitchX > 0 ? k.pitchX : KNOB_PITCH_X;
    const labelGap = Number.isFinite(k.labelGap) ? k.labelGap : KNOB_LABEL_GAP;
    const labelSize = Number.isFinite(k.labelSize) && k.labelSize > 0 ? k.labelSize : KNOB_LABEL_SIZE;
    const gutter = KNOB_LABEL_GUTTER * (pitchX / KNOB_PITCH_X);
    if (k.label) {
      ops.push(text({
        text: k.label, x: k.cx - (pitchX - gutter) / 2, y: k.cy + r + labelGap,
        size: labelSize, color: KNOB_LABEL_INK,
        boxW: pitchX - gutter, boxStyle: { align: "center" },
      }));
    }
    if (ui.activeKey === k.key) {
      ops.push(text({
        text: knobReadout(k, k.value), x: k.cx - pitchX / 2,
        y: k.cy + r + labelGap + KNOB_VALUE_SIZE + 1,
        size: KNOB_VALUE_SIZE, color: accent,
        boxW: pitchX, boxStyle: { align: "center" },
      }));
    }
  }
  return ops;
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

// ── THE WIRES (WORKSTREAM BN) ───────────────────────────────────────────────
//
// User ruling, 2026-08-03, verbatim: "the wires between nodes should be shown in
// prsentation mode and pdf rener and png render etc too please".
//
// Until this landed, a wire existed ONLY as an SVG path in the editor's overlay,
// which meant presentation mode and every exporter drew naked nodes joined by
// nothing — the picture the author made, minus the part that says what is
// connected to what. The beads were already scene content
// (portBeads above, painted by each plugin's emit) so an export showed the
// SOCKETS with no cables in them, which reads as a broken patch rather than as a
// missing feature.
//
// WIRES ARE STILL NOT WIDGETS (ADDENDA 7/9 stand untouched). Nothing below
// creates an item, a plugin, or a document leaf. These are display-list ops built
// from geometry that core/derive.deriveWires computed out of the connections
// already stored in node widgets' own state — derived RENDERING of derived
// geometry, exactly as ADDENDUM 9 says ("wires are still rendered, they're just
// not widgets"). The emission owner is render_gpu/ports.sceneIR, the scene
// WALKER, not any plugin: a wire spans TWO nodes, so no single plugin's emit()
// could own it without reading a sibling's state, which the
// no-plugin-imports-plugin law exists to prevent.

/**
 * The wire's stroke width, in WORLD units — the same length space the node cards
 * and their beads live in, so a wire scales with the patch instead of staying a
 * fixed-size piece of UI furniture. Matched to the editor overlay's
 * `--a-wire-width` at 100% zoom, so moving a wire into the scene did not change
 * how thick it looks.
 */
export const WIRE_WIDTH = 2.5;

/**
 * The HALO drawn under each wire, as extra width added to WIRE_WIDTH. A wire
 * crossing a dark node card, or another wire, needs separation from what is
 * behind it; a halo gives that without an outline ON the wire, which would blend
 * into the wire and change the type colour the user is reading.
 */
export const WIRE_HALO_EXTRA = 2;

/**
 * The halo's colour and opacity. THE EDITOR'S HALO IS THE CANVAS COLOUR AND THIS
 * ONE CANNOT BE: `--a-canvas-solid` is a THEME token, and a theme is a property
 * of the person looking at the editor, not of the document. Baking one into a PDF
 * would put the current theme's grey into a printed page, and would put a DARK
 * halo on a white-background slide. So the scene halo is the NODE BODY colour at
 * low alpha instead — the patch's own darkest surface, which is what a wire
 * mostly crosses, and which is a fact about the node chrome rather than about the
 * viewer.
 */
export const WIRE_HALO_INK = NODE_BODY;
export const WIRE_HALO_OPACITY = 0.55;

/**
 * Pure function. The display-list ops for ONE wire, in WORLD space: a halo stroke
 * and the wire itself, both along the same cubic bezier.
 *
 * The wire is drawn in the SOURCE port type's colour — what flows through it,
 * which under a coercion is what it LEAVES as rather than what it arrives as.
 * `deriveWires` already resolved which end that is; this only turns the answer
 * into paint, through the SAME core/nodeflow.portColor table the beads read, so a
 * wire and the beads it joins can never disagree about a type's colour.
 *
 * Emitted at IDENTITY, not inside any node's transform: a wire spans two nodes
 * and belongs to neither, so its endpoints arrive already in world space from
 * core/derive.nodePortAnchors (which is what makes a wire land on a ROTATED or
 * SCALED node's beads with no trigonometry here).
 *
 * @param {object} wire - one core/derive.deriveWires record ({from: {x, y}, to: {x, y}, type})
 * @returns {object[]} display-list commands (halo first, then the wire)
 *
 * @example wireOps({from: {x: 0, y: 0}, to: {x: 200, y: 0}, type: "number"}).length // 2
 * @example wireOps({from: {x: 0, y: 0}, to: {x: 200, y: 0}, type: "number"})[1].d // "M 0 0 C 100 0 100 0 200 0"
 * @example // the halo is the WIDER of the two, and is drawn FIRST so the wire lands on top
 * @example wireOps({from: {x: 0, y: 0}, to: {x: 200, y: 0}, type: "number"}).map((o) => o.strokeWidth) // [4.5, 2.5]
 * @example // the wire carries the SOURCE type's colour (ir.js has parsed it to RGBA)
 * @example wireOps({from: {x: 0, y: 0}, to: {x: 200, y: 0}, type: "audio"})[1].stroke.length // 4
 */
export function wireOps(wire) {
  const d = wireBezierPath(wire.from, wire.to);
  // ROUND CAPS at both ends, matching the editor overlay's `stroke-linecap: round`
  // — a wire's end sits AT its bead's centre, so a flat cap would leave the cable
  // stopping half a bead short of the socket it plugs into.
  const caps = { strokeCapStart: "round", strokeCapEnd: "round" };
  return [
    path({ d, fill: null, stroke: WIRE_HALO_INK, strokeWidth: WIRE_WIDTH + WIRE_HALO_EXTRA, opacity: WIRE_HALO_OPACITY, ...caps }),
    path({ d, fill: null, stroke: portColor(wire.type), strokeWidth: WIRE_WIDTH, ...caps }),
  ];
}

/**
 * Pure function. Every wire in a derived tree as display-list ops, in one flat
 * list — what render_gpu/ports.sceneIR splices in UNDER the nodes.
 *
 * ── WHY UNDER, AND NOT OVER ─────────────────────────────────────────────────
 * A deliberate choice, and the reference node editors (Audulus — the user's
 * stated taste anchor — plus Reaktor, Blender, Nuke, TouchDesigner) all make the
 * same one: wires pass BEHIND the node cards. Three reasons, in order of weight:
 *   THE CARD'S CONTENT IS THE POINT. A node shows a title, a readout, sometimes a
 *     spectrum. A wire crossing OVER it would strike through the number the node
 *     exists to display, and a patch is read by its values.
 *   A WIRE BEHIND A CARD IS SELF-OCCLUDING IN THE RIGHT DIRECTION. It disappears
 *     at the card and re-emerges on the far side, which the eye completes as one
 *     continuous cable. Drawn over, it reads as a scratch across the card.
 *   THE BEAD IS THE JOINT. Beads are painted by each node's own emit(), so they
 *     are node-layer content; a wire ending UNDER its bead tucks into the socket,
 *     while a wire ending OVER it covers the socket it is plugged into.
 * The cost is honest and accepted: a wire routed across a node it does not
 * connect to is hidden behind that node. That is the same trade every reference
 * app makes, and the halo below keeps the visible spans legible where they cross
 * each OTHER (wires are all in one layer, so they do halo against each other).
 *
 * @param {object[]} wires - core/derive.deriveWires output
 * @returns {object[]} display-list commands (two per wire)
 *
 * @example wireLayerOps([]) // []
 * @example wireLayerOps([{from: {x: 0, y: 0}, to: {x: 200, y: 0}, type: "number"}]).length // 2
 * @example // two wires → four ops, and EVERY halo precedes its own wire (one flat layer)
 * @example wireLayerOps([{from: {x: 0, y: 0}, to: {x: 9, y: 0}, type: "number"}, {from: {x: 0, y: 5}, to: {x: 9, y: 5}, type: "audio"}]).map((o) => o.strokeWidth) // [4.5, 2.5, 4.5, 2.5]
 */
export function wireLayerOps(wires) {
  return (wires ?? []).flatMap(wireOps);
}
