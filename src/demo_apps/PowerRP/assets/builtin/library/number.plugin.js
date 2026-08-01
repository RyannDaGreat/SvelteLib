// number.plugin.js — A BUILT-IN PLUGIN ASSET (core/builtin_plugin_assets.js).
//
// NUMBER widget — a numeric READOUT: a plaintext-like box whose content is a
// NUMBER, formatted (decimals / padding / thousands / prefix / suffix) and, above
// all, EQUATION-BINDABLE (`= my_var`, `= @box.w`, `= time * 2`). It renders
// exactly ONE ir.js text() op, so it inherits the whole text pipeline (fonts,
// wrap, align, gradient ink, effects) with no new IR op.
//
// ── NO INLINE EDIT ────────────────────────────────────────────────────────────
// Unlike plaintext, a number box has NO inline canvas text editor: its value is a
// number (often an equation), edited in the Inspector's Value field — typing a
// computed value in place would be meaningless / would clobber the equation. So
// it deliberately omits plaintext's `inlineTextEdit` opt-in.
//
// ── WHY THIS IS AN ASSET ──────────────────────────────────────────────────────
// It is the cleanest tier-1 case in the batch: everything it draws is one text()
// op over the shared property registry, and every host binding it needs
// (`text`, `DEFAULT_FONT`, `fontOptions`, the property bundles, the effects
// bundle, `standardBBoxAnchors`) is in the sandbox's provided API. It declares no
// `commands` — its "Add Number" palette entry already lived in web/App.svelte,
// resolving the type lazily from the registry — so nothing moved to make room for
// it. That is the point of including it: a widget can cross to an asset with the
// migration costing NOTHING but the file's location.
//
// The formatting contract (formatNumber) is the widget's whole reason for
// existing and is pinned by tests/builtin_plugin_assets_test.js, which drives the
// registered asset's emit against the same fixed states the source module's tests
// used — so a byte-level regression in the jail shows up here as a wrong string,
// not as a mystery.

// The starting readout value — a plain zero until the user types a number or an
// `=` equation. A NUMBER default is what makes `value` an equation slot.
const DEFAULT_VALUE = 0;
// Two fractional places — the everyday float readout (money / measurement). A
// user drops it to 0 for an integer counter or raises it for more precision.
const DEFAULT_DECIMALS = 2;
// Matches plugins/plaintext.js / plugins/text.js's 36u text size so a number box
// reads at the same size as a text box out of the box (one shared convention).
const DEFAULT_TEXT_SIZE = 36;
// The glyph ink used by the sibling text widgets (plaintext/text #000000).
const DEFAULT_INK = "#000000";
// A number box is a READOUT, and the user ruled a readout defaults to the
// seven-segment display face. Existing docs store their font at insert time, so
// only NEW number widgets are affected; an unregistered id degrades gracefully to
// the system face (render_gpu/fonts.js fontDescriptor), never to tofu.
const READOUT_FONT_ID = "seg7";

// Padding STYLES (how a formatted number is widened to `padWidth`) and their
// human labels. "zero" pads with leading zeros after the sign ("-07.50"); "space"
// pads with spaces on the side chosen by `align`; "none" never pads.
const PAD_OPTIONS = ["none", "zero", "space"];
const PAD_LABELS = { none: "None", zero: "Zero", space: "Space" };
// Horizontal alignment of the string within the box (and the space-pad side).
const ALIGN_OPTIONS = ["left", "center", "right"];
const ALIGN_LABELS = { left: "Left", center: "Center", right: "Right" };
// Vertical placement of the line within the box height (core/richtext.valignOffset).
const VALIGN_OPTIONS = ["top", "middle", "bottom"];
const VALIGN_LABELS = { top: "Top", middle: "Middle", bottom: "Bottom" };
// Thousands grouping is every three digits of the integer part.
const GROUP_SIZE = 3;

/**
 * Pure function. Thousands-groups the integer part of a non-negative magnitude
 * string with commas, leaving any fractional part untouched. A small helper for
 * formatNumber's `group` option.
 *
 * @param {string} magnitude - a non-negative decimal string, e.g. "1234567.80"
 * @returns {string}
 *
 * @example groupThousands("1234567") // "1,234,567"
 * @example groupThousands("1234.50") // "1,234.50"
 * @example groupThousands("42") // "42"
 */
function groupThousands(magnitude) {
  const [intPart, fracPart] = magnitude.split(".");
  const grouped = intPart.replace(new RegExp(`\\B(?=(\\d{${GROUP_SIZE}})+(?!\\d))`, "g"), ",");
  return fracPart === undefined ? grouped : `${grouped}.${fracPart}`;
}

/**
 * Pure function. Formats a NUMBER as a display STRING per a numeric format spec —
 * the whole numeric-rendering contract of the number widget, factored out so it
 * is unit-testable independent of any widget/render machinery.
 *
 * Steps (each operates on the previous step's result):
 *   1. ROUND to `decimals` fractional places (Number.toFixed — round-half-away-
 *      from-zero, JS semantics). decimals 0 → an integer string with no ".".
 *   2. GROUP the integer part with thousands commas when `group` is set.
 *   3. PAD the SIGNED numeric field up to `padWidth` characters:
 *        - "zero"  → zeros inserted AFTER the sign ("-7.50" → "-07.50"), so the
 *                    value stays numerically readable (the printf %0N.Mf look).
 *        - "space" → spaces on the side chosen by `align`: "right" pads on the
 *                    LEFT (leading spaces → decimal-aligned columns), "left" pads
 *                    on the RIGHT, "center" splits the slack between both sides.
 *        - "none"  → no padding.
 *      padWidth counts ONLY the numeric field (sign + digits + "." + fraction),
 *      NOT the prefix/suffix.
 *   4. WRAP with `prefix` then `suffix` (units / $ / %), added OUTSIDE the pad.
 *
 * A non-finite input (NaN / ±Infinity) has no numeric format, so its String()
 * form is returned verbatim (a visible readout, never a throw); the widget's
 * isGhost gate keeps such a value from ever reaching a real draw.
 *
 * @param {number} value - the number to render
 * @param {object} [opts]
 * @param {number} [opts.decimals=0] - fractional places (coerced to integer >= 0)
 * @param {"none"|"zero"|"space"} [opts.pad="none"] - padding style
 * @param {number} [opts.padWidth=0] - minimum width of the numeric field
 * @param {"left"|"center"|"right"} [opts.align="right"] - space-pad side
 * @param {string} [opts.prefix=""] - text prepended (e.g. "$")
 * @param {string} [opts.suffix=""] - text appended (e.g. "%")
 * @param {boolean} [opts.group=false] - thousands-group the integer part
 * @returns {string}
 *
 * @example formatNumber(3.14159, { decimals: 2 }) // "3.14"
 * @example formatNumber(42, { decimals: 0 }) // "42"
 * @example formatNumber(7.5, { decimals: 2, pad: "zero", padWidth: 6 }) // "007.50"
 * @example formatNumber(-7.5, { decimals: 2, pad: "zero", padWidth: 6 }) // "-07.50"
 * @example formatNumber(7.5, { decimals: 2, pad: "space", padWidth: 6 }) // "  7.50"
 * @example formatNumber(7.5, { decimals: 2, pad: "space", padWidth: 6, align: "left" }) // "7.50  "
 * @example formatNumber(1234567, { decimals: 0, group: true }) // "1,234,567"
 * @example formatNumber(0.5, { decimals: 1, prefix: "$", suffix: "%" }) // "$0.5%"
 * @example formatNumber(2.5, { decimals: 0 }) // "3" (round half away from zero)
 */
function formatNumber(value, opts = {}) {
  const {
    decimals = 0, pad = "none", padWidth = 0,
    align = "right", prefix = "", suffix = "", group = false,
  } = opts;
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  const places = Math.max(0, Math.trunc(decimals));
  const negative = n < 0;
  // Format the MAGNITUDE and re-attach the sign, so zero-pad insertion after the
  // sign is trivial and there is no "-0.00" from a value that rounds to zero.
  let body = Math.abs(n).toFixed(places);
  if (group) body = groupThousands(body);
  const sign = negative ? "-" : "";
  let field = sign + body;
  const slack = padWidth - field.length;
  if (slack > 0 && pad === "zero") {
    field = sign + "0".repeat(slack) + body;
  } else if (slack > 0 && pad === "space") {
    if (align === "left") field = field + " ".repeat(slack);
    else if (align === "center") {
      const left = Math.floor(slack / 2);
      field = " ".repeat(left) + field + " ".repeat(slack - left);
    } else field = " ".repeat(slack) + field; // "right" (default): leading spaces
  }
  return prefix + field + suffix;
}

/**
 * Pure function. Is a number widget's value ABSENT — nothing finite to display
 * (undefined, or a non-finite equation result that slipped past the eval gate)?
 * The ONE predicate driving BOTH the ghost hook and emit()'s short-circuit
 * (the plaintext/mermaid/qr ghost convention). The default `value` is 0, so a
 * fresh box is never a ghost — it reads "0.00".
 *
 * @param {*} value - the value leaf (a number, or an equation-resolved value)
 * @returns {boolean}
 *
 * @example numberIsEmpty(0) // false (renders "0")
 * @example numberIsEmpty(3.14) // false
 * @example numberIsEmpty(undefined) // true
 * @example numberIsEmpty(NaN) // true
 */
function numberIsEmpty(value) {
  return !Number.isFinite(Number(value));
}

/**
 * NUMBER READOUTS — one real instrument per row.
 *
 * ONE FLAT FAMILY, not a format/look split, and the reason is the completeness test
 * rather than taste: a real instrument's digit count is NOT separable from its face.
 * A fuel pump's third decimal and its display technology are one specification; a
 * three-and-a-half-digit meter's four-cell field IS its segment panel. Splitting
 * would generate a "3 decimals" row that composes with a "display serif" row into
 * something that has never existed — and both halves would then be knob readings
 * rather than recognisable things, which is what the presets bar forbids.
 *
 * ORDERED BY WHAT THE READOUT IS MADE OF: mechanical register, emissive segment
 * display, instrument, then printed/typographic. That puts the four segment-face
 * rows adjacent — which is where the glyph constraint below applies — and sweeps
 * from the most rigid fixed-width field to the freest.
 *
 * THE SEGMENT FACE CANNOT DRAW $ % , + OR / — measured off the shipped
 * DSEG7Classic-Regular.ttf cmap, which carries 69 codepoints: 0-9, A-Z, a-z, space,
 * and of the punctuation only `.`, `-`, `:`, `°`, `_`. A missing glyph does not draw
 * as tofu; it resolves through the Skia fallback chain, so a PROPORTIONAL comma
 * appears in the middle of the segment digits — a plausible-looking wrong picture,
 * which is worse. So every segment row here sets `group: false` and keeps its
 * prefix/suffix to letters and a space, and Fuel Pump Price — a segment display in
 * real life — is set in a proportional face here, because `$` and `/` are
 * unreachable in the segment font. That face also has cap height = x-height =
 * 1.000 em, so it draws about 83% larger than any other at the same `size`; the
 * segment rows are sized for that.
 *
 * ZERO-PAD VERSUS BLANK IS A REAL DISTINCTION, NOT A PREFERENCE. Registers, clocks,
 * odometers and flight levels SHOW leading zeros because the field width is the
 * semantic and a shrinking field is unreadable. Meters, calculators and scales BLANK
 * them, because a leading zero implies precision the instrument does not have —
 * that is what ripple-blanking exists for. `pad: "space"` is how you blank them
 * while holding the layout still, which is what Lab Balance uses.
 *
 * FIXED-PITCH FOR ANYTHING THAT MOVES: this app exposes no tabular-figure feature,
 * so a live counter set in a proportional face shifts horizontally as its digits
 * change. The counter and timer rows use a monospace or the segment face; the
 * display faces appear only on static figures.
 *
 * EVERY ROW WRITES EVERY LOOK KNOB, INCLUDING THE INERT ONES (`padWidth` under
 * `pad: "none"`, an off `bloom` on every printed row) — the whole-look completeness
 * rule, and it is unusually concrete here because application is an OVERLAY: omit
 * `group` and a fuel-pump price inherits a thousands comma from the previous hover;
 * omit `padWidth` and a three-wide flight level inherits an eight-wide balance
 * field; omit `prefix` and a scientific quantity inherits a dollar sign; omit
 * `bloom` and a printed page glows like an LED. Nested effect objects are written
 * COMPLETE, because a partial one MERGES rather than replacing.
 *
 * NO PRESET WRITES `value`. It is the slot this widget exists for, and it is
 * usually an equation — writing a literal there silently converts a live binding
 * into a dead number.
 */
const NUMBER_READOUTS = [
  {
    name: "Odometer",
    description: "A mechanical drum register: six digits, leading zeros shown because the field width is the odometer's capacity, cream numerals sunk slightly into their window.",
    props: {
      decimals: 0, pad: "zero", padWidth: 6, group: false, prefix: "", suffix: "",
      font: "jetbrains-mono", size: 64, bold: true, align: "center", valign: "middle",
      fill: "#f2efe6", opacity: 1, blendMode: "normal", softEdges: 0,
      shadow: { dx: 0, dy: 1, blur: 2, color: "#000000", opacity: 0.6 },
      bloom: { radius: 10, strength: 0 },
      innerShadow: { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 },
    },
  },
  {
    name: "Meter Register",
    description: "The five-digit kilowatt-hour register a utility meter is required to show, zero-padded to its full capacity with the unit spelled out after a space.",
    props: {
      decimals: 0, pad: "zero", padWidth: 5, group: false, prefix: "", suffix: " kWh",
      font: "jetbrains-mono", size: 44, bold: false, align: "center", valign: "middle",
      fill: "#1a1a1a", opacity: 1, blendMode: "normal", softEdges: 0,
      shadow: { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 },
      bloom: { radius: 10, strength: 0 },
      innerShadow: { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 },
    },
  },
  {
    name: "Red LED Panel",
    description: "A red seven-segment panel at full brightness — one decimal, a five-wide zero-padded field, and the bloom an emitter bleeds into its own window. Digits only.",
    props: {
      decimals: 1, pad: "zero", padWidth: 5, group: false, prefix: "", suffix: "",
      font: "seg7", size: 72, bold: false, align: "right", valign: "middle",
      fill: "#ff2a1a", opacity: 1, blendMode: "normal", softEdges: 0,
      shadow: { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 },
      bloom: { radius: 16, strength: 0.8 },
      innerShadow: { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 },
    },
  },
  {
    name: "Green VFD",
    description: "A vacuum fluorescent display: the cyan-green of its 505-nanometre phosphor, six digits to two places, and the softest, widest glow of any readout here.",
    props: {
      decimals: 2, pad: "zero", padWidth: 6, group: false, prefix: "", suffix: "",
      font: "seg7", size: 64, bold: false, align: "right", valign: "middle",
      fill: "#12f0c8", opacity: 1, blendMode: "normal", softEdges: 0,
      shadow: { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 },
      bloom: { radius: 18, strength: 0.9 },
      innerShadow: { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 },
    },
  },
  {
    name: "Bench Multimeter",
    description: "A three-and-a-half-digit meter reading volts: three decimals, leading zeros BLANKED because a meter must not imply precision it does not have, unit after a space.",
    props: {
      decimals: 3, pad: "none", padWidth: 0, group: false, prefix: "", suffix: " V",
      font: "seg7", size: 56, bold: false, align: "right", valign: "middle",
      fill: "#ff2a1a", opacity: 1, blendMode: "normal", softEdges: 0,
      shadow: { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 },
      bloom: { radius: 12, strength: 0.6 },
      innerShadow: { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 },
    },
  },
  {
    name: "Lap Timer",
    description: "Motorsport timing to the thousandth on a white segment panel, six cells wide. A minutes-and-seconds clock needs a second widget — this field cannot carry a colon of its own.",
    props: {
      decimals: 3, pad: "zero", padWidth: 6, group: false, prefix: "", suffix: "",
      font: "seg7", size: 64, bold: false, align: "right", valign: "middle",
      fill: "#ffffff", opacity: 1, blendMode: "normal", softEdges: 0,
      shadow: { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 },
      bloom: { radius: 10, strength: 0.5 },
      innerShadow: { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 },
    },
  },
  {
    name: "Flight Level",
    description: "Altitude in hundreds of feet, written the way it is spoken: three digits with leading zeros and the FL prefix, in the green a glass cockpit uses for a normal condition.",
    props: {
      decimals: 0, pad: "zero", padWidth: 3, group: false, prefix: "FL", suffix: "",
      font: "jetbrains-mono", size: 48, bold: true, align: "center", valign: "middle",
      fill: "#00e64d", opacity: 1, blendMode: "normal", softEdges: 0,
      shadow: { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 },
      bloom: { radius: 8, strength: 0.35 },
      innerShadow: { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 },
    },
  },
  {
    name: "Lab Balance",
    description: "An analytical balance reading to a tenth of a milligram — four decimals, space-padded to a fixed eight-character field so the number never shifts as the mass settles.",
    props: {
      decimals: 4, pad: "space", padWidth: 8, group: false, prefix: "", suffix: " g",
      font: "jetbrains-mono", size: 44, bold: false, align: "right", valign: "middle",
      fill: "#1a1a1a", opacity: 1, blendMode: "normal", softEdges: 0,
      shadow: { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 },
      bloom: { radius: 10, strength: 0 },
      innerShadow: { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 },
    },
  },
  {
    name: "Dollar Amount",
    description: "Ordinary money: two decimals and thousands separators, symbol in front, ranged right so a column of them aligns on the decimal.",
    props: {
      decimals: 2, pad: "none", padWidth: 0, group: true, prefix: "$", suffix: "",
      font: "inter", size: 56, bold: false, align: "right", valign: "middle",
      fill: "#1a1a1a", opacity: 1, blendMode: "normal", softEdges: 0,
      shadow: { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 },
      bloom: { radius: 10, strength: 0 },
      innerShadow: { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 },
    },
  },
  {
    name: "Zero-Decimal Currency",
    description: "Money in a currency with no minor unit — sixteen of them, including the yen and the won — so the decimals go away entirely and only the grouping remains.",
    props: {
      decimals: 0, pad: "none", padWidth: 0, group: true, prefix: "¥", suffix: "",
      font: "inter", size: 56, bold: false, align: "right", valign: "middle",
      fill: "#1a1a1a", opacity: 1, blendMode: "normal", softEdges: 0,
      shadow: { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 },
      bloom: { radius: 10, strength: 0 },
      innerShadow: { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 },
    },
  },
  {
    name: "Fuel Pump Price",
    description: "A unit price to the mill — the third decimal pumps have carried since a tenth-of-a-cent excise in 1932. Set in a proportional face because the segment font has no dollar sign and no slash.",
    props: {
      decimals: 3, pad: "none", padWidth: 0, group: false, prefix: "$", suffix: "/gal",
      font: "inter", size: 56, bold: true, align: "right", valign: "middle",
      fill: "#c0392b", opacity: 1, blendMode: "normal", softEdges: 0,
      shadow: { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 },
      bloom: { radius: 10, strength: 0 },
      innerShadow: { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 },
    },
  },
  {
    name: "Percentage",
    description: "One decimal and a percent sign. The widget does NOT multiply by a hundred — bind the value to an already-scaled figure, or scale it in the equation.",
    props: {
      decimals: 1, pad: "none", padWidth: 0, group: false, prefix: "", suffix: "%",
      font: "inter", size: 56, bold: true, align: "right", valign: "middle",
      fill: "#1a1a1a", opacity: 1, blendMode: "normal", softEdges: 0,
      shadow: { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 },
      bloom: { radius: 10, strength: 0 },
      innerShadow: { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 },
    },
  },
  {
    name: "Scientific Quantity",
    description: "A measured value with its unit after a space, in a text serif — and deliberately UNGROUPED, because the metric convention separates digits with a thin space and forbids the comma outright.",
    props: {
      decimals: 2, pad: "none", padWidth: 0, group: false, prefix: "", suffix: " mm",
      font: "source-serif", size: 44, bold: false, align: "right", valign: "middle",
      fill: "#1a1a1a", opacity: 1, blendMode: "normal", softEdges: 0,
      shadow: { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 },
      bloom: { radius: 10, strength: 0 },
      innerShadow: { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 },
    },
  },
  {
    name: "KPI Callout",
    description: "The one huge figure a dashboard slide is built around — two significant digits and a magnitude letter, because 3.8M is read at a glance and 3,848,306 is not.",
    props: {
      decimals: 1, pad: "none", padWidth: 0, group: false, prefix: "", suffix: "M",
      font: "montserrat", size: 150, bold: true, align: "center", valign: "middle",
      fill: "#1a1a1a", opacity: 1, blendMode: "normal", softEdges: 0,
      shadow: { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 },
      bloom: { radius: 10, strength: 0 },
      innerShadow: { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 },
    },
  },
  {
    name: "Vote Tally",
    description: "A large exact integer, grouped and ranged right — a count nobody rounds, in the condensed face that keeps seven digits inside a box.",
    props: {
      decimals: 0, pad: "none", padWidth: 0, group: true, prefix: "", suffix: "",
      font: "oswald", size: 120, bold: true, align: "right", valign: "middle",
      fill: "#1a1a1a", opacity: 1, blendMode: "normal", softEdges: 0,
      shadow: { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 },
      bloom: { radius: 10, strength: 0 },
      innerShadow: { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 },
    },
  },
  {
    name: "Ticker Delta",
    description: "A gain, in the green Western markets use for one — note the plus sign is literal, so this row is for positive moves only, and the colour convention is reversed across East Asia.",
    props: {
      decimals: 2, pad: "none", padWidth: 0, group: false, prefix: "+", suffix: "%",
      font: "inter", size: 48, bold: true, align: "right", valign: "middle",
      fill: "#26a69a", opacity: 1, blendMode: "normal", softEdges: 0,
      shadow: { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 },
      bloom: { radius: 10, strength: 0 },
      innerShadow: { dx: 0, dy: 0, blur: 0, color: "#000000", opacity: 0 },
    },
  },
];

return {
  type: "number",
  title: "Number",
  // resizable:true → the standard 8 resize handles (same machinery as plaintext);
  // w constrains the box width the text aligns within, h gives valign its room.
  capabilities: { bbox: true, transform: true, resizable: true, backdrop: false },
  // A plugin ASSET can carry a preset table (clock_analog.plugin.js already does),
  // and it must be a literal const in THIS file: an asset cannot `import`, and
  // HOST_MODULES hands out no preset machinery — so the "shared *_presets.js data
  // module" option is structurally unavailable here whatever the sibling text
  // widgets do.
  presets: NUMBER_READOUTS,
  /**
   * Pure function. Is this box a GHOST (nothing finite to draw)? STATE-dependent,
   * shared with emit()'s short-circuit (numberIsEmpty); core/derive.isGhostNode
   * grants the dashed-outline/findable affordance exactly while the box would draw
   * nothing — the empty plaintext/mermaid/qr opt-in.
   *
   * @param {object} state - the folded item state
   * @returns {boolean}
   *
   * @example // isGhost({ value: 3.14 }) // false
   * @example // isGhost({ value: undefined }) // true
   */
  isGhost(state) {
    return numberIsEmpty(state.value);
  },
  // defaults COMPOSE from the SHARED REGISTRY: positioning coords + opacity +
  // effects-off, exactly like plaintext.js. `value` is a plain NUMBER (making it
  // an equation slot). `fill` is the glyph ink (paint-capable; the registry
  // declares no default, so it is supplied here, matching the text widgets' ink).
  defaults: {
    type: "number", x: 120, y: 80, w: 160, h: 60, z: 0, rotation: 0, scale: 1,
    // Rotation pivots about this WORLD point; default = own center (an equation
    // — the plaintext/rect precedent). Absent on old docs → derive falls back.
    rotationAnchor: { x: "self.anchors.center.x", y: "self.anchors.center.y" },
    value: DEFAULT_VALUE,
    decimals: DEFAULT_DECIMALS, pad: "none", padWidth: 0, group: false,
    prefix: "", suffix: "",
    font: READOUT_FONT_ID, size: DEFAULT_TEXT_SIZE, bold: false,
    fill: DEFAULT_INK, align: "right", valign: "middle",
    ...defaults("opacity"), // opacity:1
    ...bundleNestedDefaults("effects"), // shadow/bloom/blendMode/innerShadow, all OFF
  },
  // Rows grouped into the Inspector accordion by each row's `category`. The value
  // + numeric-format knobs + the ink live in "formatting" (so "Value" is the
  // prominent first row of the second group); typography in "text"; position in
  // "positioning"; the shared effects bundle last.
  inspector: [
    ...bundle("positioning"),
    // The number itself. kind "number" is an equation-capable numeric slot — the
    // widget's whole "equation-bindable value" surface (typed value OR `=` expr).
    { key: "value", label: "Value", kind: "number", category: "formatting", help: "The number this readout shows. Type a number, or start with '=' to bind it to a live equation (e.g. = my_var, = box.w, or = 3.14159)." },
    { key: "decimals", label: "Decimals", kind: "number", min: 0, category: "formatting", help: "How many digits to show after the decimal point. 0 shows a whole integer with no point." },
    { key: "pad", label: "Padding", kind: "select", options: PAD_OPTIONS, optionLabels: PAD_LABELS, category: "formatting", help: "How the number is widened to the minimum width: zero-pads with leading zeros (007.50), space-pads with spaces, or none." },
    { key: "padWidth", label: "Pad width", kind: "number", min: 0, category: "formatting", help: "The minimum total width (in characters) the number is padded to. Only matters when Padding is Zero or Space." },
    { key: "group", label: "Thousands", kind: "boolean", category: "formatting", help: "Group the integer part with thousands separators (1,234,567)." },
    { key: "prefix", label: "Prefix", kind: "text", category: "formatting", help: "Text placed before the number, e.g. a currency symbol like $." },
    { key: "suffix", label: "Suffix", kind: "text", category: "formatting", help: "Text placed after the number, e.g. a unit like % or px." },
    // Ink color reuses the PAINT-capable registry `fill` prop (solid OR gradient),
    // relabelled for a text widget; text() runs it through parsePaint.
    ...props("fill", { fill: { label: "Color", category: "formatting", help: "The color or gradient the digits are painted with. Pick a solid color or a linear/radial gradient." } }),
    ...props("opacity"),
    { key: "font", label: "Font", kind: "select", options: fontOptions().map((o) => o.value), optionLabels: Object.fromEntries(fontOptions().map((o) => [o.value, o.label])), category: "text", help: "The typeface the digits are drawn in — including a seven-segment display face when one is registered." },
    { key: "size", label: "Size", kind: "number", min: 0, category: "text", help: "Font size in canvas units. Larger is bigger on the slide." },
    { key: "bold", label: "Bold", kind: "boolean", category: "text", help: "Draw the digits in the font's bold weight." },
    { key: "align", label: "Align", kind: "select", options: ALIGN_OPTIONS, optionLabels: ALIGN_LABELS, category: "text", help: "Horizontal alignment of the number within the box: left, center, or right. Also chooses the side space-padding is added to." },
    { key: "valign", label: "V-Align", kind: "select", options: VALIGN_OPTIONS, optionLabels: VALIGN_LABELS, category: "text", help: "Vertical placement of the number within the box height: top, middle, or bottom." },
    ...bundle("effects"),
  ],
  /**
   * Pure function. State → ONE existing ir.js text() op (local space, top-left
   * origin) built from the FORMATTED number (formatNumber) + style props — no new
   * IR op, no rich payload (a LEGACY single-run op; the Skia backend wraps it via
   * singleRunRich and applies boxStyle's align/valign + boxW wrap). Effects (the
   * shared EFFECTS BUNDLE) wrap the op; all-off = pass-through. This is
   * plaintext.emit with a numeric FORMAT in front of the string.
   *
   * GHOST short-circuit: a value with nothing finite to show draws NOTHING
   * (returns []), so isGhost keeps the box selectable without emitting ink.
   *
   * @param {object} s - the folded, equation-evaluated item state (s.value is a number)
   * @param {*} _targetWorldIR - unused (bbox widget)
   * @param {object} world - the item's world transform (effects halo mapping)
   * @returns {object[]} display-list commands
   */
  emit(s, _targetWorldIR, world) {
    if (numberIsEmpty(s.value)) return []; // GHOST — no finite number to show
    const align = s.align ?? "right";
    const formatted = formatNumber(s.value, {
      decimals: s.decimals ?? DEFAULT_DECIMALS,
      pad: s.pad ?? "none",
      padWidth: s.padWidth ?? 0,
      align,
      prefix: s.prefix ?? "",
      suffix: s.suffix ?? "",
      group: s.group ?? false,
    });
    const w = s.w ?? 0, h = s.h ?? 0;
    return applyEffects([text({
      text: formatted,
      x: 0, y: 0,
      size: s.size ?? DEFAULT_TEXT_SIZE,
      color: s.fill ?? "#000000",
      bold: s.bold ?? false,
      font: s.font ?? DEFAULT_FONT,
      opacity: s.opacity ?? 1,
      boxW: w > 0 ? w : Infinity, // align within the box width; 0/absent ⇒ no box
      boxH: h > 0 ? h : Infinity, // box height ⇒ vertical-align room
      boxStyle: { align, valign: s.valign ?? "middle" },
    })], s, world, { x: 0, y: 0, w, h });
  },
  // Effects halo (shadow/bloom spill) extends the cull AABB (core/view.js hook).
  cullMargin: effectsCullMargin,
  // Anchors sit on the bbox rim (the shared standard anchors) — a text box's
  // selectable frame IS its bounding box (the plaintext/text choice).
  anchors: standardBBoxAnchors,
};
