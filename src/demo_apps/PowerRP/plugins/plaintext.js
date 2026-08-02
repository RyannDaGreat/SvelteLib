/**
 * PLAINTEXT widget — a lightweight SINGLE-STRING text box, deliberately DISTINCT
 * from the rich-text widget (plugins/text.js). Where the rich widget stores a
 * {runs, paras} structure and edits per-run style through a floating format bar,
 * this widget stores ONE plain `text` STRING and exposes its styling as ORDINARY
 * Inspector property rows (font / size / bold / colour / align / valign) — no
 * floating bar, no runs. It is the "just some text" primitive: a caption, a
 * label, or an equation-bound readout.
 *
 * ── EQUATION-BINDABLE STRING (no engine change) ───────────────────────────────
 * `text` is a normal item-state leaf, so it rides the UNIVERSAL `=` marker
 * (core/expressions.js): typing `=` in its Inspector field turns it into an
 * equation evaluated up-front by the derive/evaluate path, exactly like every
 * other property. emit() therefore receives the ALREADY-resolved value in `s`
 * and never touches the evaluator. A non-string equation result (e.g. binding
 * the text to a computed number) is coerced with String() so a bound readout
 * displays its value rather than crashing the text() builder (which demands a
 * string) — a sensible coercion, NOT a silent swallow.
 *
 * ── STYLING = SHARED REGISTRY, one text() op ──────────────────────────────────
 * It composes the SHARED PROPERTY REGISTRY like rect.js: the positioning bundle,
 * opacity, and the effects bundle (shadow/bloom/blend). The ink colour reuses the
 * registry's PAINT-capable `fill` prop (relabelled "Color"), so a solid colour
 * OR a linear/radial gradient paints the glyphs for free — the text() IR op runs
 * `color` through parsePaint. emit() builds exactly ONE existing ir.js text() op
 * (a LEGACY single-run op — no `rich` payload) from the single string + style
 * props, carrying `boxStyle` {align, valign} + boxW/boxH so the renderer's shared
 * layout aligns/wraps it (the Skia backend wraps a legacy op via singleRunRich).
 * No new IR op; no plugin imports another.
 *
 * ── GHOST-ON-EMPTY ────────────────────────────────────────────────────────────
 * A blank/whitespace-only string is an EXPECTED "nothing typed yet" state (the
 * mermaid/qr convention), not a failure: emit() returns [] and isGhost() grants
 * the dashed-outline/findable affordance, so an empty plaintext draws nothing and
 * never crashes.
 */

import { EPHEMERAL } from "../core/ephemeral.js";
import { storedItemRef } from "../core/expressions.js";
import { standardBBoxAnchors } from "../core/derive.js";
import { textInkBounds } from "../core/richtext.js";
import { inkMeasure } from "../core/ink_metrics.js";
import { bundle, bundleNestedDefaults, defaults, props } from "../core/properties.js";
import { text } from "../render_gpu/ir.js";
import { DEFAULT_FONT, fontOptions } from "../render_gpu/fonts.js";
import { applyEffects, effectsCullMargin } from "../render_gpu/effects.js";

// The app's default text size, in canvas units — matches plugins/text.js's 36u
// default so a plaintext box and a rich-text box read at the same size out of the
// box (one shared convention, not a fresh per-widget number).
const DEFAULT_TEXT_SIZE = 36;

// The four horizontal + three vertical alignment options (with human labels),
// mirroring plugins/text.js's box/paragraph alignment controls. valign moves the
// whole line stack within the box height h (core/richtext.valignOffset).
const ALIGN_OPTIONS = ["left", "center", "right", "justify"];
const ALIGN_LABELS = { left: "Left", center: "Center", right: "Right", justify: "Justify" };
const VALIGN_OPTIONS = ["top", "middle", "bottom"];
const VALIGN_LABELS = { top: "Top", middle: "Middle", bottom: "Bottom" };

/**
 * Pure function. Is a plaintext value EMPTY — blank, whitespace-only, or
 * absent, so there is nothing to draw yet? The ONE canonical predicate driving
 * BOTH the ghost hook and emit()'s short-circuit (the mermaid/qr ghost
 * convention). An empty string is an EXPECTED state (a freshly-added box, or one
 * the user cleared), NOT a failure. A non-string value (an equation result) is
 * coerced with String() first so a bound numeric readout is never mis-flagged
 * as empty.
 *
 * @param {*} value - the text leaf (string, or an equation-resolved value)
 * @returns {boolean}
 *
 * @example plaintextIsEmpty("")        // true
 * @example plaintextIsEmpty("   ")     // true (whitespace-only — nothing to draw)
 * @example plaintextIsEmpty(null)      // true
 * @example plaintextIsEmpty("Hello")   // false
 * @example plaintextIsEmpty(0)         // false (a bound number renders as "0")
 */
export function plaintextIsEmpty(value) {
  return value === null || value === undefined || String(value).trim() === "";
}

/**
 * Query (reads the installed ink measure — core/ink_metrics.inkMeasure, which is
 * module state and reports once when it is the monospace fallback). The LOCAL INK
 * rect of a plaintext box: where the laid-out type ACTUALLY is, which is not the
 * property box whenever the text overflows it.
 *
 * This is the plugin's BOUNDS-protocol answer (core/view.js localBoundsOf) and it
 * is exported because three consumers need the same rect and must not each
 * recompute it their own way: the hook below, the dashed INK-BOUNDS ghost, and
 * the "Set size to ink bounds" command that writes this rect into w/h.
 *
 * The state is a SINGLE STRING, so it is wrapped as a one-run rich value with the
 * widget's own style — the same shape emit() hands the renderer via the text() op
 * (which getTextLayout wraps identically through singleRunRich). One string, one
 * style, one layout: the rect and the glyphs come from the same description.
 *
 * AN EMPTY BOX HAS NO INK, and reports the ZERO-SIZE rect at the origin rather
 * than its box. That is consistent with emit() (which returns [] — it draws
 * nothing) and it is what keeps the empty-box GHOST affordance meaningful: an
 * empty plaintext is findable through isGhost, not by pretending to have ink.
 *
 * @param {object} state - the folded, equation-evaluated item state
 * @returns {{x: number, y: number, w: number, h: number}} local-unit ink rect
 *
 * @example plaintextInkBounds({ text: "" }) // {x: 0, y: 0, w: 0, h: 0} (nothing drawn)
 * @example // a caption whose two lines overflow a one-line-tall box reports the TALLER rect:
 * @example // plaintextInkBounds({text: "long enough to wrap", w: 100, h: 20, size: 36}).h > 20 // true
 */
export function plaintextInkBounds(state) {
  if (plaintextIsEmpty(state.text)) return { x: 0, y: 0, w: 0, h: 0 };
  const w = state.w ?? 0, h = state.h ?? 0;
  const size = state.size ?? DEFAULT_TEXT_SIZE;
  const rich = {
    runs: [{ text: String(state.text), size, font: state.font ?? DEFAULT_FONT, bold: !!state.bold, color: state.fill ?? "#000000" }],
    paras: [{}],
  };
  const boxStyle = { align: state.align ?? "left", valign: state.valign ?? "top" };
  // The SAME box emit() lays out in: a 0/absent w means "no wrap" (Infinity), and
  // a 0/absent h means "no vertical box" — mirrored from emit() rather than
  // restated, so the rect and the draw can never disagree about the box.
  return textInkBounds(rich, w > 0 ? w : Infinity, inkMeasure(), boxStyle, h > 0 ? h : Infinity);
}

/**
 * PLAINTEXT LOOKS — whole looks for the app's "just some text" primitive: a
 * caption, a label, a sign, a readout.
 *
 * ONE FLAT FAMILY, not the two-family split plugins/text.js gets, and the reason is
 * measured rather than stylistic: that widget has NINE type-system knobs (it adds
 * lineSpacing / charSpacing / wordSpacing) and can carry a type-role family on its
 * own. This one has five, because emit() below passes a boxStyle of {align, valign}
 * ONLY — there is no tracking and no leading here at all. A role family over five
 * knobs would produce rows differing in nothing but face and size. Every caps idiom
 * that is DEFINED by its tracking therefore lives on the rich text widget instead.
 *
 * ORDERED BY KIND, then by descending size within a kind: display signs, labels,
 * screen readouts, annotation. Kind leads because these are alternative WHOLE looks
 * and the question a reader is asking is "what sort of thing is this text", not
 * "how big" — the opposite of the rich widget's type-specimen ordering, on purpose.
 *
 * `fill` IS THE INK HERE, not a box fill — this widget has no box. It is the
 * paint-capable registry prop, so a gradient would be legal too; every row below is
 * a solid, because a gradient's angle and stops are a decision about one particular
 * slide's palette rather than a reusable look.
 *
 * A WHOLE-LOOK FAMILY WRITES EVERY LOOK KNOB IN EVERY ROW, INCLUDING THE OFF STATES
 * — the rule stated at plugins/demo/lens_flare.js and plugins/demo/sky.js, and it
 * is the reason the five universal EFFECTS appear here even though only four rows
 * use one. Application is an OVERLAY: a key a preset omits keeps whatever the
 * PREVIOUSLY hovered row left there, so without `bloom` spelled out, hovering Neon
 * Sign and then clicking Footnote gives you a glowing footnote. A PARTIAL nested
 * object MERGES rather than replacing, so each nested effect is written COMPLETE
 * (all five shadow keys, both bloom keys) — `shadow: {opacity: 0}` alone would keep
 * the last row's blur and colour. The off states: shadow and innerShadow are off at
 * opacity 0 (their declared render gate, core/properties.js), bloom at strength 0.
 *
 * NO PRESET WRITES `text`. It is the user's own words, and it may hold an `=`
 * equation — overwriting one with a literal is exactly what beginTextEdit already
 * refuses to do (see `activate` below), so a preset must not do it either.
 *
 * THE FEATHER IS USABLE HERE AND IS ALL BUT UNUSABLE ON THE RICH TEXT WIDGET, for a
 * structural reason worth knowing: `softEdges` ERODES the glyph silhouette before
 * blurring it (render_gpu/skia/paint_skia.js featherEdges), so a value that reads as
 * chalk at 44 units erases 22-unit type. This is one FLAT family, so the same row
 * sets both `size` and `softEdges` and can keep the feather under the stem width.
 * The rich widget's two families are orthogonal, so its ink half cannot know the
 * size — one measured fact, two different answers.
 *
 * "Broadcast Caption" deliberately shares its name with the rich text widget's type
 * role of the same name: same idiom, two widgets, one name (the sibling-naming
 * convention — a preset applies to ONE item, so a look that spans widgets is paired
 * by NAME rather than by a cross-item mechanism).
 */
const PLAINTEXT_LOOKS = [
  // ── display signs ──────────────────────────────────────────────────────────
  {
    name: "Watermark",
    description: "The giant ghosted word behind the content — flat black at seven percent in a light geometric sans, centred and filling its box.",
    props: {
      font: "jost", size: 200, bold: false, align: "center", valign: "middle",
      fill: "#000000", opacity: 0.07, blendMode: "normal", softEdges: 0,
      shadow: { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 },
      bloom: { radius: 10, strength: 0 },
      innerShadow: { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 },
    },
  },
  {
    name: "Poster Headline",
    description: "Screen-printed poster type: heavy condensed caps with a hard, unblurred amber shadow thrown down and to the right, so the letters read as cut paper. Type in caps.",
    props: {
      font: "oswald", size: 120, bold: true, align: "center", valign: "top",
      fill: "#111111", opacity: 1, blendMode: "normal", softEdges: 0,
      shadow: { dx: 5, dy: 6, blur: 0, color: "#f2c14e", opacity: 1 },
      bloom: { radius: 10, strength: 0 },
      innerShadow: { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 },
    },
  },
  {
    name: "Slide Title",
    description: "The plain opening line of a deck — a geometric sans at display size, bold, centred in its box, in a near-black that is softer than pure ink.",
    props: {
      font: "montserrat", size: 96, bold: true, align: "center", valign: "middle",
      fill: "#12161c", opacity: 1, blendMode: "normal", softEdges: 0,
      shadow: { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 },
      bloom: { radius: 10, strength: 0 },
      innerShadow: { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 },
    },
  },
  {
    name: "Neon Sign",
    description: "Cold-cathode cyan: a mono-line geometric face, which is what a bent glass tube actually looks like, under a wide bloom plus the teal it throws on the wall behind it. For a dark slide.",
    props: {
      font: "jost", size: 88, bold: false, align: "center", valign: "middle",
      fill: "#2bf3ff", opacity: 1, blendMode: "normal", softEdges: 0,
      shadow: { dx: 0, dy: 0, blur: 12, color: "#0a4a55", opacity: 0.6 },
      bloom: { radius: 28, strength: 1.2 },
      innerShadow: { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 },
    },
  },
  {
    name: "Gold Plate",
    description: "Engraved gold on a dark ground — a high-contrast display serif in old gold, seated by a short brown shadow and lifted by just enough bloom to catch the light.",
    props: {
      font: "playfair-display", size: 64, bold: false, align: "center", valign: "middle",
      fill: "#c9a227", opacity: 1, blendMode: "normal", softEdges: 0,
      shadow: { dx: 1, dy: 1.5, blur: 1.5, color: "#3a2c05", opacity: 0.6 },
      bloom: { radius: 8, strength: 0.3 },
      innerShadow: { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 },
    },
  },
  // ── labels ─────────────────────────────────────────────────────────────────
  {
    name: "Broadcast Caption",
    description: "The subtitle setting to broadcast spec: a plain sans at seven percent of frame height, white with a tight solid shade all round so it survives any footage behind it.",
    props: {
      font: "system", size: 72, bold: false, align: "center", valign: "bottom",
      fill: "#ffffff", opacity: 1, blendMode: "normal", softEdges: 0,
      shadow: { dx: 0, dy: 0, blur: 4, color: "#000000", opacity: 1 },
      bloom: { radius: 10, strength: 0 },
      innerShadow: { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 },
    },
  },
  {
    name: "Price Tag",
    description: "The number on the shelf edge — heavy condensed type ranged hard right in a retail red, so the figure sits at the edge of its ticket.",
    props: {
      font: "oswald", size: 72, bold: true, align: "right", valign: "middle",
      fill: "#c0392b", opacity: 1, blendMode: "normal", softEdges: 0,
      shadow: { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 },
      bloom: { radius: 10, strength: 0 },
      innerShadow: { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 },
    },
  },
  {
    name: "Rubber Stamp",
    description: "Inked and pressed: condensed bold in a dull brick red at slightly less than full opacity, because a stamp never lays ink down evenly. Type in caps.",
    props: {
      font: "oswald", size: 56, bold: true, align: "center", valign: "middle",
      fill: "#b5322b", opacity: 0.85, blendMode: "normal", softEdges: 0,
      shadow: { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 },
      bloom: { radius: 10, strength: 0 },
      innerShadow: { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 },
    },
  },
  {
    name: "Lower Third Name",
    description: "The name strap: bold sans ranged left at the bottom of its box, white with a soft dark halo so it holds against whatever is behind the lower third.",
    props: {
      font: "inter", size: 50, bold: true, align: "left", valign: "bottom",
      fill: "#ffffff", opacity: 1, blendMode: "normal", softEdges: 0,
      shadow: { dx: 0, dy: 0, blur: 6, color: "#000000", opacity: 0.85 },
      bloom: { radius: 10, strength: 0 },
      innerShadow: { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 },
    },
  },
  {
    name: "Deck Caption",
    description: "The small grey line under a figure — plain sans, no effects, in the muted ink a caption uses so it never competes with the thing it describes.",
    props: {
      font: "inter", size: 22, bold: false, align: "left", valign: "top",
      fill: "#5c6370", opacity: 1, blendMode: "normal", softEdges: 0,
      shadow: { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 },
      bloom: { radius: 10, strength: 0 },
      innerShadow: { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 },
    },
  },
  {
    name: "Footnote",
    description: "The credit or source line at the very bottom of the slide: a text serif at the smallest readable size, in a soft grey, parked against the bottom of its box.",
    props: {
      font: "source-serif", size: 18, bold: false, align: "left", valign: "bottom",
      fill: "#6b7280", opacity: 1, blendMode: "normal", softEdges: 0,
      shadow: { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 },
      bloom: { radius: 10, strength: 0 },
      innerShadow: { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 },
    },
  },
  // ── screen readouts ────────────────────────────────────────────────────────
  {
    name: "Green Terminal",
    description: "The green screen, at exactly the size that gives eighty monospace columns across a full-width slide — the 525-nanometre phosphor with the glow a lit stroke has. For a dark slide.",
    props: {
      font: "jetbrains-mono", size: 36, bold: false, align: "left", valign: "top",
      fill: "#33ff33", opacity: 1, blendMode: "normal", softEdges: 0,
      shadow: { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 },
      bloom: { radius: 14, strength: 0.7 },
      innerShadow: { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 },
    },
  },
  {
    name: "Amber Terminal",
    description: "The amber monitor, smaller and softer than the green one: the 602-nanometre phosphor, and a slight feather on the strokes for the longer persistence that tube has.",
    props: {
      font: "jetbrains-mono", size: 26, bold: false, align: "left", valign: "top",
      fill: "#ffb000", opacity: 1, blendMode: "normal", softEdges: 0.3,
      shadow: { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 },
      bloom: { radius: 10, strength: 0.45 },
      innerShadow: { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 },
    },
  },
  {
    name: "Blueprint Annotation",
    description: "A dimension note on a cyanotype: small monospace in a cold near-white at slightly under full opacity, ranged left, with nothing added. For a dark or cyanotype ground.",
    props: {
      font: "jetbrains-mono", size: 24, bold: false, align: "left", valign: "top",
      fill: "#e8f1ff", opacity: 0.95, blendMode: "normal", softEdges: 0,
      shadow: { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 },
      bloom: { radius: 10, strength: 0 },
      innerShadow: { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 },
    },
  },
  // ── annotation ─────────────────────────────────────────────────────────────
  {
    name: "Chalk Note",
    description: "Written on a board — a warm off-white that never reaches paper-white, a little dust around each stroke, and the stroke edges feathered because chalk has no clean edge.",
    props: {
      font: "lora", size: 44, bold: false, align: "left", valign: "top",
      fill: "#f2ede4", opacity: 0.92, blendMode: "normal", softEdges: 0.8,
      shadow: { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 },
      bloom: { radius: 6, strength: 0.25 },
      innerShadow: { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 },
    },
  },
];

/**
 * Pure function. The property overrides for a CENTER TEXT — a plaintext box bound
 * by `=` equations to sit centered on another widget, and to STAY centered when
 * that widget moves OR resizes.
 *
 * User request (2026-08-02): "a tool that is 'add center text' which adds text to
 * the center of a widget(s) and binds it to cy and cx of that widget, with
 * centered vertical and horz for that text."
 *
 * THE BINDING: the box is made to COVER the target — x/y/w/h each read the
 * target's own — and the glyphs are then centered INSIDE it by align/valign. So
 * "centered on the target" is expressed as "same box, centered content", which is
 * what makes it survive a resize as well as a move: all four equations re-evaluate
 * together, and no fifth quantity has to agree with them.
 *
 * WHY NOT `= @t.cx - self.w / 2` ON x ALONE. `cx`/`cy` ARE readable
 * (core/expressions.js resolves them from core/geometry.js boxCenter) and
 * self-reference in a stored equation is legal — plugins/tangent_lines.js
 * telescopicLensOverrides writes exactly that form. It would center the box
 * correctly. But it leaves `w`/`h` FREE, so the text box keeps whatever size it
 * was created at: the glyphs then center on the target's center while WRAPPING at
 * a width that has nothing to do with the target, and a valign of "middle" centers
 * them in a box height that likewise does not follow. Covering the target makes
 * the wrap width and the vertical stack room track the thing the text labels,
 * which is the honest reading of "centered vertical and horz for that text".
 *
 * The equations reference the target by its STORED `@id` form (storedItemRef), NOT
 * by slug: a rename then needs no document rewrite (core/expressions.js's stated
 * design decision), so renaming the target never breaks the binding.
 *
 * `w`/`h` are read RAW, sign included. A flipped target (negative w — core/geometry
 * "THE FLIP") hands its negative width straight to the label, which lands the box
 * on the same footprint for the same reason boxCenter is sign-independent.
 *
 * Args:
 *   targetId (string): the itemId of the widget to center on
 *
 * Returns:
 *   object: property overrides for a plaintext item (equation strings + alignment)
 *
 * @example centerTextOverrides("ab12cd34").x // "= @ab12cd34.x"
 * @example centerTextOverrides("ab12cd34").w // "= @ab12cd34.w"
 * @example centerTextOverrides("ab12cd34").align // "center"
 * @example centerTextOverrides("ab12cd34").valign // "middle"
 * @example // the whole dict — four equations that re-evaluate together, plus the two alignments:
 * @example // {type: "plaintext", x: "= @ab12cd34.x", y: "= @ab12cd34.y", w: "= @ab12cd34.w", h: "= @ab12cd34.h", align: "center", valign: "middle", text: ""}
 * @example // centerTextOverrides("Do_it") throws — a "_" in an id would resolve to a different item
 */
export function centerTextOverrides(targetId) {
  return {
    type: "plaintext",
    x: `= ${storedItemRef(targetId, ".x")}`,
    y: `= ${storedItemRef(targetId, ".y")}`,
    w: `= ${storedItemRef(targetId, ".w")}`,
    h: `= ${storedItemRef(targetId, ".h")}`,
    align: "center",
    valign: "middle",
    // EMPTY, not "Text". The new box becomes the selection so the user can type
    // immediately, and a placeholder word would have to be deleted first. An empty
    // plaintext is an expected state, not a broken one — isGhost() above grants it
    // the dashed-outline affordance precisely so a blank box stays findable.
    text: "",
  };
}

export const plaintextPlugin = {
  type: "plaintext",
  ephemeral: EPHEMERAL.NONE,
  title: "Plain Text",
  // resizable:true → the standard 8 resize handles (same machinery as rect/text);
  // w constrains word-wrap, h gives the vertical-align stack its room.
  capabilities: { bbox: true, transform: true, resizable: true, backdrop: false },
  presets: PLAINTEXT_LOOKS,
  // ── INLINE WYSIWYG EDITING (opt-in; REUSES the rich text widget's editor) ─────
  // Double-clicking a plaintext box on the canvas enters the SAME Skia-owned
  // in-place editor the rich text widget uses (web/TextEditController), but in
  // PLAIN-STRING mode: it edits this widget's single `text` string directly (no
  // {runs, paras}, NO floating format toolbar), committing the typed string as a
  // keyframed change on the current slide — the box updates live per keystroke.
  // `activate` is what ROUTES the double-click here (web/widget_handlers.js, phase
  // "activate"); `inlineTextEdit` is the editor's CONTENT — which string leaf it
  // binds and in which mode. Both are declarative, so any future single-string
  // widget gets the editor by declaring the pair. The controller reads `plain` to
  // flatten its rich editing model to a plain string at the stored-value boundary.
  // An `=` equation-bound `text` is NOT opened this way (in-place editing would
  // overwrite the equation with its computed value) — beginTextEdit no-ops it and
  // routes the user to the Inspector's equation field (the mermaid/codeblock
  // "equations live in the Inspector" precedent). `property` names WHICH string
  // leaf the editor binds.
  activate: "inline_text_edit",
  inlineTextEdit: { property: "text", plain: true },
  /**
   * Pure function. Is this box currently a GHOST? STATE-dependent — a plaintext
   * box is a ghost only while its string is empty/blank (plaintextIsEmpty, shared
   * with emit()'s short-circuit); core/derive.isGhostNode calls this to grant the
   * dashed-outline/findable-when-Show-Ghosts affordance exactly while the box
   * would otherwise render nothing — the same opt-in the empty text/mermaid/qr
   * widgets make.
   *
   * @param {object} state - the folded item state
   * @returns {boolean}
   *
   * @example plaintextPlugin.isGhost({ text: "" })      // true
   * @example plaintextPlugin.isGhost({ text: "Hello" }) // false
   */
  isGhost(state) {
    return plaintextIsEmpty(state.text);
  },
  // defaults COMPOSE from the SHARED REGISTRY: positioning coords + opacity +
  // effects-off, exactly like rect.js. `text` is a plain STRING (NOT a {runs,
  // paras} rich value — the whole point of this widget). `fill` is the glyph ink
  // (paint-capable via the registry `fill` prop); the registry declares no
  // default for it, so it is supplied here (matching text.js's #000000 ink).
  defaults: {
    type: "plaintext", x: 120, y: 80, w: 260, h: 60, z: 0, rotation: 0, scale: 1,
    // Rotation pivots about this WORLD point; default = own center (an equation
    // — manifest Round 11). Absent on old docs → derive falls back to center.
    rotationAnchor: { x: "self.anchors.center.x", y: "self.anchors.center.y" },
    text: "Text",
    font: DEFAULT_FONT, size: DEFAULT_TEXT_SIZE, bold: false,
    fill: "#000000", align: "left", valign: "top",
    ...defaults("opacity"), // opacity:1
    ...bundleNestedDefaults("effects"), // shadow/bloom/blendMode, all EFFECT-OFF
  },
  // Rows grouped into the Inspector accordion via each row's `category`. The
  // string CONTENT + typography live in "text"; the ink + opacity in
  // "formatting"; position in "positioning"; the shared effects bundle last.
  inspector: [
    ...bundle("positioning"),
    // The single string. kind "text" is an ordinary field (the qr/codeblock
    // precedent) that also accepts an `=` equation — this is the widget's whole
    // "single equation-bindable string" surface, with NO floating format bar.
    { key: "text", label: "Text", kind: "text", category: "text", help: "The text this box displays. Type freely, or start with '=' to bind it to an equation (e.g. a computed value shown as text)." },
    { key: "font", label: "Font", kind: "select", options: fontOptions().map((o) => o.value), optionLabels: Object.fromEntries(fontOptions().map((o) => [o.value, o.label])), category: "text", help: "The typeface the text is drawn in." },
    { key: "size", label: "Size", kind: "number", min: 0, category: "text", help: "Font size in canvas units. Larger is bigger on the slide." },
    { key: "bold", label: "Bold", kind: "boolean", category: "text", help: "Draw the text in the font's bold weight." },
    { key: "align", label: "Align", kind: "select", options: ALIGN_OPTIONS, optionLabels: ALIGN_LABELS, category: "text", help: "Horizontal alignment of the text within the box width: left, center, right, or justified." },
    { key: "valign", label: "V-Align", kind: "select", options: VALIGN_OPTIONS, optionLabels: VALIGN_LABELS, category: "text", help: "Vertical placement of the line stack within the box height: top, middle, or bottom." },
    // Ink color reuses the PAINT-capable registry `fill` prop (solid OR
    // linear/radial gradient), relabelled for a text widget; text() runs it
    // through parsePaint so a gradient fills the glyphs.
    ...props("fill", { fill: { label: "Color", category: "formatting", help: "The color or gradient the glyphs are painted with. Pick a solid color or a linear/radial gradient." } }),
    ...props("opacity"),
    ...bundle("effects"),
  ],
  /**
   * Pure function. State → ONE existing ir.js text() op (local space, top-left
   * origin) built from the single string + style props — no new IR op, no rich
   * payload (a LEGACY single-run op; the Skia backend wraps it via singleRunRich
   * and applies boxStyle's align/valign + boxW wrap). Effects (the shared EFFECTS
   * BUNDLE, render_gpu/effects.js) wrap the op; all-off = pass-through.
   *
   * GHOST short-circuit (the mermaid/qr convention): a blank/whitespace-only
   * string draws NOTHING (returns []), so a fresh or cleared box emits no ink in
   * ANY backend and isGhost keeps it selectable. An equation-resolved non-string
   * value is String()-coerced (a bound readout), never a silent blank.
   *
   * @param {object} s - the folded, equation-evaluated item state
   * @param {*} _targetWorldIR - unused (bbox widget)
   * @param {object} world - the item's world transform (effects halo mapping)
   * @returns {object[]} display-list commands
   */
  emit(s, _targetWorldIR, world) {
    if (plaintextIsEmpty(s.text)) return []; // GHOST — draws nothing
    const w = s.w ?? 0, h = s.h ?? 0;
    return applyEffects([text({
      text: String(s.text),
      x: 0, y: 0,
      size: s.size ?? DEFAULT_TEXT_SIZE,
      color: s.fill ?? "#000000",
      bold: s.bold ?? false,
      font: s.font ?? DEFAULT_FONT,
      opacity: s.opacity ?? 1,
      boxW: w > 0 ? w : Infinity, // wrap to the box width; 0/absent ⇒ no wrap
      boxH: h > 0 ? h : Infinity, // box height ⇒ vertical-align room
      boxStyle: { align: s.align ?? "left", valign: s.valign ?? "top" },
    })], s, world, { x: 0, y: 0, w, h });
  },
  // THE BOUNDS PROTOCOL (core/view.js localBoundsOf): a text box's INK is the
  // laid-out type, NOT the property box — type overflows the bottom of a short
  // box and an unbreakable word overruns a narrow one. Declaring this is what
  // stops overflowing text being culled, missed by a band, cropped out of an
  // export capture rect, and (the reported symptom) unclickable. ORTHOGONAL to
  // `cullMargin` below, which is the effects halo AROUND this ink.
  localBounds: plaintextInkBounds,
  // Effects halo (shadow/bloom spill) extends the cull AABB (core/view.js hook).
  cullMargin: effectsCullMargin,
  // Anchors sit on the bbox rim (the shared standard anchors) — same choice
  // plugins/text.js makes; a text box's selectable frame IS its bounding box.
  anchors: standardBBoxAnchors,
  commands: [
    // Arms crosshair placement (the SAME gesture every Add button uses —
    // CanvasView drives click-drag-places off the plugin's type + .defaults).
    { id: "add-plaintext", title: "Add Plain Text", icon: "mdi:format-text-variant", run: (app) => app.armCrosshairPlacement(plaintextPlugin) },
  ],
};
