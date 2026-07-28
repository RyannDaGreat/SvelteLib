/**
 * Text-Morph DEMO WIDGETS — three insertable widgets (one per string transition)
 * that let you TWEEN BETWEEN WORDS without hand-typing an equation. They are the
 * friendly face of core/text_transitions.js (the pure, deterministic transitions
 * registered in the equation FUNCTIONS table): where a power user could type
 * `= text_dissolve("A", "B", progress)` into any string field, these widgets
 * expose the words and the progress as ordinary CUSTOM self.* properties
 * (core/properties.js customProps — the same Blender-style mechanism the Demo
 * Showcase proves), so you just edit the knobs in the Inspector.
 *
 *   Text Dissolve   — custom props: from, to, alpha → text_dissolve(from, to, alpha)
 *   Text Typewriter — custom props: source, alpha    → text_type(source, alpha)
 *   Text Scramble   — custom props: source, alpha    → text_scramble(source, alpha)
 *
 * `alpha` is a plain keyframable 0..1 number: scrub it to preview, or keyframe it
 * across two slides and the text ANIMATES during the transition (the transitions
 * are pure functions of alpha, so the tween drives them for free — RenderTree =
 * pure(document, alpha)). Rendered exactly like the plaintext widget: one legacy
 * ir.js text() op through the shared box layout + effects bundle. Each consumes
 * its custom props DIRECTLY in emit() (the Demo Showcase pattern — a declared
 * self.* prop visibly affecting the render), so nothing routes through a hidden
 * text equation the user would have to remember.
 *
 * Surfaced ONLY through the "Add Demo Widget" submenu (web/App.svelte); no
 * top-level commands, keeping the core Add menus clean. Defined in ONE file that
 * exports an ARRAY of plugins (the shapeshifter.js precedent) — the three widgets
 * are 90% identical, so a factory keeps them DRY. DOM-free / bare-node-safe at
 * import time (mirrors plaintext.js's import set), so plugins/index.js stays
 * importable under `node tests/core_test.js`.
 */

import { standardBBoxAnchors } from "../../core/derive.js";
import { bundle, bundleNestedDefaults, customProps, defaults, props } from "../../core/properties.js";
import { text } from "../../render_gpu/ir.js";
import { DEFAULT_FONT, fontOptions } from "../../render_gpu/fonts.js";
import { applyEffects, effectsCullMargin } from "../../render_gpu/effects.js";
import { textDissolve, textType, textScramble } from "../../core/text_transitions.js";

// Shared text-box constants — matches plugins/plaintext.js so a morph box reads
// at the same size/alignment as a plain text box out of the gate.
const DEFAULT_TEXT_SIZE = 36;
const ALIGN_OPTIONS = ["left", "center", "right", "justify"];
const ALIGN_LABELS = { left: "Left", center: "Center", right: "Right", justify: "Justify" };
const VALIGN_OPTIONS = ["top", "middle", "bottom"];
const VALIGN_LABELS = { top: "Top", middle: "Middle", bottom: "Bottom" };
// Mid-morph by default so a freshly inserted widget SHOWS the effect immediately
// (a fully-resolved alpha of 1 would look like a plain text box).
const DEFAULT_ALPHA = 0.5;

// The progress knob every morph widget shares — a plain keyframable 0..1 number.
const ALPHA_PROP = {
  name: "alpha",
  kind: "number",
  default: DEFAULT_ALPHA,
  min: 0,
  max: 1,
  help: "Morph progress from 0 to 1. Scrub it to preview; keyframe it across two slides and the text animates during the transition.",
};

/**
 * Pure function. Is a rendered string EMPTY (nothing to draw)? Mirrors
 * plaintext's ghost predicate WITHOUT importing that plugin (no plugin may import
 * another). A blank/whitespace-only result draws nothing rather than an empty box.
 *
 * @param {string} str - the morphed display string
 * @returns {boolean}
 *
 * @example isBlank("") // true
 * @example isBlank("   ") // true
 * @example isBlank("Hi") // false
 */
function isBlank(str) {
  return String(str ?? "").trim() === "";
}

/**
 * Pure function (factory). Builds one text-morph DEMO widget plugin. All three
 * widgets share the plaintext-style box (positioning + typography + ink +
 * opacity + effects); they differ ONLY in their word inputs and which transition
 * maps those inputs + alpha to the displayed string.
 *
 * @param {object} config
 * @param {string} config.type - the widget type id (e.g. "demo_text_dissolve")
 * @param {string} config.title - the human title (Inspector + submenu)
 * @param {object[]} config.wordProps - customProps defs for the word input(s)
 * @param {(state: object) => string} config.morph - state → the displayed string
 * @returns {object} a plugin object (defaults, inspector, emit, anchors)
 *
 * @example // makeTextMorphPlugin({type: "demo_text_type", title: "Text Typewriter",
 * @example //   wordProps: [{name: "source", kind: "text", default: "Reveal"}],
 * @example //   morph: (s) => textType(s.source, s.alpha)}).type === "demo_text_type"
 */
function makeTextMorphPlugin({ type, title, wordProps, morph }) {
  const custom = customProps([...wordProps, ALPHA_PROP]);
  return {
    type,
    title,
    capabilities: { bbox: true, transform: true, resizable: true, backdrop: false },
    defaults: {
      type, x: 120, y: 80, w: 320, h: 60, z: 0, rotation: 0, scale: 1,
      rotationAnchor: { x: "self.anchors.center.x", y: "self.anchors.center.y" },
      font: DEFAULT_FONT, size: DEFAULT_TEXT_SIZE, bold: false,
      fill: "#000000", align: "left", valign: "top",
      ...defaults("opacity"), // opacity:1
      ...bundleNestedDefaults("effects"), // shadow/bloom/blendMode, all EFFECT-OFF
      ...custom.defaults, // the word input(s) + alpha (custom self.* props)
    },
    inspector: [
      ...bundle("positioning"),
      ...custom.rows, // the morph knobs FIRST (the point of the widget): words + alpha
      { key: "font", label: "Font", kind: "select", options: fontOptions().map((o) => o.value), optionLabels: Object.fromEntries(fontOptions().map((o) => [o.value, o.label])), category: "text", help: "The typeface the text is drawn in." },
      { key: "size", label: "Size", kind: "number", min: 0, category: "text", help: "Font size in canvas units." },
      { key: "bold", label: "Bold", kind: "boolean", category: "text", help: "Draw the text in the font's bold weight." },
      { key: "align", label: "Align", kind: "select", options: ALIGN_OPTIONS, optionLabels: ALIGN_LABELS, category: "text", help: "Horizontal alignment within the box width." },
      { key: "valign", label: "V-Align", kind: "select", options: VALIGN_OPTIONS, optionLabels: VALIGN_LABELS, category: "text", help: "Vertical placement of the line stack within the box height." },
      ...props("fill", { fill: { label: "Color", category: "formatting", help: "The color or gradient the glyphs are painted with." } }),
      ...props("opacity"),
      ...bundle("effects"),
    ],
    /**
     * Pure function. State → ONE ir.js text() op showing the MORPHED string
     * (morph(s), the custom props + alpha run through the transition), laid out
     * and effect-wrapped exactly like the plaintext widget. A blank result draws
     * nothing (the ghost convention).
     *
     * @param {object} s - the folded, equation-evaluated item state
     * @param {*} _targetWorldIR - unused (bbox widget)
     * @param {object} world - the item's world transform (effects halo mapping)
     * @returns {object[]} display-list commands
     */
    emit(s, _targetWorldIR, world) {
      const display = morph(s);
      if (isBlank(display)) return []; // GHOST — draws nothing
      const w = s.w ?? 0, h = s.h ?? 0;
      return applyEffects([text({
        text: String(display),
        x: 0, y: 0,
        size: s.size ?? DEFAULT_TEXT_SIZE,
        color: s.fill ?? "#000000",
        bold: s.bold ?? false,
        font: s.font ?? DEFAULT_FONT,
        opacity: s.opacity ?? 1,
        boxW: w > 0 ? w : Infinity,
        boxH: h > 0 ? h : Infinity,
        boxStyle: { align: s.align ?? "left", valign: s.valign ?? "top" },
      })], s, world, { x: 0, y: 0, w, h });
    },
    cullMargin: effectsCullMargin,
    anchors: standardBBoxAnchors,
    // NO top-level `commands`: reached ONLY via the "Add Demo Widget" submenu.
  };
}

/**
 * The three text-morph demo widgets, in submenu order. Spread into
 * plugins/index.js's allPlugins (the shapeshifter.js precedent). `icon` is the
 * mdi glyph the "Add Demo Widget" submenu uses.
 */
export const textMorphPlugins = [
  makeTextMorphPlugin({
    type: "demo_text_dissolve",
    title: "Text Dissolve",
    wordProps: [
      { name: "from", kind: "text", default: "Hello", help: "The starting word/phrase (shown at alpha 0)." },
      { name: "to", kind: "text", default: "Goodbye", help: "The ending word/phrase (shown at alpha 1)." },
    ],
    morph: (s) => textDissolve(s.from ?? "", s.to ?? "", s.alpha ?? 0),
  }),
  makeTextMorphPlugin({
    type: "demo_text_type",
    title: "Text Typewriter",
    wordProps: [
      { name: "source", kind: "text", default: "Type me out", help: "The full text; alpha reveals the first floor(alpha*length) characters." },
    ],
    morph: (s) => textType(s.source ?? "", s.alpha ?? 0),
  }),
  makeTextMorphPlugin({
    type: "demo_text_scramble",
    title: "Text Scramble",
    wordProps: [
      { name: "source", kind: "text", default: "Decoding", help: "The target text; alpha resolves it left-to-right out of scramble noise." },
    ],
    morph: (s) => textScramble(s.source ?? "", s.alpha ?? 0),
  }),
];
