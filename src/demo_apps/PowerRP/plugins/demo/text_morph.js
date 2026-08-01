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

import { EPHEMERAL } from "../../core/ephemeral.js";
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
 * THE PRESET TABLES BELOW SHARE ONE SHAPE AND ONE SET OF RULINGS, stated once here
 * rather than three times.
 *
 * THREE TABLES, NOT ONE SHARED CONST, even though the factory keeps everything else
 * DRY. The three widgets are 90% identical in their KNOBS and genuinely different in
 * their IDIOMS: the scramble pool is fixed ASCII punctuation
 * (core/text_transitions.js), which reads as noise against letters — right for
 * decoding and wrong for a departure board whose flaps carry A-Z; the dissolve takes
 * TWO strings and is therefore the only one that can model a board flip or an
 * A-to-B swap; the typewriter is the only one whose text arrives left to right. One
 * shared table would have to be the intersection of the three, which is thinner than
 * any of them. plugins/demo/sky.js is the direct precedent — four plugins in one
 * file, one named const each.
 *
 * `alpha` IS EXCLUDED FROM ALL THREE, and it is the sharpest call here because it is
 * the one knob that makes these widgets different from plaintext. Two reasons, both
 * of which hold. It is the widget's ANIMATION CHANNEL — the documented workflow is
 * "keyframe it across two slides and the text animates during the transition", so
 * writing it on the current slide overwrites that keyframe. That is the TEMPORAL
 * form of the rule that a preset never moves something the user already placed. And
 * a mid-morph alpha is a MOMENT, not a LOOK: nobody would recognise or name 0.4.
 * The `source` / `from` / `to` strings are excluded for the ordinary reason — they
 * are the user's own words and cost two seconds to type.
 *
 * THE RATE IS NOT SETTABLE FROM HERE, so it lives in the descriptions instead. These
 * widgets reveal a function of alpha, and alpha is the user's keyframe, so the rate
 * is (string length / transition seconds) and the transition is a SLIDE property no
 * item preset can reach. The one number worth knowing: a teleprinter ran exactly 10
 * characters per second, and so does a world-class modern typist — so a 60-character
 * line "typing" wants a SIX SECOND transition, not the 300 ms a motion-system token
 * would suggest. Above about 20 cps a reveal stops reading as text at all, because
 * that is roughly the silent reading ceiling.
 *
 * THE PHOSPHOR IS GREEN, THE SATURATED CORE IS WHITE. The terminal rows are not
 * simply green text: a real tube overexposes its bright parts, so the glyph core
 * goes near-white and the green lives in the halo. `fill` is the core, the
 * zero-offset coloured shadow is the halo, and `bloom` is the overexposure. Green is
 * the 525 nm willemite phosphor, amber the 602 nm one. (plugins/plaintext.js's
 * "Green Terminal" takes the flatter, LABEL reading of the same tube; both are real,
 * and they are deliberately different looks under a shared name.)
 *
 * EVERY ROW WRITES ALL TWELVE LOOK KEYS INCLUDING THE OFF STATES, and every nested
 * effect object is COMPLETE — application is an overlay and a partial nested object
 * MERGES, so a stale glow or a stale feather from the previously hovered row is the
 * most visible form of that bug.
 *
 * "Green Terminal" and "Amber Terminal" are byte-identical across all three tables,
 * on purpose: one look, three transitions, one name (the sibling-naming convention).
 * Cross-table identity is not a distinctness failure — both the disjointness and the
 * distinctness gates are per widget.
 */

/**
 * Pure function. The two shared terminal rows, built once and spread into all three
 * tables so "one look, three transitions, one name" cannot drift into three looks.
 * Takes the per-widget rate/behaviour clause, because that IS what differs between
 * the three: the picture is identical and the advice is not.
 *
 * @param {string} greenTail - the sentence appended to Green Terminal's description
 * @param {string} amberTail - the sentence appended to Amber Terminal's description
 * @returns {object[]} two presets, green first
 *
 * @example terminalRows("Ease it out.", "Ease it out.").map((p) => p.name)
 * // ["Green Terminal", "Amber Terminal"]
 * @example terminalRows("A.", "B.")[0].props.bloom // {radius: 12, strength: 0.5}
 */
function terminalRows(greenTail, amberTail) {
  return [
    {
      name: "Green Terminal",
      description: `The green screen — a near-white overexposed core inside a 525-nanometre halo. ${greenTail}`,
      props: {
        font: "jetbrains-mono", size: 30, bold: false, align: "left", valign: "top",
        fill: "#f0fff8", opacity: 1, blendMode: "normal", softEdges: 0,
        shadow: { dx: 0, dy: 0, blur: 20, color: "#00ff66", opacity: 0.85 },
        bloom: { radius: 12, strength: 0.5 },
        innerShadow: { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 },
      },
    },
    {
      name: "Amber Terminal",
      description: `The amber tube: the 602-nanometre phosphor, smaller and warmer than the green, with a slight feather for the longer persistence it has. ${amberTail}`,
      props: {
        font: "jetbrains-mono", size: 26, bold: false, align: "left", valign: "top",
        fill: "#ffb000", opacity: 1, blendMode: "normal", softEdges: 0.3,
        shadow: { dx: 0, dy: 0, blur: 14, color: "#ff8000", opacity: 0.5 },
        bloom: { radius: 10, strength: 0.45 },
        innerShadow: { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 },
      },
    },
  ];
}

/**
 * TYPEWRITER LOOKS — whole looks for the reveal-a-prefix widget. ORDERED BY THE RATE
 * EACH MODELS, slowest first: the teleprinter band (4-10 characters per second),
 * then the reading band, then the display idioms where the reveal is a flourish
 * rather than a transmission. AND USE A LINEAR CURVE — a teleprinter has no
 * acceleration, and the absence of slow-in and slow-out is exactly what makes a
 * constant reveal read as a machine rather than as something a designer moved.
 */
const TYPE_PRESETS = [
  ...terminalRows(
    "Ten characters a second is both a teleprinter's rate and a world-class typist's, so a 60-character line wants a six-second transition.",
    "About six characters a second on a 45-baud machine, so a full line wants ten seconds."),
  {
    name: "Manuscript Draft",
    description: "Ink on paper from a mechanical typewriter — no glow at all, warm near-black, at the four-and-a-bit characters a second an average typist actually manages.",
    props: {
      font: "jetbrains-mono", size: 30, bold: false, align: "left", valign: "top",
      fill: "#23201c", opacity: 1, blendMode: "normal", softEdges: 0,
      shadow: { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 },
      bloom: { radius: 10, strength: 0 },
      innerShadow: { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 },
    },
  },
  {
    name: "Serif Terminal",
    description: "A SERIF computer face on a green screen — the least-copied idiom in science fiction, and the one that will not look like every other terminal effect.",
    props: {
      font: "source-serif", size: 34, bold: false, align: "left", valign: "top",
      fill: "#7cff9e", opacity: 1, blendMode: "normal", softEdges: 0,
      shadow: { dx: 0, dy: 0, blur: 12, color: "#00ff66", opacity: 0.5 },
      bloom: { radius: 16, strength: 0.7 },
      innerShadow: { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 },
    },
  },
  {
    name: "Mission Control Readout",
    description: "An engineered geometric sans in plain white with the faintest lift — the flight-control convention, where white is a normal value and colour is reserved for something needing attention.",
    props: {
      font: "jost", size: 30, bold: false, align: "left", valign: "top",
      fill: "#ffffff", opacity: 1, blendMode: "normal", softEdges: 0,
      shadow: { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 },
      bloom: { radius: 6, strength: 0.25 },
      innerShadow: { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 },
    },
  },
  {
    name: "Ticker Tape",
    description: "Black on paper tape, small and unadorned. The 1964 high-speed stock ticker ran eight to fifteen characters a second — the same band as a teleprinter, on a narrower ribbon.",
    props: {
      font: "jetbrains-mono", size: 24, bold: false, align: "left", valign: "top",
      fill: "#1a1a1a", opacity: 1, blendMode: "normal", softEdges: 0,
      shadow: { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 },
      bloom: { radius: 10, strength: 0 },
      innerShadow: { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 },
    },
  },
  {
    name: "Chat Message",
    description: "Someone typing on the other end — a muted interface sans at conversational size, no effects, at the pace of an actual human rather than a machine.",
    props: {
      font: "inter", size: 28, bold: false, align: "left", valign: "top",
      fill: "#5c6370", opacity: 1, blendMode: "normal", softEdges: 0,
      shadow: { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 },
      bloom: { radius: 10, strength: 0 },
      innerShadow: { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 },
    },
  },
  {
    name: "News Crawl",
    description: "The bar along the bottom: heavy condensed white with a hairline shade under it. Keep it near the reading ceiling of about twenty characters a second — faster and nobody reads it.",
    props: {
      font: "oswald", size: 44, bold: true, align: "left", valign: "middle",
      fill: "#ffffff", opacity: 1, blendMode: "normal", softEdges: 0,
      shadow: { dx: 0, dy: 1, blur: 0, color: "#000000", opacity: 0.5 },
      bloom: { radius: 10, strength: 0 },
      innerShadow: { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 },
    },
  },
  {
    name: "Arcade Entry",
    description: "Three initials going into a high-score table, in saturated yellow with the bloom an arcade tube gives everything. Short by design — the format has been three characters since 1979.",
    props: {
      font: "jetbrains-mono", size: 56, bold: true, align: "center", valign: "middle",
      fill: "#ffe600", opacity: 1, blendMode: "normal", softEdges: 0,
      shadow: { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 },
      bloom: { radius: 14, strength: 0.8 },
      innerShadow: { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 },
    },
  },
  {
    name: "Karaoke Line",
    description: "The lyric filling in as it is sung — heavy sans, centred, white with a dark halo so it holds over any footage. The reveal is the timing, so pace it to the bar rather than to a token.",
    props: {
      font: "montserrat", size: 64, bold: true, align: "center", valign: "middle",
      fill: "#ffffff", opacity: 1, blendMode: "normal", softEdges: 0,
      shadow: { dx: 0, dy: 0, blur: 6, color: "#000000", opacity: 0.9 },
      bloom: { radius: 10, strength: 0 },
      innerShadow: { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 },
    },
  },
];

/**
 * DECODE LOOKS — whole looks for the resolve-out-of-noise widget. ORDERED FROM THE
 * CLEANEST SIGNAL TO THE MOST DEGRADED, which is this widget's own axis: a scramble
 * is a signal settling, so the list runs crisp readout -> working terminal ->
 * ghosted -> glitched. EASE OUT, not linear: a decode settles, which is the opposite
 * of the typewriter's constant machine rate.
 *
 * THE POOL CONSTRAINS THE LIBRARY. SCRAMBLE_GLYPHS is fixed ASCII punctuation with
 * no knob, which reads as noise against letters — right for decoding, wrong for a
 * departure board whose flaps carry A-Z and wrong for a numeric readout. So there is
 * no board and no ticker here; both belong to the dissolve widget, which swaps one
 * real string for another.
 *
 * "Long Persistence Green" IS THE ONE ROW WITH A PHYSICAL REASON TO FEATHER: the
 * classic green monochrome display used a long-persistence phosphor, and its own
 * hardware reference records that this "causes smearing when the image changes".
 * This widget's glyphs change every frame, so the smear is period-correct rather
 * than decorative. The feather ERODES the glyph before blurring it, so 0.6 units is
 * chosen against the 30-unit size on the same row.
 */
const SCRAMBLE_PRESETS = [
  ...terminalRows(
    "Ease it out; a decode settles rather than marching.",
    "Ease it out, like the green."),
  {
    name: "Long Persistence Green",
    description: "The spectral green of the willemite phosphor, feathered — the long-persistence tube used on the classic green screens physically SMEARS when the image changes, and here the image changes every frame.",
    props: {
      font: "jetbrains-mono", size: 30, bold: false, align: "left", valign: "top",
      fill: "#41ff00", opacity: 1, blendMode: "normal", softEdges: 0.6,
      shadow: { dx: 0, dy: 0, blur: 10, color: "#00ff41", opacity: 0.5 },
      bloom: { radius: 14, strength: 0.7 },
      innerShadow: { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 },
    },
  },
  {
    name: "Signal Lock",
    description: "A cold blue instrument readout coming into lock — a faint glow, no halo, nothing degraded. The clean end of this list.",
    props: {
      font: "jetbrains-mono", size: 26, bold: false, align: "left", valign: "top",
      fill: "#8fd6ff", opacity: 1, blendMode: "normal", softEdges: 0,
      shadow: { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 },
      bloom: { radius: 8, strength: 0.4 },
      innerShadow: { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 },
    },
  },
  {
    name: "Encrypted Payload",
    description: "A dim, dense block of ciphertext resolving — small grey monospace with nothing added, for the slide where the text is texture until it suddenly is not.",
    props: {
      font: "jetbrains-mono", size: 18, bold: false, align: "left", valign: "top",
      fill: "#7f848e", opacity: 1, blendMode: "normal", softEdges: 0,
      shadow: { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 },
      bloom: { radius: 10, strength: 0 },
      innerShadow: { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 },
    },
  },
  {
    name: "Cipher Card",
    description: "Read off a punched card: small black monospace on stock, no light of its own — the punctuation noise reads as unpunched positions.",
    props: {
      font: "jetbrains-mono", size: 22, bold: false, align: "left", valign: "top",
      fill: "#2b2b2b", opacity: 1, blendMode: "normal", softEdges: 0,
      shadow: { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 },
      bloom: { radius: 10, strength: 0 },
      innerShadow: { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 },
    },
  },
  {
    name: "Access Granted",
    description: "The green stamp at the end of the decode, glowing hard. A film trope with no production source behind it — recognisable rather than historical, and worth using as such. Type in caps.",
    props: {
      font: "oswald", size: 72, bold: true, align: "center", valign: "middle",
      fill: "#2bd96a", opacity: 1, blendMode: "normal", softEdges: 0,
      shadow: { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 },
      bloom: { radius: 20, strength: 0.9 },
      innerShadow: { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 },
    },
  },
  {
    name: "Access Denied",
    description: "The same stamp in refusal red — the other half of the trope, and the reason both ship: green and red are the two signals an audience reads without being told.",
    props: {
      font: "oswald", size: 72, bold: true, align: "center", valign: "middle",
      fill: "#ff3b30", opacity: 1, blendMode: "normal", softEdges: 0,
      shadow: { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 },
      bloom: { radius: 20, strength: 0.9 },
      innerShadow: { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 },
    },
  },
  {
    name: "Degraded Panel",
    description: "A screen well past its service life: desaturated ink at reduced opacity, a sideways ghost of itself, and feathered strokes — warping, ghosting and colour degradation, which is how a designer signals cheap old hardware.",
    props: {
      font: "oswald", size: 36, bold: false, align: "left", valign: "top",
      fill: "#c9b8a8", opacity: 0.85, blendMode: "normal", softEdges: 0.5,
      shadow: { dx: 2, dy: 0, blur: 0, color: "#7a4a3a", opacity: 0.6 },
      bloom: { radius: 10, strength: 0 },
      innerShadow: { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 },
    },
  },
  {
    name: "Glitch Headline",
    description: "Display type with one channel knocked sideways — the chromatic offset that reads as a broken signal, at a size where the offset is visible from the back of the room.",
    props: {
      font: "montserrat", size: 88, bold: true, align: "center", valign: "middle",
      fill: "#ffffff", opacity: 1, blendMode: "normal", softEdges: 0,
      shadow: { dx: 3, dy: 0, blur: 0, color: "#ff00a0", opacity: 0.7 },
      bloom: { radius: 10, strength: 0 },
      innerShadow: { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 },
    },
  },
];

/**
 * SWAP LOOKS — whole looks for the A-to-B widget, the only one of the three that
 * takes two strings and can therefore model a thing CHANGING rather than arriving.
 * ORDERED BY HOW MECHANICAL THE SWAP IS: physical boards first, then screen swaps,
 * then the editorial and cinematic ones. Ease out, like the decode: a board settles
 * into its new reading.
 *
 * THE DEPARTURE BOARD IS THE IDIOM THIS WIDGET WAS BORN FOR, and the match is better
 * than it looks: on a real split-flap board a character's settle time is
 * proportional to its distance in the flap sequence, so characters land at DIFFERENT
 * times and the board resolves raggedly — which is exactly what a shuffled commit
 * order does. No flap rate is published anywhere, so the description claims none.
 *
 * "SEGMENT SWAP" IS DIGITS ONLY, AND THAT IS NOT A STYLE NOTE: the seven-segment
 * face renders letters as approximations that read as gibberish (its own name comes
 * out "5EUEn 5EGMEnt"), so BOTH `from` and `to` must be numeric or the preset
 * produces noise. It is the only row outside the number widget that names that face,
 * and its description says so.
 */
const DISSOLVE_PRESETS = [
  {
    name: "Departure Board",
    description: "A split-flap board changing its reading — tight bold grotesque, white on matte black, no glow, nothing added. The scattered commit order IS the look: real flaps land at different moments.",
    props: {
      font: "inter", size: 48, bold: true, align: "center", valign: "middle",
      fill: "#ffffff", opacity: 1, blendMode: "normal", softEdges: 0,
      shadow: { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 },
      bloom: { radius: 10, strength: 0 },
      innerShadow: { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 },
    },
  },
  {
    name: "Segment Swap",
    description: "A red LED panel changing its reading, glowing hard. DIGITS ONLY — the segment face turns letters into gibberish, so both the from and to strings must be numeric.",
    props: {
      font: "seg7", size: 88, bold: false, align: "right", valign: "middle",
      fill: "#ff2a1a", opacity: 1, blendMode: "normal", softEdges: 0,
      shadow: { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 },
      bloom: { radius: 16, strength: 0.8 },
      innerShadow: { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 },
    },
  },
  ...terminalRows(
    "Ease it out so the new reading settles.",
    "Ease it out, like the green."),
  {
    name: "Corporate Monochrome",
    description: "Pure, minimal, geometric, and DELIBERATELY UNLIT — no glow, no shadow, no texture. Screen quality as a status signal: the expensive interface is the one that does not need to shine.",
    props: {
      font: "jost", size: 72, bold: false, align: "center", valign: "middle",
      fill: "#ffffff", opacity: 1, blendMode: "normal", softEdges: 0,
      shadow: { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 },
      bloom: { radius: 10, strength: 0 },
      innerShadow: { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 },
    },
  },
  {
    name: "Cyan Grid",
    description: "Angled geometry and neon-style glow on a dark ground — the cyan-on-black grammar, at a size where the bloom is the point.",
    props: {
      font: "jost", size: 80, bold: false, align: "center", valign: "middle",
      fill: "#6fe9ff", opacity: 1, blendMode: "normal", softEdges: 0,
      shadow: { dx: 0, dy: 0, blur: 14, color: "#0a5a75", opacity: 0.7 },
      bloom: { radius: 26, strength: 1.1 },
      innerShadow: { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 },
    },
  },
  {
    name: "Neon Swap",
    description: "A sign changing its word, in the red-orange that neon gas actually emits — every other neon colour needs a different gas or a phosphor coat, and this is the one that is really neon.",
    props: {
      font: "poppins", size: 84, bold: false, align: "center", valign: "middle",
      fill: "#ff6a2b", opacity: 1, blendMode: "normal", softEdges: 0,
      shadow: { dx: 0, dy: 0, blur: 12, color: "#5a1a05", opacity: 0.6 },
      bloom: { radius: 26, strength: 1.15 },
      innerShadow: { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 },
    },
  },
  {
    name: "Lower Third Swap",
    description: "The name strap changing between speakers — bold sans ranged left at the bottom, white with a soft dark halo so it holds over whatever is behind it.",
    props: {
      font: "montserrat", size: 44, bold: true, align: "left", valign: "bottom",
      fill: "#ffffff", opacity: 1, blendMode: "normal", softEdges: 0,
      shadow: { dx: 0, dy: 0, blur: 6, color: "#000000", opacity: 0.85 },
      bloom: { radius: 10, strength: 0 },
      innerShadow: { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 },
    },
  },
  {
    name: "Headline Swap",
    description: "One word replaced by another at poster scale — heavy condensed near-black with nothing added, for the slide whose whole argument is the substitution.",
    props: {
      font: "oswald", size: 96, bold: true, align: "center", valign: "middle",
      fill: "#111111", opacity: 1, blendMode: "normal", softEdges: 0,
      shadow: { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 },
      bloom: { radius: 10, strength: 0 },
      innerShadow: { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 },
    },
  },
  {
    name: "Film Noir Title",
    description: "A high-contrast display serif in warm off-white over a wide dark halo, changing on the cut. No specific period face is documented anywhere, so this is the CLASS rather than a reproduction.",
    props: {
      font: "playfair-display", size: 96, bold: false, align: "center", valign: "middle",
      fill: "#f0ece2", opacity: 1, blendMode: "normal", softEdges: 0,
      shadow: { dx: 0, dy: 0, blur: 22, color: "#000000", opacity: 0.6 },
      bloom: { radius: 10, strength: 0 },
      innerShadow: { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 },
    },
  },
];

/**
 * Pure function (factory). Builds one text-morph DEMO widget plugin. All three
 * widgets share the plaintext-style box (positioning + typography + ink +
 * opacity + effects); they differ ONLY in their word inputs, which transition
 * maps those inputs + alpha to the displayed string, and which preset table.
 *
 * @param {object} config
 * @param {string} config.type - the widget type id (e.g. "demo_text_dissolve")
 * @param {string} config.title - the human title (Inspector + submenu)
 * @param {object[]} config.wordProps - customProps defs for the word input(s)
 * @param {(state: object) => string} config.morph - state → the displayed string
 * @param {object[]} config.presets - this widget's own preset table
 * @returns {object} a plugin object (defaults, inspector, emit, anchors)
 *
 * @example // makeTextMorphPlugin({type: "demo_text_type", title: "Text Typewriter",
 * @example //   wordProps: [{name: "source", kind: "text", default: "Reveal"}],
 * @example //   morph: (s) => textType(s.source, s.alpha), presets: TYPE_PRESETS}).type === "demo_text_type"
 */
function makeTextMorphPlugin({ type, title, wordProps, morph, presets }) {
  const custom = customProps([...wordProps, ALPHA_PROP]);
  return {
    type,
    title,
    // Declared in the FACTORY, so all three variants inherit it and a fourth
    // cannot be added without one. A text morph is a pure string transition
    // (core/text_transitions.js), deterministic in alpha — no cheap tier, no
    // async source, correct on its first frame.
    ephemeral: EPHEMERAL.NONE,
    capabilities: { bbox: true, transform: true, resizable: true, backdrop: false },
    presets,
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
    presets: DISSOLVE_PRESETS,
  }),
  makeTextMorphPlugin({
    type: "demo_text_type",
    title: "Text Typewriter",
    wordProps: [
      { name: "source", kind: "text", default: "Type me out", help: "The full text; alpha reveals the first floor(alpha*length) characters." },
    ],
    morph: (s) => textType(s.source ?? "", s.alpha ?? 0),
    presets: TYPE_PRESETS,
  }),
  makeTextMorphPlugin({
    type: "demo_text_scramble",
    title: "Text Scramble",
    wordProps: [
      { name: "source", kind: "text", default: "Decoding", help: "The target text; alpha resolves it left-to-right out of scramble noise." },
    ],
    morph: (s) => textScramble(s.source ?? "", s.alpha ?? 0),
    presets: SCRAMBLE_PRESETS,
  }),
];
