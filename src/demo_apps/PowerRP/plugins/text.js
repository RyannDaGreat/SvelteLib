/**
 * Text widget. Text is RICH TEXT (manifest "RICH TEXT"): a {runs, paras} value
 * of styled runs (bold/italic/underline/strike/size/font/color per run) over
 * paragraphs (align/lineSpacing/charSpacing/wordSpacing). The box is a REAL box
 * (manifest "Text boxes are REAL boxes"): resizable handles + word wrap within w.
 *
 * emit() stays PURE: it produces ONE rich text IR op carrying the runs + the box
 * width; each render backend runs the SHARED pure layout (core/richtext.js) with
 * its own metric seam — one layout, two backends (the parity lever). No layout
 * happens here (emit has no font metrics; it is DOM-free).
 *
 * Run-level content/style EDITING is SET-2 (the in-canvas cursor editor +
 * floating PPT toolbar); this file builds the MODEL + para/box Inspector rows.
 * Legacy plain-string `text` values migrate to runs LOUDLY at load
 * (core/richtext.withRichTextMigrated, wired in the app repair path).
 */

import { standardBBoxAnchors } from "../core/derive.js";
import { UNIT_SPAN_SCRUB, bundle, bundleNestedDefaults } from "../core/properties.js";
import { normalizeRichText, richTextIsEmpty, boxStyleRowVisibility, DEFAULT_PARA_SIZE } from "../core/richtext.js";
import { text } from "../render_gpu/ir.js";
import { DEFAULT_FONT, fontOptions } from "../render_gpu/fonts.js";
import { applyEffects, effectsCullMargin } from "../render_gpu/effects.js";

/**
 * TYPE ROLES — the type SYSTEM half of this widget's presets: face, size, weight,
 * alignment and spacing. The other half (colour, opacity and the effects) is
 * INK_LOOKS below; the two key sets are DISJOINT, so one pick from each composes
 * rather than clobbers (core/registry.js's family rule, enforced over every plugin
 * by tests/tool_groups_test.js). The split is legal here and NOT on the sibling
 * text widgets for a measured reason: this is the only one of them with nine
 * type-system knobs. plaintext and the morph trio pass a boxStyle of {align,
 * valign} only, so a role family there would differ in nothing but face and size.
 *
 * ORDERED BY DESCENDING SIZE, because here the order IS the scale: 220 / 150 / 114
 * / 72 / 64 / 48 / 40 / 34 / 32 / 28 / 27 / 22 / 18 is the perfect-fourth ramp from
 * a 36u base (20 / 27 / 36 / 48 / 64 / 85 / 114) with the idiom sizes interleaved.
 * Running down the list reads like a type-specimen sheet.
 *
 * `size` IS A LOOK HERE AND A COMPOSITION KEY ON THE LATEX WIDGET, and the same
 * measurement decides both. SPEC's exclusion is "how it FITS its box" (the flare's
 * flareScale). emit() below passes boxW/boxH for WRAP and VERTICAL-ALIGN ROOM only
 * — there is no fit-to-box scaling anywhere in the text path — so `size` is the
 * absolute ink height, the same category as the strokeWidth graph_presets.js
 * already writes. plugins/latex.js fits its equation INTO the box (preserveAspect),
 * so its fontSize is the other answer. One fact, two rulings, no taste.
 *
 * TWO CONVERSIONS GOVERN EVERY NUMBER HERE, and getting either backwards shifts the
 * whole table silently:
 *   charSpacing = tracking_in_em x size   (core/richtext.js spacedMeasure adds it
 *     PER CHARACTER in canvas units — an ABSOLUTE offset, not em tracking, so it
 *     must travel with the size it was chosen for and does not survive a later
 *     size change).
 *   lineSpacing = css_line_height / 1.2   (core/richtext.js NATURAL_LINE_HEIGHT).
 *
 * TRACKING FOLLOWS ONE RULE, visible as the shape of the charSpacing column:
 * NEGATIVE at display sizes, ZERO through the text band, POSITIVE and rising as
 * size falls — and always POSITIVE for caps at any size. Display magnitudes come
 * from Inter's published dynamic-metrics curve (asymptote -0.0223em); caps
 * magnitudes from the 0.05-0.12em band Butterick specifies for all-caps setting.
 * wordSpacing compensates tracked caps at about 1.5x the character value, because
 * tracking widens the letters far more than it widens the word gap.
 *
 * NO PRESET CAN CAPITALISE TEXT — there is no case transform in the schema, and
 * none of the 14 registered faces has an italic or a weight axis. The caps idioms
 * below are the SETTING around caps; their descriptions say to type in caps.
 *
 * NO PRESET WRITES THE CONTENT. `text` is a two-leaf rich value {runs, paras} and a
 * props key is one path segment, so a preset could only write the WHOLE value —
 * obliterating every run style the in-canvas editor put there. The widget does not
 * even offer an Inspector row for it, for the same reason (see below).
 */
const TYPE_ROLES = [
  { name: "Watermark Caps", description: "Enormous, airy, wide-tracked capitals laid across the slide — type in caps, and pair it with the Watermark Wash ink to sink it behind the content.",
    props: { font: "jost", size: 220, bold: false, align: "center", valign: "middle", lineSpacing: 0.833, charSpacing: 44, wordSpacing: 66 } },
  { name: "Film Title Card", description: "The main-title setting: a geometric sans in bold caps, opened out to a fifth of an em and set solid so a two-word title locks into a block. Type in caps.",
    props: { font: "futura", size: 150, bold: true, align: "center", valign: "middle", lineSpacing: 0.833, charSpacing: 22.5, wordSpacing: 34 } },
  { name: "Title Slide", description: "The deck's opening line — display size with the light negative tracking display type wants, centred and set just under solid so a two-line title still reads as one object.",
    props: { font: "montserrat", size: 114, bold: true, align: "center", valign: "middle", lineSpacing: 0.875, charSpacing: -2.5, wordSpacing: -2.5 } },
  { name: "Pull Quote", description: "The magazine pull quote: a high-contrast display serif at roughly twice body size, leading tighter than body, hanging at the middle of its box.",
    props: { font: "playfair-display", size: 72, bold: false, align: "left", valign: "middle", lineSpacing: 1.042, charSpacing: -1.1, wordSpacing: 0 } },
  { name: "Broadcast Caption", description: "The subtitle setting, to broadcast spec: a plain sans at 7% of frame height, untracked because a caption is read once and fast, on 120% leading, parked at the bottom.",
    props: { font: "system", size: 72, bold: false, align: "center", valign: "bottom", lineSpacing: 1, charSpacing: 0, wordSpacing: 0 } },
  { name: "Section Header", description: "The divider slide's line — one scale step under the title, ranged left and vertically centred so it sits alone on the slide with nothing else needed.",
    props: { font: "inter", size: 64, bold: true, align: "left", valign: "middle", lineSpacing: 0.917, charSpacing: -1.4, wordSpacing: -1.4 } },
  { name: "Monument Inscription", description: "Roman inscriptional capitals — a text serif, no bold, letters opened an eighth of an em and given generous leading, the way a plaque or a memorial is cut. Type in caps.",
    props: { font: "source-serif", size: 64, bold: false, align: "center", valign: "middle", lineSpacing: 1.125, charSpacing: 5.1, wordSpacing: 7.7 } },
  { name: "Slide Headline", description: "The working headline for a content slide: bold sans at the ten-foot-readable title size, ranged left at the top of its box, tracked in a hair.",
    props: { font: "inter", size: 48, bold: true, align: "left", valign: "top", lineSpacing: 1, charSpacing: -1.1, wordSpacing: 0 } },
  { name: "Reading Column", description: "Long-form prose sized to hit the 66-character measure across a full-width box — a sturdy screen serif on open leading, untracked, for the slide people actually read.",
    props: { font: "merriweather", size: 48, bold: false, align: "left", valign: "top", lineSpacing: 1.208, charSpacing: 0, wordSpacing: 0 } },
  { name: "Deck Subtitle", description: "The line under the title: a geometric sans set larger than it looks because this face has a small x-height, centred, with a touch of display tightening.",
    props: { font: "jost", size: 40, bold: false, align: "center", valign: "top", lineSpacing: 1.083, charSpacing: -0.9, wordSpacing: 0 } },
  { name: "Billing Block", description: "The credit block under a title card — the only condensed face, at 30% of the title's cap height, lightly opened and set tight, exactly as a poster's billing is specified.",
    props: { font: "oswald", size: 34, bold: false, align: "center", valign: "bottom", lineSpacing: 0.958, charSpacing: 1, wordSpacing: 1.5 } },
  { name: "Body Copy", description: "Plain running text at the smallest size that still projects — untracked, on one-and-a-half leading, ranged left from the top. The default every other role is measured against.",
    props: { font: "inter", size: 32, bold: false, align: "left", valign: "top", lineSpacing: 1.25, charSpacing: 0, wordSpacing: 0 } },
  { name: "Screenplay Slug", description: "A scene heading: monospace set solid, twelve on twelve, untracked because the grid is the point. Type in caps.",
    props: { font: "jetbrains-mono", size: 28, bold: false, align: "left", valign: "top", lineSpacing: 0.833, charSpacing: 0, wordSpacing: 0 } },
  { name: "Kicker", description: "The small tracked-caps eyebrow that sits above a headline — condensed, bold, opened a tenth of an em with the word gaps widened to match. Type in caps.",
    props: { font: "oswald", size: 27, bold: true, align: "left", valign: "top", lineSpacing: 1, charSpacing: 2.7, wordSpacing: 4.1 } },
  { name: "Photo Caption", description: "The line under a figure: small, positively tracked the way small type needs, and led TIGHTER than body — which is what real caption specs do, not looser.",
    props: { font: "inter", size: 22, bold: false, align: "left", valign: "top", lineSpacing: 1.083, charSpacing: 0.7, wordSpacing: 0 } },
  { name: "Legal Fine Print", description: "The bottom-of-the-slide disclaimer at the size regulation actually permits — a text serif, justified, nearly solid, with the extra letterspacing tiny type needs to stay legible.",
    props: { font: "source-serif", size: 18, bold: false, align: "justify", valign: "bottom", lineSpacing: 0.958, charSpacing: 0.6, wordSpacing: 0 } },
];

/**
 * INK AND LIGHT — the MATERIAL half: what the glyphs are made of. Disjoint from
 * TYPE_ROLES above, so a role and an ink compose in either order.
 *
 * ORDERED BY HOW MUCH LIGHT THE INK ADDS: flat, then dimensional (a cast or cut
 * shadow), then luminous (bloom), then the two transparencies. The list sweeps
 * matte to glowing to absent, which is the comparison being made.
 *
 * EVERY PRESET WRITES EVERY KEY, INCLUDING THE OFF STATES, and every nested object
 * is COMPLETE. Both rules are load-bearing rather than tidy: application is an
 * OVERLAY, so an omitted `bloom` leaves the previously hovered preset's glow
 * behind; and a PARTIAL nested object MERGES rather than replacing (measured
 * against core/deltas.js applied()), so `shadow: {opacity: 0}` alone would keep the
 * last preset's blur and colour. A stale glow is the most visible form of that bug.
 * The off states, spelled once: shadow and innerShadow are off at opacity 0 (their
 * declared render gate, core/properties.js); bloom is off at strength 0, with the
 * registry's own radius 10 carried so the row is complete.
 *
 * `softEdges` IS 0 EVERYWHERE BUT ONE ROW, and the reason is measured rather than
 * cautious. featherEdges (render_gpu/skia/paint_skia.js) ERODES the widget's alpha
 * silhouette by that many units before blurring it, and on text the silhouette is
 * the GLYPHS — so it eats the strokes from both sides. A value that reads as chalk
 * on a 114u title erases an 18u caption, and because this family is orthogonal to
 * TYPE_ROLES it cannot know which size it landed on. The one row that uses it says
 * in its own description that it wants display type.
 *
 * Each description names the ground it assumes. The two halves of an idiom that
 * spans both families share a NAME: "Watermark Wash" pairs with "Watermark Caps".
 */
const INK_LOOKS = [
  {
    name: "Paper Black",
    description: "Ink on paper — a true printing black rather than pure black, no shadow, no glow: the flat setting, and the row that takes every effect back off.",
    props: {
      color: "#1a1a1a", opacity: 1, blendMode: "normal", softEdges: 0,
      shadow: { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 },
      bloom: { radius: 10, strength: 0 },
      innerShadow: { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 },
    },
  },
  {
    name: "Risograph Overprint",
    description: "Fluorescent duplicator ink multiplied into whatever it crosses, so overlaps darken instead of hiding — the risograph's whole character, and it needs something underneath to show it.",
    props: {
      color: "#ff5c39", opacity: 0.9, blendMode: "multiply", softEdges: 0,
      shadow: { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 },
      bloom: { radius: 10, strength: 0 },
      innerShadow: { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 },
    },
  },
  {
    name: "Soft Lift",
    description: "Interface elevation — a short, wide, quarter-strength shadow straight down, enough to lift dark type off a light slide without reading as a drop shadow.",
    props: {
      color: "#1a1a1a", opacity: 1, blendMode: "normal", softEdges: 0,
      shadow: { dx: 0, dy: 2, blur: 8, color: "#000000", opacity: 0.28 },
      bloom: { radius: 10, strength: 0 },
      innerShadow: { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 },
    },
  },
  {
    name: "Poster Shadow",
    description: "The hard offset shadow of screen-printed poster type — no blur at all, full strength, thrown down and to the right so the letters read as cut paper.",
    props: {
      color: "#ffffff", opacity: 1, blendMode: "normal", softEdges: 0,
      shadow: { dx: 4, dy: 5, blur: 0, color: "#000000", opacity: 1 },
      bloom: { radius: 10, strength: 0 },
      innerShadow: { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 },
    },
  },
  {
    name: "Caption Shade",
    description: "The subtitle treatment: white type with a tight, solid, unoffset shadow all round, which is how a caption stays legible over an image it cannot control.",
    props: {
      color: "#ffffff", opacity: 1, blendMode: "normal", softEdges: 0,
      shadow: { dx: 0, dy: 0, blur: 4, color: "#000000", opacity: 1 },
      bloom: { radius: 10, strength: 0 },
      innerShadow: { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 },
    },
  },
  {
    name: "Cinema Title",
    description: "Warm film white over a wide, half-strength halo — the way a main title is graded so it sits on a dark frame without a visible edge.",
    props: {
      color: "#f5f2ea", opacity: 1, blendMode: "normal", softEdges: 0,
      shadow: { dx: 0, dy: 0, blur: 18, color: "#000000", opacity: 0.5 },
      bloom: { radius: 10, strength: 0 },
      innerShadow: { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 },
    },
  },
  {
    name: "Letterpress",
    description: "Type pressed into the sheet — warm near-black with a single unblurred WHITE line beneath each stroke, which is the whole trick: the highlight is the lip of the impression.",
    props: {
      color: "#23201c", opacity: 1, blendMode: "normal", softEdges: 0,
      shadow: { dx: 0, dy: 1.5, blur: 0, color: "#ffffff", opacity: 0.75 },
      bloom: { radius: 10, strength: 0 },
      innerShadow: { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 },
    },
  },
  {
    name: "Debossed Metal",
    description: "Letters stamped into a grey plate: a dark inner shadow from above inside the strokes, a thin white catch-light below them, and no colour of its own.",
    props: {
      color: "#8a8f98", opacity: 1, blendMode: "normal", softEdges: 0,
      shadow: { dx: 0, dy: 1, blur: 0, color: "#ffffff", opacity: 0.5 },
      bloom: { radius: 10, strength: 0 },
      innerShadow: { dx: 0, dy: 2, blur: 3, color: "#000000", opacity: 0.85 },
    },
  },
  {
    name: "Gold Leaf",
    description: "Beaten gold on a dark ground — an old-gold ink, a short brown shadow to seat it on the surface, and just enough bloom to suggest the metal catching light.",
    props: {
      color: "#c9a227", opacity: 1, blendMode: "normal", softEdges: 0,
      shadow: { dx: 1, dy: 1.5, blur: 1.5, color: "#3a2c05", opacity: 0.6 },
      bloom: { radius: 8, strength: 0.3 },
      innerShadow: { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 },
    },
  },
  {
    name: "Chalk Dust",
    description: "Warm off-white at slightly less than full opacity with a faint halo — chalk on a board never reaches paper-white and always leaves a little dust around the stroke.",
    props: {
      color: "#f2ede4", opacity: 0.92, blendMode: "normal", softEdges: 0,
      shadow: { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 },
      bloom: { radius: 6, strength: 0.25 },
      innerShadow: { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 },
    },
  },
  {
    name: "Airbrushed",
    description: "Sprayed rather than drawn — the stroke edges feathered inward under a soft halo. THE ONE ROW THAT FEATHERS: the feather erodes the glyph, so it wants display type and will eat anything under about 40 units.",
    props: {
      color: "#ffffff", opacity: 0.9, blendMode: "normal", softEdges: 1.4,
      shadow: { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 },
      bloom: { radius: 10, strength: 0.35 },
      innerShadow: { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 },
    },
  },
  {
    name: "Amber Phosphor",
    description: "The amber monochrome monitor — the 602-nanometre phosphor, with the moderate bloom a long-persistence tube gives every lit stroke.",
    props: {
      color: "#ffb000", opacity: 1, blendMode: "normal", softEdges: 0,
      shadow: { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 },
      bloom: { radius: 12, strength: 0.6 },
      innerShadow: { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 },
    },
  },
  {
    name: "Green Phosphor",
    description: "The green screen — the 525-nanometre willemite phosphor of an oscilloscope or an early monochrome monitor, glowing harder than the amber tube because it is a brighter emitter.",
    props: {
      color: "#33ff33", opacity: 1, blendMode: "normal", softEdges: 0,
      shadow: { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 },
      bloom: { radius: 14, strength: 0.75 },
      innerShadow: { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 },
    },
  },
  {
    name: "Neon Tube",
    description: "Cold-cathode cyan at full overdrive: a wide bloom for the tube's own light plus a dark teal shadow for the colour it throws onto the wall behind it.",
    props: {
      color: "#2bf3ff", opacity: 1, blendMode: "normal", softEdges: 0,
      shadow: { dx: 0, dy: 0, blur: 10, color: "#0a4a55", opacity: 0.6 },
      bloom: { radius: 28, strength: 1.2 },
      innerShadow: { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 },
    },
  },
  {
    name: "Watermark Wash",
    description: "Barely there — flat black at seven percent, no effects, for the giant ghosted word behind the content. Pairs with the Watermark Caps type role.",
    props: {
      color: "#000000", opacity: 0.07, blendMode: "normal", softEdges: 0,
      shadow: { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 },
      bloom: { radius: 10, strength: 0 },
      innerShadow: { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 },
    },
  },
];

export const textPlugin = {
  type: "text",
  title: "Text",
  // resizable:true → CanvasView shows the standard 8 resize handles (same
  // machinery as rect — capabilities.bbox && capabilities.resizable; NO special
  // case). w/h are real box dimensions; w constrains word wrap.
  capabilities: { bbox: true, transform: true, resizable: true, backdrop: false },
  // TWO ORTHOGONAL preset families, key-DISJOINT so a role and an ink compose in
  // either order (the glass material/silhouette split, not the lens_flare
  // alternative-whole-looks case). Titled, so the pane reads "Type roles" and "Ink
  // and light" rather than one generic "Presets" heading over 31 rows.
  presetFamilies: [
    { id: "type", title: "Type roles", presets: TYPE_ROLES },
    { id: "ink", title: "Ink and light", presets: INK_LOOKS },
  ],
  // DOUBLE-CLICK ACTIVATION (web/widget_handlers.js, phase "activate"): the
  // Skia-owned in-place RICH editor — it edits a {runs, paras} value with the
  // floating format toolbar, which is what distinguishes it from the plain
  // single-string "inline_text_edit" a plaintext box declares.
  activate: "rich_text_edit",
  /**
   * Pure function. Is this text box currently a GHOST (manifest 13.6
   * CONDITIONAL GHOSTS: "same with text")? STATE-dependent, not
   * capabilities.ghost — a text box is only a ghost while its rich value has
   * no visible characters (core/richtext.richTextIsEmpty is the canonical
   * "no visible characters" predicate, shared with any other empty-text
   * consumer); core/derive.isGhostNode calls this hook to grant the
   * dashed-outline/findable-when-Show-Ghosts affordance exactly while the box
   * would otherwise render nothing.
   *
   * @example textPlugin.isGhost({ text: { runs: [{ text: "" }], paras: [{}] } })
   * true
   * @example textPlugin.isGhost({ text: { runs: [{ text: "Text" }], paras: [{}] } })
   * false
   */
  isGhost(state) {
    return richTextIsEmpty(state.text);
  },
  defaults: {
    type: "text", x: 120, y: 80, w: 260, h: 48, z: 0, rotation: 0, scale: 1,
    // Rotation pivots about this WORLD point; default = own center (an equation
    // — manifest Round 11). Absent on old docs → derive falls back to center.
    rotationAnchor: { x: "self.anchors.center.x", y: "self.anchors.center.y" },
    // `text` is the RICH-TEXT value {runs, paras} (core/richtext.js). The DEFAULT
    // is the canonical rich shape (one run "Text") — NOT a bare string — so it
    // shares the delta-leaf structure of every rich instance: both fold to the
    // two leaves `text.runs` and `text.paras` (arrays are leaf values to the
    // delta walker, so the run COUNT and its key set never matter), which means
    // document.missingDefaults NEVER mis-flags a rich instance as "missing text"
    // and clobbers it. A LEGACY plain-STRING `text` (old docs / hand-written /
    // make_demo) migrates to this shape LOUDLY at load via
    // core/richtext.withRichTextMigrated (wired in the app repair path); emit()
    // also tolerates an in-memory string on the fly (normalizeRichText).
    //
    // THE RUN AND THE PARAGRAPH CARRY *CONTENT ONLY* — NO STYLE. That is load-
    // bearing, not tidiness. Every style key below (`size`/`color`/`bold`/`font`
    // and `align`/`lineSpacing`/`charSpacing`/`wordSpacing`) is a BOX-LEVEL
    // Inspector row that UNDERLIES the run/paragraph: emit() feeds them to
    // normalizeRichText as `inherited`, and layout feeds them to
    // core/richtext.paraStyleFor as `boxStyle`. Both layerings resolve
    // "what the run/paragraph did NOT set". This default used to materialize all
    // ten run keys and all four paragraph keys, so there was nothing left to
    // resolve and EIGHT box rows moved zero pixels — measured by byte-diffing
    // renderDocToPng.
    //
    // THE NAME FOR THAT DEFECT CLASS IS *SHADOWED*, NOT INERT. Nothing here was
    // dead code and nothing was mis-wired: the widget reads the row, the layering
    // is right, and a unit test on either helper passes. The app's own DEFAULT
    // STATE pre-empted a LIVE FALLBACK — the row was outranked by a value the user
    // never chose. It passes code review precisely because every piece is
    // individually correct; only rendering the real default state reveals it. The
    // rule that prevents the recurrence: A DEFAULT MAY NOT MATERIALIZE A KEY THAT
    // A LOWER-PRECEDENCE LAYER EXISTS TO SUPPLY.
    //
    // The rendered result is UNCHANGED (proven by byte-diff): a bare run resolves
    // through runFrom to exactly the keys that were stamped here — bold/italic/
    // underline/strike false, size 36, DEFAULT_FONT, color #000000, and the
    // Round 13.4 outline/highlight OFF defaults (outlineWidth 0, highlight "").
    text: { runs: [{ text: "Text" }], paras: [{}] },
    // Widget-level style the single migrated run inherits AND the per-paragraph
    // layout falls back to (font/size/color/bold are run-inherited; the para
    // keys below are the box's one-alignment-per-box defaults — SET-1 Inspector).
    size: DEFAULT_PARA_SIZE, color: "#000000", bold: false, font: DEFAULT_FONT, opacity: 1,
    // Paragraph-level defaults for the whole box (each paragraph may override in
    // paras[i] via the SET-2 UX). align ∈ left|center|right|justify.
    align: "left", lineSpacing: 1, charSpacing: 0, wordSpacing: 0,
    // VERTICAL alignment of the whole line stack within the box height h
    // (Round 15.6). BOX-level (not per-paragraph, unlike `align`): top|middle|
    // bottom. Default "top" reproduces the historical top-anchored layout
    // exactly, so old docs render byte-identically (core/richtext.valignOffset
    // returns 0 for "top"). A plain-string leaf → repair's missingDefaults
    // fills it with "top" on old text items (no render change).
    valign: "top",
    ...bundleNestedDefaults("effects"), // shadow/bloom/blendMode, all EFFECT-OFF (Round 12D)
  },
  // `category` groups rows into the Inspector's collapsible accordion regions.
  //
  // WHERE THE TEXT LIVES, AND WHY THE PANEL USED TO SAY NOTHING ABOUT IT (R6-13.3).
  // The content is an ORDINARY property — `items.<id>.text = {runs, paras}` — folded,
  // keyframed, tweened and undone by exactly the generic machinery every other
  // property uses. Nothing here is hidden or privileged. What was missing was a ROW,
  // and this comment used to be the reason: "a plain text input here can't represent
  // runs and would clobber them." The premise was right and the conclusion was too
  // strong. A plain input CLOBBERS only if it writes `{runs: [{text: typed}]}`; a
  // MINIMAL SPLICE (core/richtext.withPlainTextReplaced) writes only the span that
  // actually changed, so every run outside it keeps its style — the same two
  // primitives the canvas editor reaches when you type the same edit.
  //
  // The surface is therefore the CONTENT ROW + ACTION ROW PAIR every other
  // content-bearing widget already ships: mermaid `definition`, latex `latex`,
  // codeblock `code`, graph_line `source`, graph_bars `valueEquation` — and
  // plaintext's own `text` row, which is why the plain widget showed its content in
  // the panel while the rich one showed nothing.
  inspector: [
    // The eight shared bbox rows, COMPOSED from the registry rather than
    // re-typed. They used to be hand-copied literals here — byte-identical to
    // BUNDLES.positioning except for the `help` text they silently lacked, and
    // exactly the copy-paste drift core/properties.js exists to end: the `angle`
    // KIND that put the rotary dial on `rotation` reached every other bbox widget
    // through the bundle and would have skipped this one.
    ...bundle("positioning"),
    // THE CONTENT ITSELF, first among this widget's own rows because it IS the
    // widget. `richtext` is the row kind for a structured value with a plain-text
    // surface (core/properties.js ROW_KINDS): it shows richTextToPlain and writes a
    // MINIMAL SPLICE, so it is a real editor for the content and not a readout —
    // and it carries the KEYFRAME DIAMOND, which is the first place a user can see
    // that rich text keyframes and tweens per run, per key (it always did; nothing
    // rendered the fact). Deliberately NO `ƒ`: `richtext` is out of EQUATION_KINDS
    // because core/expressions.js refuses equations on this value, and an escape
    // hatch that does not exist is the lie this round is removing.
    { key: "text", label: "Text", kind: "richtext", category: "text", help: "The words in the box, as one line. This is the SAME property the canvas editor writes — editing here splices only what you changed, so run styles either side of the edit survive. Newlines already in the text are kept; to add one, or to style part of the text, use the in-place editor below." },
    // THE WAY IN TO THE CONTENT, from the panel rather than from knowing to
    // double-click. Same `action`-row-plus-command idiom mermaid/latex/codeblock
    // use for their code editors, but pointed at the IN-CANVAS rich editor, which
    // is this widget's real one: `edit-code-source` opens Monaco on a STRING
    // property, and {runs, paras} is not one.
    { key: "__edittext", label: "Edit text in place…", kind: "action", command: "edit-text-content", category: "text", help: "Puts the caret in the text box on the canvas, with the formatting toolbar above it — the same editor a double-click opens. Style applies to the SELECTED characters, so one box can hold several sizes, fonts and colors." },
    // Default typography for the box (runs inherit these; SET-2 sets them per-run).
    //
    // EVERY ROW BELOW THAT UNDERLIES A RUN OR A PARAGRAPH DECLARES `visibleWhen`,
    // and it is not cosmetic. These rows are FALLBACKS: runFrom puts the run's own
    // key first and paraStyleFor puts the paragraph's own key last, so a value in
    // which every run (or every paragraph) stores the key leaves the box nothing to
    // supply. Measured on the user's three real decks, every text item is exactly
    // that shape — "Untitled cheese" slide 3 shows this panel reading 36 / system /
    // #1a1a2e while the glyphs render 76 / futura / #000000, so the rows did not
    // merely do nothing, they CONTRADICTED the canvas. The answer is the user's own
    // ruling on stroke width under an off stroke material — "I still have stroke
    // width options even when stroke material is off, which is kind of dumb" — with
    // the same mechanism (core/properties.js strokeMaterialIsOn, seven rows,
    // tests/stroke_off_test.js). ACCEPTED COST: hiding a row hides its `ƒ` with it
    // (the R6-7 gap); a row that reports a value the render ignores is worse.
    // NOT hidden: valign and opacity, which have no per-run/per-paragraph twin and
    // so can never be overridden out from under the box.
    { key: "font", label: "Font", kind: "select", options: fontOptions().map((o) => o.value), optionLabels: Object.fromEntries(fontOptions().map((o) => [o.value, o.label])), category: "text", visibleWhen: boxStyleRowVisibility("font") },
    { key: "size", label: "Size", kind: "number", min: 0, category: "text", visibleWhen: boxStyleRowVisibility("size") },
    { key: "bold", label: "Bold", kind: "boolean", category: "text", visibleWhen: boxStyleRowVisibility("bold") },
    // Paragraph props (box-level; the "one alignment per box" control — SET-2
    // adds per-paragraph). align is a select over the four alignments.
    { key: "align", label: "Align", kind: "select", options: ["left", "center", "right", "justify"], optionLabels: { left: "Left", center: "Center", right: "Right", justify: "Justify" }, category: "text", visibleWhen: boxStyleRowVisibility("align") },
    // VERTICAL alignment is BOX-level (one value per box — the whole line stack
    // moves within h), so a single select row is the right control (unlike the
    // per-paragraph horizontal `align`, whose primary surface is the WYSIWYG
    // toolbar; this box-level valign has no toolbar equivalent). Round 15.6.
    { key: "valign", label: "V-Align", kind: "select", options: ["top", "middle", "bottom"], optionLabels: { top: "Top", middle: "Middle", bottom: "Bottom" }, category: "text" },
    // SCRUB on lineSpacing only. It is a MULTIPLE of the natural line height
    // (core/richtext.js: naturalHeight = (ascent + descent) * lineSpacing), nominal 1
    // — so the values people actually want are 1.15, 1.5, 2. Half-open with an integer
    // default, which is no proof of fractionality, so numberStep.js declined to infer
    // and the row fell back to DraggableNumber's 1 unit per drag-pixel: DRAGGING COULD
    // ONLY REACH WHOLE MULTIPLES. src/lib/numberStep.js's own header names this row as
    // one of the 437 fractional-in-use integer-default rows for exactly this reason;
    // only a declared scrub can reach it. One 100px drag now spans one whole multiple.
    // charSpacing / wordSpacing are PX offsets, but tracking/word-gap adjustments are
    // sub-pixel in practice: 1 px per drag-pixel is too coarse. The fine-bias ruling
    // (2026-07-28) postdates the old "leave them at 1/px like x/y/w/h" argument that
    // stood here — both now declare scrub 0.1 so a comfortable drag sweeps a few px.
    { key: "lineSpacing", label: "Line spacing", kind: "number", min: 0, scrub: UNIT_SPAN_SCRUB, category: "text", visibleWhen: boxStyleRowVisibility("lineSpacing") },
    { key: "charSpacing", label: "Char spacing", kind: "number", scrub: 0.1, category: "text", visibleWhen: boxStyleRowVisibility("charSpacing") },
    { key: "wordSpacing", label: "Word spacing", kind: "number", scrub: 0.1, category: "text", visibleWhen: boxStyleRowVisibility("wordSpacing") },
    { key: "color", label: "Color", kind: "color", category: "formatting", visibleWhen: boxStyleRowVisibility("color") },
    { key: "opacity", label: "Opacity", kind: "number", min: 0, max: 1, category: "formatting" },
    ...bundle("effects"),
  ],
  /**
   * Pure function. State → ONE rich text IR op (local space, top-left origin).
   * Carries the canonical rich value + the box width (wrap) + widget-level
   * paragraph defaults; the backend lays it out. `text`/`size`/`color`/`font`
   * also carry a plain-text fallback (richTextToPlain-ish via the first run) so
   * a backend that can't lay out still draws SOMETHING (never a silent blank).
   * Effects (shadow/bloom/blend — the shared EFFECTS BUNDLE,
   * render_gpu/effects.js) wrap the op; all-off = pass-through. The shadow is
   * the glyphs' own blurred silhouette (per-letter, not the box) since the
   * effect texture holds exactly what the widget painted.
   */
  emit(s, _targetWorldIR, world) {
    // GHOST short-circuit (manifest 13.6 CONDITIONAL GHOSTS): an empty text box
    // (no visible characters) draws NOTHING — same as filmstrip's empty-frames
    // case. Without this the box is a ghost in the EDITOR (isGhost above) but
    // still emits a zero-ink text op into the PRESENTATION/export render, which
    // is the asymmetry the ghost model forbids: a ghost has no rendered volume
    // in ANY backend. Returning [] here makes editor-ghostness and render-
    // exclusion agree (the assertion SonnetE's ghost_test locks).
    if (richTextIsEmpty(s.text)) return [];
    const inherited = { font: s.font ?? DEFAULT_FONT, size: s.size ?? DEFAULT_PARA_SIZE, color: s.color ?? "#000000", bold: s.bold ?? false };
    const rich = normalizeRichText(s.text, inherited);
    const first = rich.runs[0] ?? {};
    return applyEffects([text({
      // plain-text fallback (single-run degrade): the first run's text/style
      text: first.text ?? "",
      x: 0, y: 0,
      size: first.size ?? inherited.size,
      color: first.color ?? inherited.color,
      bold: first.bold ?? inherited.bold,
      font: first.font ?? inherited.font,
      opacity: s.opacity ?? 1,
      // the rich payload the backend actually lays out:
      rich,
      boxW: (s.w ?? 0) > 0 ? s.w : Infinity, // wrap to the box width; 0/absent ⇒ no wrap
      boxH: (s.h ?? 0) > 0 ? s.h : Infinity, // box height ⇒ VERTICAL align room (Round 15.6)
      // boxStyle carries the box-level paragraph defaults + the box-level valign
      // (top|middle|bottom) that layoutRichText offsets the line stack by.
      boxStyle: { align: s.align ?? "left", lineSpacing: s.lineSpacing ?? 1, charSpacing: s.charSpacing ?? 0, wordSpacing: s.wordSpacing ?? 0, valign: s.valign ?? "top" },
    })], s, world, { x: 0, y: 0, w: s.w ?? 0, h: s.h ?? 0 });
  },
  // Effects halo (shadow/bloom spill) extends the cull AABB (core/view.js hook).
  cullMargin: effectsCullMargin,
  anchors: standardBBoxAnchors,
  commands: [
    { id: "add-text", title: "Add Text", icon: "mdi:format-text", run: (app) => app.armCrosshairPlacement(textPlugin) },
    // ENTERING THE EDITOR IS AN ACTION, SO IT IS A COMMAND. Until now the ONLY way
    // in was a double-click on the canvas — an activation hook (web/widget_handlers.js
    // "rich_text_edit"), which the palette cannot search, the keyboard cannot bind
    // and the Inspector cannot offer. The house rule is that the palette, the
    // shortcuts, the toolbar and the panel are all surfacings of ONE action layer,
    // and `edit-code-source` is the standing precedent: the same activation, also
    // published as a command, also surfaced as an Inspector action row.
    //
    // THE GATE READS THE DECLARATION, NOT THE TYPE NAME (widget_handlers.js:
    // "resolution is the declaration and NOTHING else"), so a second widget that
    // ever declares `activate: "rich_text_edit"` is offered this with no edit here —
    // and a plaintext box, whose editor is the plain-string one, is not.
    {
      id: "edit-text-content",
      title: "Edit Text in Place",
      icon: "mdi:cursor-text",
      when: (app) => app.selectedNode()?.plugin?.activate === "rich_text_edit",
      requires: "a selected rich-text box — this puts the caret inside that box's own runs",
      help: "Puts the caret in the selected text box on the canvas, with the formatting toolbar above it. The characters you select are what bold/size/font/color apply to, which is why one box can hold several styles.",
      run: (app) => app.beginTextEdit(app.selection),
    },
  ],
};
