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
import { NATURAL_LINE_HEIGHT } from "./richtext.js";
import { NODE_CORNER_R, PORT_BEAD_R, portColor, portColorOf, portLayout, wireBezierPath } from "./nodeflow.js";
import {
  bandFitScale, KNOB_BAND_MIN_SCALE,
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

// ── THE STACK: WHERE A NODE'S OWN CONTENT GOES (R7-10) ──────────────────────
//
// USER, verbatim: "Nodes don't seem to have any coherent way of where you place
// the knobs. Axelotti does investigate that. Because right now, where the knobs
// go is kind of haphazard. There's no guarantee the knobs will even be in the
// node." … "Axolotl does it programmatically and it's amazing and we want that.
// Read their source code."
//
// ── WHAT WAS ACTUALLY WRONG: THREE UNRELATED PLACEMENT SCHEMES ──────────────
// MEASURED (`.frenzy/round7/powerrp_audio_map.md` §B.10) before this section
// existed: the 24 audio modules auto-flowed a knob band that reflowed against
// `h`; plugins/node_knob.js placed ONE dial at `cy = NODE_HEADER_H + 12 + r`,
// constants from the top edge that never read `h` at all; plugins/node_slider.js
// hand-rolled a third rule. Nothing connected them, so a fix to one was invisible
// to the others — which is exactly how the audio family got the reflow in
// workstream CD while the control family never did.
//
// ── THE AXOLOTI RULE, ADAPTED ───────────────────────────────────────────────
// Axoloti's node is a VERTICAL BOX STACK and nothing in an object's declaration
// carries a coordinate: title bar, then the iolet band, then attributes, then
// parameters, then displays, each sized from its own content, and the node's own
// size falls out as the sum (AxoObjectInstance.PostConstructor; the report's Q2).
// A node IS its declaration list.
//
// We adopt the RULE and not the pixels, because two things differ and both are
// deliberate here:
//   OUR PORTS SIT ON THE EDGES, not in a band of their own — a Reaktor-style
//     left-to-right flow the user ruled for in ADDENDUM 1. So the "iolet band"
//     is the vertical extent of the port column, and a node's own face starts
//     BELOW it (`nodeBodyTop`).
//   OUR CARDS ARE RESIZABLE. Axoloti's size is computed and final; ours is a
//     property the author drags, because a node lives on a SLIDE and the slide
//     decides how big it may be. So a declared size cannot be the last word —
//     it is a NATURAL size (what the content wants) and a FLOOR (where the
//     reflow ladder bottoms out), with `nodeFaceBand` reflowing in between.
//
// ── THE LADDER, WHICH IS WORKSTREAM CD'S, GENERALIZED ───────────────────────
// CD settled what a band does on a card too short for it, and that answer is not
// re-litigated here — it is merely made to apply to every node family instead of
// one: (1) sit at the natural top while there is room; (2) SLIDE UP against the
// bottom rim; (3) SHRINK uniformly (core/node_knobs.bandFitScale); (4) past the
// floor, CLIP VISIBLY, because the registry docblock's rule is to show an
// overflow rather than hide it.

/**
 * Pure function. A node's RESOLVED box: `w` and `h` with their signs taken off.
 *
 * THE ONE ENTRANCE for every node face, and the reason it exists is a law:
 * CLAUDE.md's NEGATIVE EXTENTS contract says a stored `w`/`h` MAY BE NEGATIVE
 * (that is a REFLECTION, how Flip H/V is stored) and a plugin never sees the
 * sign. `emit()` receives RAW folded state, which is one of the pre-derivation
 * readers the law names, so each node face had to resolve the sign ITSELF — and
 * MEASURED, four of them did not: `plugins/node_knob.js` put a flipped dial at
 * negative x, and the slider's track, the button's face and the keyboard's face
 * all did the same arithmetic. One shared entrance is what stops the fifth.
 *
 * `h` stays UNDEFINED when the state does not state one, and that is not the
 * same as zero: a caller asking for a band's SHAPE with no card in hand has said
 * nothing about the card (the reading core/node_knobs.knobBandScale and
 * core/nodeflow.portPitchFor already make, for the same reason).
 *
 * @param {object} s - the folded item state
 * @returns {{w: number, h: number|undefined}} LOCAL, sign-resolved
 *
 * @example nodeBox({w: 150, h: 90}) // {w: 150, h: 90}
 * @example // a FLIP is a reflection, not a negative size
 * @example nodeBox({w: -150, h: -90}) // {w: 150, h: 90}
 * @example // an unstated height stays unstated
 * @example nodeBox({w: 150}).h // undefined
 * @example nodeBox() // {w: 0, h: undefined}
 */
export function nodeBox(s) {
  const w = Number(s?.w);
  const h = Number(s?.h);
  return { w: Number.isFinite(w) ? Math.abs(w) : 0, h: Number.isFinite(h) ? Math.abs(h) : undefined };
}

/**
 * Pure function. The vertical space ONE LINE of type occupies.
 *
 * ── A TEXT OP'S `y` IS ITS LINE-BOX TOP, NOT A BASELINE, AND THAT WAS THE BUG ─
 * MEASURED on a rendered still (2026-08-06, W1-D): every text placement in the
 * node chrome added `size / 3` to a y "so the glyphs sit above it", and the
 * docblocks explained the choice at length. The renderer does not work that way.
 * `render_gpu/skia/text_layout.js` draws with `layout.draw(canvas, cmd.x, cmd.y)`
 * — a Skia Paragraph's origin is its TOP-LEFT — and `render_gpu/svg_backend.js`
 * agrees (`baseline = cmd.y + ascentFraction·size`). So every one of those lines
 * was drawn a full line-height LOWER than its author believed, which is why the
 * Number node's 22pt digit was clipped by its own bottom rim at the DEFAULT size,
 * why a card title sat below its header strip, and why the Knob and Slider
 * readouts sat on the rim.
 *
 * Stating the line's height is what lets a band RESERVE one, so this is the
 * number every node text is placed by. The ratio is `core/richtext`'s
 * NATURAL_LINE_HEIGHT — the same one the text stack falls back to — rather than
 * a second opinion about how tall a line is.
 *
 * @param {number} size - the type size
 * @returns {number} LOCAL units
 *
 * @example textLineH(10) // 12
 * @example textLineH(22) // 26.4
 */
export function textLineH(size) {
  return Math.max(0, Number(size) || 0) * NATURAL_LINE_HEIGHT;
}

/**
 * The gap between one band of node chrome and the next. One number, because two
 * different gaps between the same two kinds of thing is how a stack stops
 * reading as a stack.
 */
export const NODE_BODY_GAP = 8;

/**
 * Pure function. A DERIVED NATURAL SIZE, rounded to a whole unit — the last step
 * of the measure-then-place pass, and the ONE place abstract units become a
 * stored default.
 *
 * ── A FRACTIONAL DEFAULT IS NOT COSMETIC, IT CHANGES A DRAG'S FEEL ──────────
 * MEASURED (tests/default_step_test.js, 2026-08-06): the scrub resolver derives
 * a DraggableNumber coefficient from a default's DECIMAL PLACES, so a natural
 * height of 123.6 gave `node_knob`'s `h` row a sensitivity of 1.236 units per
 * pixel instead of 1. That sweep names `x`/`y`/`w`/`h` explicitly and says why —
 * "a sensitivity regression here would be far worse than the bug this rule
 * fixes" — and it is right: every node in the app had picked one up, silently,
 * because the derived stack now sums line heights (`size · 1.2`) that are not
 * whole numbers.
 *
 * So the conversion from abstract units to a stored pixel size ROUNDS, exactly
 * once, here. Axoloti does the same thing at the same point for a different
 * reason (`resizeToGrid`: `ceil(h / 14) * 14`, so its patches tile); ours rounds
 * to 1 rather than to a lattice, because our cards are author-resizable and
 * core/snap.js already snaps them to their NEIGHBOURS rather than to an absolute
 * grid — a second invisible lattice would argue with the visible solver.
 *
 * CEIL, not round: this number is a natural size that must CONTAIN its content,
 * and rounding 123.6 down to 123 would shave the band it was measured to hold.
 *
 * @param {number} n - a derived size in abstract units
 * @returns {number} a whole number of local units
 *
 * @example nodeDefaultSize(123.6) // 124
 * @example nodeDefaultSize(68) // 68
 * @example // it never shrinks the content it was measured for
 * @example nodeDefaultSize(200.1) // 201
 */
export function nodeDefaultSize(n) {
  return Math.ceil(Number(n) || 0);
}

/**
 * Pure function. THE TOP OF A NODE'S OWN FACE: below its lowest port bead, with
 * one gap. Every node family's content — a knob band, one big dial, a track, a
 * button face, a number — starts at or below this line.
 *
 * Reads `core/nodeflow.portLayout`, the ONE port geometry the beads are painted
 * from and the hit test grabs by, so the face cannot disagree with the ports
 * about where the column ends. That matters more since workstream CH taught the
 * column to reflow: a face placed from a REMEMBERED port height would drift
 * under a reflowed bead on exactly the short cards this is all about.
 *
 * A node with no ports at all still clears its header, which is the honest floor.
 *
 * @param {object} plugin - the node's own plugin (for its port declaration)
 * @param {object} s - the folded item state
 * @returns {number} a LOCAL y
 *
 * @example // no ports: the header plus a gap
 * @example nodeBodyTop({ports: () => ({inputs: [], outputs: []})}, {w: 150, h: 200}) // 38
 * @example // one row of ports: the bead's own bottom plus a gap
 * @example nodeBodyTop({ports: () => ({inputs: [{key: "a", type: "number"}]})}, {w: 150, h: 200}) // 48
 * @example // more rows push it down…
 * @example nodeBodyTop({ports: () => ({inputs: [{key: "a", type: "number"}, {key: "b", type: "number"}]})}, {w: 150, h: 200}) // 70
 * @example // …but a SHORT card reflows the column, so the face follows it up
 * @example nodeBodyTop({ports: () => ({inputs: [{key: "a", type: "number"}, {key: "b", type: "number"}]})}, {w: 150, h: 80}) // 60
 */
export function nodeBodyTop(plugin, s) {
  const rows = portLayout(plugin, s);
  const lastRow = rows.length ? Math.max(...rows.map((p) => p.y)) : NODE_HEADER_H;
  return lastRow + PORT_BEAD_R + NODE_BODY_GAP;
}

/**
 * Pure function. THE ONE LAYOUT — where a node's face band sits and how big it
 * is drawn, given what the band DECLARES it wants and the box it actually has.
 *
 * Every node factory routes through this: `core/audio_nodes.knobBandTop` for the
 * 24 modules' dial band, `core/control_nodes.controlFace` for the knob, slider,
 * button and keyboard, and `nodeValueText` for the number/math/display trio. It
 * is the answer to "there's no guarantee the knobs will even be in the node":
 * the guarantee is that `top + height <= boxH` for every band that fits at its
 * declared minimum, and a test sweeps it (tests/node_chrome_layout_test.js).
 *
 * ── TWO KINDS OF BAND, AND THE DIFFERENCE IS PHYSICAL ───────────────────────
 * RIGID (`grow` absent) — a dial, a row of dials, a line of type. Its internal
 *   proportions ARE its reading: a dial's whole meaning is its pointer's angle,
 *   and an oval dial reads its angle wrong everywhere but the axes. So a rigid
 *   band shrinks UNIFORMLY and never stretches.
 * ELASTIC (`grow: true`) — a slider's track, a button's face. Its length is not
 *   a proportion, it is a range: a fader on a tall card should BE tall. So an
 *   elastic band takes the room it is given, down to its declared natural height
 *   times `minScale`, and clips past that.
 * This is the same split Axoloti's BoxLayout makes between a fixed-size widget
 * and a glue-backed stack, and it is why one function can serve both.
 *
 * ── ANCHORS ────────────────────────────────────────────────────────────────
 * `anchor: "top"` (the default) puts the band at `top` and lets it slide UP
 * against the bottom rim when short — the module band's behaviour, unchanged.
 * `anchor: "center"` centres it in the room between `floorTop` and the bottom
 * pad, which is what the number/math/display trio's headline value has always
 * done ("Centred in the space below the header, so a node with no ports on a row
 * still reads as a card with a number in it") and now does through the ladder
 * instead of past it.
 *
 * @param {object} band - the declaration:
 *     {floorTop, top, height, minScale?, grow?, bottomPad?, anchor?}
 *     `floorTop` = the highest this band may ever climb; `top` = where it sits
 *     when there is room (defaults to floorTop); `bottomPad` = space reserved
 *     BELOW it (a readout line, a rim margin).
 * @param {number} [boxH] - the RESOLVED card height; absent = unconstrained
 * @returns {{top: number, height: number, scale: number}} LOCAL
 *
 * @example // a card with room: the band sits exactly where it asked to
 * @example nodeFaceBand({floorTop: 40, top: 60, height: 50}, 300) // {top: 60, height: 50, scale: 1}
 * @example // short: it SLIDES UP against the bottom rim before anything shrinks
 * @example nodeFaceBand({floorTop: 40, top: 60, height: 50}, 100) // {top: 50, height: 50, scale: 1}
 * @example // shorter still: it stops at its floor and SHRINKS
 * @example nodeFaceBand({floorTop: 40, top: 60, height: 50}, 70).scale // 0.6
 * @example // an ELASTIC band takes the room instead of leaving it
 * @example nodeFaceBand({floorTop: 40, top: 40, height: 50, grow: true}, 300).height // 260
 * @example // `bottomPad` is reserved for whatever sits under the band
 * @example nodeFaceBand({floorTop: 40, top: 40, height: 50, grow: true, bottomPad: 30}, 300).height // 230
 * @example // CENTERED, the trio's headline value: equal room above and below
 * @example nodeFaceBand({floorTop: 24, top: 24, height: 26, anchor: "center"}, 100).top // 49
 * @example // no height stated is no statement about the card
 * @example nodeFaceBand({floorTop: 40, top: 60, height: 50}, undefined) // {top: 60, height: 50, scale: 1}
 */
export function nodeFaceBand(band, boxH) {
  const floorTop = Math.max(0, band.floorTop ?? 0);
  const wanted = Math.max(floorTop, band.top ?? floorTop);
  const natural = Math.max(0, band.height ?? 0);
  const bottomPad = Math.max(0, band.bottomPad ?? 0);
  if (natural <= 0 || !Number.isFinite(boxH)) return { top: wanted, height: natural, scale: 1 };
  const room = boxH - bottomPad;
  // THE SCALE IS MEASURED AT THE TIGHTEST POSITION THE BAND CAN TAKE (hard
  // against `floorTop`) and the resulting band is then placed. One pass, not a
  // fixed point: the scale is monotonic in the room available, so a band that
  // fits at its smallest fits anywhere it is then placed. (CD measured what the
  // other order costs — reserving FULL height for a band about to be drawn at a
  // third of it pinned the shortest cards several units too far down.)
  const scale = bandFitScale(floorTop, natural, room, band.minScale ?? KNOB_BAND_MIN_SCALE);
  const height = band.grow ? Math.max(natural * scale, room - wanted) : natural * scale;
  if (band.anchor === "center") {
    return { top: Math.max(floorTop, Math.min(wanted + (room - wanted - height) / 2, room - height)), height, scale };
  }
  return { top: Math.max(floorTop, Math.min(wanted, room - height)), height, scale };
}

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
 *   NINE FAMILIES, NOT 40 COLOURS. Colour sorts nodes into KINDS — sources,
 *     filters, effects, modulation, analysis, output, and (workstream NODECHROME_)
 *     the three non-audio kinds: trigger, math, display. A hundred modules still
 *     only ever wear nine accents, so the palette cannot grow with the catalogue.
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
  // ── THE NON-AUDIO THREE (workstream NODECHROME_) ──────────────────────────
  // User, over a screenshot of a band-less Schmitt Trigger beside a properly
  // banded audio module: "why is the text title on the audio nodes fine but
  // schmitt trigger not? Why are they not all the same class? That sounds like
  // bad class management". The answer was that these nodes wore the NEUTRAL
  // fallback — not a family, but the absence of one — so they were a different
  // card design rather than a different tint of the same card. They are FAMILIES
  // now, on the same three-restriction discipline as the six above: a dark
  // desaturated step off NODE_HEADER, a hairline rim, a unit-box vector mark, and
  // nothing touching the body or the beads.
  /** TRIGGER nodes are the exec/control-flow family — every widget from
   *  core/exec_nodes.js: On Reveal, Set Property, Gate, Sequence, Delay, Counter,
   *  Schmitt, Increment, Set Var, Custom. Slate indigo: the plane that decides
   *  WHEN, distinct from modulation's blue, which decides HOW MUCH.
   *  MARK: a lightning bolt — the flash a trigger sends down an exec wire, and
   *  the same idea as the family's `mdi:flash-outline` palette icon. */
  trigger: Object.freeze({
    label: "Trigger", header: "#2a2740", rim: "#6f63b8",
    mark: "M 0.62 0 L 0.15 0.55 L 0.45 0.55 L 0.38 1 L 0.85 0.45 L 0.55 0.45 Z",
  }),
  /** MATH nodes compute a value from values: Number, Math, Compare, Time. Steel
   *  cyan — the arithmetic plane, cool and unremarkable on purpose, because these
   *  are the most numerous cards in a data patch and must not shout.
   *  MARK: a plus and a minus — arithmetic's two most literal signs. */
  math: Object.freeze({
    label: "Math", header: "#1d2f38", rim: "#4a7e94",
    mark: "M 0.28 0.05 L 0.28 0.5 M 0.05 0.275 L 0.5 0.275 M 0.5 0.8 L 0.95 0.8",
  }),
  /** DISPLAY nodes are pure SINKS: they read a value and show it, changing
   *  nothing. Warm grey-olive, the quietest accent in the table, because a display
   *  is the end of a chain and never its subject.
   *  MARK: a screen — a rounded frame with a baseline, the thing a value lands on. */
  display: Object.freeze({
    label: "Display", header: "#31322a", rim: "#8a8a63",
    mark: "M 0.05 0.1 L 0.95 0.1 L 0.95 0.72 L 0.05 0.72 Z M 0.32 0.95 L 0.68 0.95",
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
 * The default is the plain node look — NODE_HEADER with NODE_RIM. A family is an
 * opt-in a node CHOOSES; the absence of one is not an error.
 *
 * ── WHAT THE NEUTRAL FALLBACK IS FOR NOW (workstream NODECHROME_) ───────────
 * This used to say the fallback existed so "the proof trio in plugins/node_*.js
 * renders BYTE-IDENTICALLY to how it did before families existed". That is no
 * longer true and was the DEFECT: no registered node wants the neutral look, and
 * the ones that got it by omission — the trigger roster and the number/math/
 * compare/time/display five — are exactly the band-less cards the user asked
 * about ("Why are they not all the same class?"). Every plugin in the shipped
 * roster now names a family, and tests/node_chrome_unify_test.js's census fails
 * if a new one forgets.
 *
 * The fallback survives because "no family" must still be a well-formed card
 * rather than a crash — a plugin ASSET loaded from the sandbox can name a family
 * that does not exist, and a typo must degrade to plain chrome, not to a throw.
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
  const { w, h } = nodeBox(s);
  const markOps = familyMarkOps(s, family);
  // The title's box ends one pad short of the mark's own left edge. With no mark
  // there is nothing to clear, and the box stays Infinity — the pre-CA op exactly.
  const titleBoxW = markOps.length
    ? Math.max(0, w - NODE_PAD - NODE_MARK_SIZE - NODE_PAD - NODE_PAD)
    : Infinity;
  return [
    rect({ x: 0, y: 0, w, h: h ?? 0, cornerRadius: NODE_RADIUS, fill: NODE_BODY }),
    rect({ x: 0, y: 0, w, h: NODE_HEADER_H, cornerRadius: NODE_RADIUS, fill: f.header }),
    rect({ x: 0, y: NODE_HEADER_H - NODE_RADIUS, w, h: NODE_RADIUS, fill: f.header }),
    text({ text: title, x: NODE_PAD, y: titleLineTop(), size: NODE_TITLE_SIZE, color: NODE_TITLE_INK, bold: true, boxW: titleBoxW }),
    ...markOps,
  ];
}

/**
 * Pure function. The LOCAL y a card title's line box starts at: its own line,
 * centred in the header strip.
 *
 * It used to be `NODE_HEADER_H / 2 + NODE_TITLE_SIZE / 3`, which reads as
 * "half-way down, then a third of the type size for the baseline" and would be
 * right if a text op's `y` were a baseline. It is not — it is the line box's TOP
 * (see textLineH) — so the title's line ran 16..30.4 in a 24-unit header and the
 * name was drawn hanging BELOW its own strip on every node in the app. Visible on
 * any rendered still once you know to look; invisible to every test, because
 * nothing knew how tall a line was.
 *
 * @returns {number} a LOCAL y
 *
 * @example // a 12pt line is 14.4 tall, so it is inset 4.8 in a 24-unit header
 * @example titleLineTop() // 4.8
 * @example // and the line it starts ENDS inside the strip, which is the whole point
 * @example titleLineTop() + textLineH(NODE_TITLE_SIZE) <= NODE_HEADER_H // true
 */
export function titleLineTop() {
  return (NODE_HEADER_H - textLineH(NODE_TITLE_SIZE)) / 2;
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
  const { w, h } = nodeBox(s);
  return [rect({ x: 0, y: 0, w, h: h ?? 0, cornerRadius: NODE_RADIUS, fill: null, stroke: nodeFamily(family).rim, strokeWidth: NODE_RIM_WIDTH })];
}

// ── THE THIN PATH IS RETIRED (workstream NODECHROME_) ───────────────────────
//
// User, over a screenshot of a band-less "Schmitt Trigger" beside a properly
// banded "Audio VCV Bogaudio Reftone", verbatim: "why is the text title on the
// audio nodes fine but schmitt trigger not? Why are they not all the same class?
// That sounds like bad class management"
//
// It was exactly that. `nodeCard`/`nodeRim` were a SECOND card implementation
// sitting beside `familyCard`/`familyRim`, and the two had silently diverged:
//
//   THE TITLE WAS DRAWN AT THE WRONG Y. This function typeset its title at
//     `NODE_HEADER_H / 2 + NODE_TITLE_SIZE / 3` — the arithmetic `titleLineTop()`
//     documents as a BUG, because a text op's `y` is its line box's TOP and not a
//     baseline. So the title's line ran 16..30.4 in a 24-unit header and hung
//     BELOW its own strip. `familyCard` was fixed to `titleLineTop()`; this copy
//     never was, which is precisely the difference the user photographed.
//   THE TITLE HAD NO `boxW`, so a long name had nothing to clip against.
//   AND THERE WAS NO BAND AND NO MARK AT ALL, because the neutral fallback is
//     the ABSENCE of a family rather than a family — so these cards were a
//     different design, not a different tint.
//
// Fixing the copy would have left two implementations to drift again. So there is
// now ONE, and these two names are thin ALIASES kept only so a caller that wants
// the neutral look can still say so — they take a family argument and forward it.
// Every registered node plugin now passes a real family (tests/node_chrome_unify_test.js
// is the census that fails if a new one does not), so in the shipped roster these
// two are called with a family every time.

/**
 * Pure function. The node CARD in the NEUTRAL (family-less) look — `familyCard`
 * with no family, and nothing else. Kept as a name because "a node with no family"
 * is a meaningful thing to ask for; it is NOT a second card implementation.
 *
 * @param {object} s - the folded item state (w/h size the card)
 * @param {string} title - the node's display name (its title bar text)
 * @param {string} [family] - a NODE_FAMILIES key; absent = the neutral look
 * @returns {object[]} display-list commands, LOCAL coords
 *
 * @example nodeCard({w: 120, h: 80}, "Add").length // 4
 * @example nodeCard({w: 120, h: 80}, "Add")[0].op // "rect"
 * @example nodeCard({w: 120, h: 80}, "Add")[3].text // "Add"
 * @example // it IS familyCard, so the title now sits on titleLineTop() like every
 * @example // other node's — the divergence the user photographed is gone
 * @example nodeCard({w: 120, h: 80}, "Add")[3].y === titleLineTop() // true
 * @example // and a family passed through lands the band and the mark
 * @example nodeCard({w: 120, h: 80}, "Gate", "trigger").length // 5
 */
export function nodeCard(s, title, family) {
  return familyCard(s, title, family);
}

/**
 * Pure function. The node card's RIM, emitted LAST so it draws over the header
 * seam and over any port bead that straddles the edge. Separated from the card so
 * a plugin can put its own content between the two and still have the rim on top —
 * which is what makes the card read as a container rather than as a stack.
 *
 * `familyRim` with no family, for the reason nodeCard states.
 *
 * @param {object} s - the folded item state
 * @param {string} [family] - a NODE_FAMILIES key; absent = the neutral rim
 * @returns {object[]} display-list commands
 *
 * @example nodeRim({w: 120, h: 80}).length // 1
 * @example nodeRim({w: 120, h: 80})[0].op // "rect"
 * @example // ir.js PARSES every colour at op construction, so the op carries RGBA
 * @example // floats, not the hex the caller passed. Alpha 1 = the rim is opaque.
 * @example nodeRim({w: 120, h: 80})[0].stroke[3] // 1
 */
export function nodeRim(s, family) {
  return familyRim(s, family);
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
 * @example // TWO ops for a lone port: the coloured ring and its core. It was three
 * @example // until R7-10 adopted Axoloti's rule below — the label is SUPPRESSED, not
 * @example // dropped by accident, because a node with one input has already named it.
 * @example portBeads({ports: () => ({inputs: [{key: "a", type: "number"}]})}, {w: 120, h: 80}).length // 2
 * @example portBeads({ports: () => ({inputs: [{key: "a", type: "number"}]})}, {w: 120, h: 80})[0].op // "ellipse"
 * @example // the ring is painted in the PORT TYPE's colour (ir.js has parsed it to RGBA)
 * @example portBeads({ports: () => ({inputs: [{key: "a", type: "number"}]})}, {w: 120, h: 80})[0].fill[2] > 0.9 // true
 * @example portBeads({}, {w: 120, h: 80}) // []
 *
 * ── A LONE PORT ON A SIDE GETS NO LABEL (Axoloti's rule, R7-10) ─────────────
 * "a single inlet or single outlet gets NO label. The jack alone is the port.
 * This is a big part of why simple objects look tiny."
 * (axoloti_research_report.md Q2 §3, from InletInstance.java:90-108.)
 *
 * Adopted verbatim in RULE, because it is right for the same reason there: a
 * node with one output has already said what that output is — it is the node.
 * "Number → out", "Knob → out", "Display ← in" are three labels that name
 * nothing the card does not.
 *
 * It also happens to delete the WORST instance of the escape this workstream is
 * about. MEASURED on a rendered still: an output label was boxed at
 * `[p.x - GAP, p.x - GAP + w/2 - GAP]` and drawn RIGHT-ALIGNED in it — a box
 * whose right edge is at `1.5·w - 22`, i.e. HALF A CARD PAST the right rim. So
 * every output label in the app was painted OUTSIDE its own node (visible on the
 * probe render as "out" floating beside the Number, Math, Knob, Slider and
 * Button cards). Most of them are single outputs and now draw nothing at all;
 * the survivors are boxed correctly below.
 *
 * @example // ONE output: the jack alone, no label — two ops, not three
 * @example portBeads({ports: () => ({outputs: [{key: "out", type: "number"}]})}, {w: 120, h: 80}).length // 2
 * @example // TWO outputs need naming, so both are labelled…
 * @example portBeads({ports: () => ({outputs: [{key: "pitch", type: "number"}, {key: "gate", type: "trigger"}]})}, {w: 120, h: 80}).filter((o) => o.op === "text").length // 2
 * @example // …and the label's box now ENDS at the bead instead of STARTING there,
 * @example // which is the fix. `x` is the box's LEFT edge and the run is aligned
 * @example // right inside it, so the meaningful number is where the box ENDS:
 * @example // exactly one PORT_LABEL_GAP short of the rim, at every width.
 * @example // (MEASURED at w 84/120/150/200 — the clearance is 11 in all four. On a
 * @example // 120 card the left edge lands on 60, which is w/2 not by centring but
 * @example // because each side's label column is half the card, so the input and
 * @example // output columns meet in the middle and can never overlap.)
 * @example ((o) => o.x + o.boxW)(portBeads({ports: () => ({outputs: [{key: "pitch", type: "number"}, {key: "gate", type: "trigger"}]})}, {w: 120, h: 80}).find((o) => o.op === "text")) // 109
 * @example portBeads({ports: () => ({outputs: [{key: "pitch", type: "number"}, {key: "gate", type: "trigger"}]})}, {w: 120, h: 80}).find((o) => o.op === "text").boxStyle.align // "right"
 * @example // A CONNECTED input is a FILLED socket (Axoloti's jack rule), which is
 * @example // the knob-or-input duality's honest signal: the wire is plugged in.
 * @example portBeads({ports: () => ({inputs: [{key: "a", type: "number"}]})}, {w: 120, h: 80, inputs: {a: {item: "n1", port: "out"}}})[1].fill[3] // 1
 */
export function portBeads(plugin, s) {
  const ops = [];
  const { w } = nodeBox(s);
  const rows = portLayout(plugin, s);
  const perSide = { input: 0, output: 0 };
  for (const p of rows) perSide[p.side] += 1;
  for (const p of rows) {
    // The port's OWN colour when it declares one (a visual node's recolourable
    // sockets), else its type's — core/nodeflow.portColorOf, the one lookup.
    const color = portColorOf(p);
    const isInput = p.side === "input";
    ops.push(ellipse({ cx: p.x, cy: p.y, rx: PORT_BEAD_R, ry: PORT_BEAD_R, fill: color }));
    // THE CORE says whether anything is plugged in: dark (a socket standing open)
    // when nothing is, the port's own colour (a socket filled) when a wire lands
    // on it. Axoloti's jack does exactly this and it is the ONLY "this is driven"
    // indicator in that whole app. Read from `s.inputs`, the ONE place a
    // connection lives (R7-1), so it is document property state and needs no
    // evaluation pass — and outputs never fill, because fan-out is free and a
    // filled output would say something about the OTHER node.
    ops.push(ellipse({
      cx: p.x, cy: p.y,
      rx: PORT_BEAD_R * BEAD_CORE_FRACTION, ry: PORT_BEAD_R * BEAD_CORE_FRACTION,
      fill: isInput && portIsWired(s, p.key) ? color : NODE_BODY,
    }));
    if (perSide[p.side] < 2) continue;
    // AN EMPTY LABEL IS "THE JACK ALONE", BY CHOICE. A visual node's port may be
    // declared with no name (user, 2026-08-21: a blank label still "explains where
    // the node entrance and exit will come out of"), so a blank draws nothing
    // rather than an empty text op that the exporters would still emit.
    if (String(p.label ?? "").trim() === "") continue;
    // The label reads INWARD from its own edge, and its BOX is inside the card on
    // both sides — an input's runs right from the bead, an output's ENDS at the
    // bead (a right-aligned run must be given the box it aligns against, not the
    // one that starts where it should stop). Wrapping is still possible and still
    // means the node is too narrow, which is a sizing problem to see rather than
    // to hide; being drawn off the card was not.
    const boxW = Math.max(0, w / 2 - PORT_LABEL_GAP);
    ops.push(text({
      text: p.label,
      x: isInput ? p.x + PORT_LABEL_GAP : p.x - PORT_LABEL_GAP - boxW,
      y: p.y - textLineH(NODE_PORT_LABEL_SIZE) / 2,
      size: NODE_PORT_LABEL_SIZE,
      color: NODE_PORT_INK,
      boxW,
      boxStyle: isInput ? null : { align: "right" },
    }));
  }
  return ops;
}

/**
 * Pure function. Is a wire currently landing on this node's named input?
 *
 * THE ONE READING of the connection map, so the filled bead, the driven dial and
 * any future affordance cannot disagree about what "connected" means. The map is
 * the consuming node's own `inputs` leaf — R7-1's law that a connection is
 * property state on the CONSUMER and nothing else is a source of truth — so this
 * is a pure function of the folded document and reads no graph evaluation.
 *
 * @param {object} s - the folded item state
 * @param {string} key - an input port's key
 * @returns {boolean}
 *
 * @example portIsWired({inputs: {in: {item: "n1", port: "out"}}}, "in") // true
 * @example portIsWired({inputs: {}}, "in") // false
 * @example // a slot left behind by a deleted source is not a wire
 * @example portIsWired({inputs: {in: null}}, "in") // false
 * @example portIsWired({}, "in") // false
 */
export function portIsWired(s, key) {
  return typeof s?.inputs?.[key]?.item === "string";
}

/**
 * Pure function. The big VALUE READOUT a node shows in its body — the number a
 * source is emitting, the result a math node computed, the input a display
 * received. Centred in the space below the header, so a node with no ports on a
 * row still reads as a card with a number in it.
 *
 * ── IT IS A BAND NOW, AND THAT IS WHY IT TAKES THE PLUGIN (R7-10) ───────────
 * It used to place a BASELINE by hand at `(NODE_HEADER_H + h) / 2 + size / 3`,
 * which is the third of the three hand-rolled placement schemes this workstream
 * collapses — and it was wrong twice over. A text op's `y` is its line-box TOP
 * (see textLineH), so the "+ size / 3" pushed the line DOWN rather than lifting
 * its glyphs, and nothing capped it against the bottom rim. MEASURED at the
 * DEFAULT size on a rendered still: the Number node's 22pt digit ran from y 133
 * to 159 inside a card 68 tall — the bottom half of its own headline value cut
 * off by its own rim, on a node nobody had resized.
 *
 * Now it declares a CENTRED RIGID BAND one line tall and lets `nodeFaceBand`
 * place it, so it centres exactly where it always meant to, slides up on a short
 * card, and shrinks rather than overflowing.
 *
 * @param {object} s - the folded item state
 * @param {string} str - the already-formatted string to show
 * @returns {object[]} display-list commands
 *
 * @example nodeValueText({w: 120, h: 80}, "6").length // 1
 * @example nodeValueText({w: 120, h: 80}, "6")[0].text // "6"
 * @example nodeValueText({w: 120, h: 80}, "6")[0].boxStyle.align // "center"
 * @example // the line is CENTRED in the body and its whole box is inside the card
 * @example nodeValueText({w: 120, h: 80}, "6")[0].y // 38.8
 * @example // …which is the property that was false before: top + line <= h
 * @example nodeValueText({w: 120, h: 80}, "6")[0].y + 26.4 <= 80 // true
 * @example // a card too short for a full-size line SHRINKS it instead of clipping
 * @example nodeValueText({w: 120, h: 44}, "6")[0].size < NODE_VALUE_SIZE // true
 */
export function nodeValueText(s, str) {
  const { w, h } = nodeBox(s);
  const line = textLineH(NODE_VALUE_SIZE);
  // THE FLOOR IS THE HEADER, NOT THE PORT ROWS, and that is deliberate: this is a
  // headline number centred in the card's body, and the ports it may pass beside
  // sit on the EDGES with their labels suppressed when there is one per side. A
  // band floored under the ports would push the trio's whole reason for existing
  // into the bottom third of a card sized for one line of type.
  const band = nodeFaceBand({
    floorTop: NODE_HEADER_H, top: NODE_HEADER_H, height: line, anchor: "center",
  }, h);
  return [text({
    text: str,
    x: 0,
    y: band.top,
    size: NODE_VALUE_SIZE * band.scale,
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
    // A DRIVEN DIAL'S TRACK WEARS ITS DRIVER'S TYPE COLOUR (R7-10's knob-or-input
    // duality). The survey's convergent rule is that an unwired param shows its
    // widget and a WIRED one shows what is driving it instead
    // (patchers_blueprints_report.md's `showWidget` predicate, invented
    // independently by Blender, Blueprint, Rete and litegraph). Where a dial is
    // still drawn for a driven param — an audio param a wire SUMS into, Axoloti's
    // `param_X + inlet_X`, where the dial is a live offset and not a stale number
    // — the track says so. It is the same colour-means-TYPE language the beads
    // already speak (ADDENDUM 7), so the palette does not grow: no new op, no new
    // shape, no glyph that a font might not have.
    const trackInk = k.driven ? portColor(k.drivenType ?? "number") : KNOB_TRACK_INK;
    ops.push(path({ d: knobArcPath(k, r, 0, 1), fill: null, stroke: trackInk, strokeWidth: KNOB_TRACK_WIDTH }));
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
 * THE FLASH — what a wire looks like on a frame its trigger fired.
 *
 * > *"On frames where triggers fire, the wires connecting them should change color
 * > to show that something happened."* (user, 2026-08-12)
 *
 * ── WHY A NEAR-WHITE AND NOT A HUE ─────────────────────────────────────────
 * Every hue in this app's wire vocabulary already MEANS something: `portColor` gives
 * each port TYPE its own, and that is the one thing a wire's colour says. A flash in
 * some sixth hue would read as "this wire changed type", which is the opposite of
 * true. A near-white is outside the type palette entirely, so it reads as
 * BRIGHTNESS — the wire lighting up — rather than as a different kind of value. It is
 * also the same answer Unreal reached for its exec pins, and for the same reason
 * `core/nodeflow.js` gives for the exec colour being deliberately unsaturated:
 * control is not a kind of value.
 *
 * ── AND IT IS THICKER, BECAUSE COLOUR ALONE IS NOT AN ANSWER ────────────────
 * A flash that is only a hue change is invisible to a colour-blind viewer and nearly
 * invisible on a projector. The width carries the same information redundantly, which
 * is the accessible construction and costs nothing.
 */
export const WIRE_FLASH_INK = "#f2f6ff";
export const WIRE_FLASH_WIDTH_EXTRA = 1.5;

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
 * A WIRE THAT FIRED THIS FRAME (`fired: true`, stamped by core/derive.deriveWires
 * from the frame domain's step) is painted in WIRE_FLASH_INK and thicker. It is a
 * pure function of the record, so the flash reaches every consumer the wire itself
 * does — the editor, presentation mode, PNG export, PDF, SVG and the video render
 * job — with no per-backend work, and it therefore SURVIVES AN EXPORT. That is not
 * incidental: whether a trigger fired on frame N is a function of the same inputs
 * frame N is a function of, so a rendered video shows the flashes the presenter saw.
 *
 * @param {object} wire - one core/derive.deriveWires record ({from: {x, y}, to: {x, y}, type, color?, fired?})
 * @returns {object[]} display-list commands (halo first, then the wire)
 *
 * @example wireOps({from: {x: 0, y: 0}, to: {x: 200, y: 0}, type: "number"}).length // 2
 * @example wireOps({from: {x: 0, y: 0}, to: {x: 200, y: 0}, type: "number"})[1].d // "M 0 0 C 100 0 100 0 200 0"
 * @example // the halo is the WIDER of the two, and is drawn FIRST so the wire lands on top
 * @example wireOps({from: {x: 0, y: 0}, to: {x: 200, y: 0}, type: "number"}).map((o) => o.strokeWidth) // [4.5, 2.5]
 * @example // the wire carries the SOURCE type's colour (ir.js has parsed it to RGBA)
 * @example wireOps({from: {x: 0, y: 0}, to: {x: 200, y: 0}, type: "audio"})[1].stroke.length // 4
 * @example // A FIRED wire is thicker than the same wire at rest …
 * @example wireOps({from: {x: 0, y: 0}, to: {x: 9, y: 0}, type: "exec", fired: true})[1].strokeWidth // 4
 * @example // … and its halo widens with it, so the outline stays proportional
 * @example wireOps({from: {x: 0, y: 0}, to: {x: 9, y: 0}, type: "exec", fired: true})[0].strokeWidth // 6
 */
export function wireOps(wire) {
  const d = wireBezierPath(wire.from, wire.to);
  // ROUND CAPS at both ends, matching the editor overlay's `stroke-linecap: round`
  // — a wire's end sits AT its bead's centre, so a flat cap would leave the cable
  // stopping half a bead short of the socket it plugs into.
  const caps = { strokeCapStart: "round", strokeCapEnd: "round" };
  const width = WIRE_WIDTH + (wire.fired ? WIRE_FLASH_WIDTH_EXTRA : 0);
  return [
    path({ d, fill: null, stroke: WIRE_HALO_INK, strokeWidth: width + WIRE_HALO_EXTRA, opacity: WIRE_HALO_OPACITY, ...caps }),
    // At rest, the SOURCE port's own colour when it declared one
    // (core/derive.deriveWires carries it as `color`), else the type's — the same
    // portColorOf rule the bead at that end was painted by, so a recoloured
    // socket's cable matches it. A FIRED wire flashes regardless of either.
    path({ d, fill: null, stroke: wire.fired ? WIRE_FLASH_INK : portColorOf(wire), strokeWidth: width, ...caps }),
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
