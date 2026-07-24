/**
 * NUMBER widget — a numeric READOUT. It is a plaintext-like text box whose VALUE
 * is a NUMBER rather than a free string: the number is rendered to text through a
 * PURE numeric FORMAT (decimals / padding / grouping / prefix / suffix) and drawn
 * through the SAME single ir.js text() op the plaintext widget uses. Model this
 * on plugins/plaintext.js — the difference is purely the STORED-VALUE kind (a
 * number, not a string) and the formatting layer in front of emit().
 *
 * ── EQUATION-BINDABLE NUMBER (the headline feature, no engine change) ─────────
 * `value` is a plain-NUMBER item-state leaf, so it is a NUMERIC EQUATION SLOT for
 * free (core/expressions.js: "a property is an equation slot iff the plugin's
 * default is a NUMBER and the folded value is a STRING"). Typing `= slide_number`,
 * `= my_var`, `= box.w`, or `= 3.14159` in its Inspector field binds it to a live
 * computed value; the derive/evaluate stage resolves the equation UP FRONT, so
 * emit() receives the ALREADY-resolved NUMBER in `s.value` and never touches the
 * evaluator. A non-numeric / non-finite equation result is rejected LOUDLY by the
 * shared eval gate (resultMatchesKind → falls back to the default number), so
 * emit() only ever sees a finite number for a real draw.
 *
 * ── STYLING = SHARED REGISTRY, one text() op (the plaintext model) ────────────
 * It composes the SHARED PROPERTY REGISTRY like plaintext.js: the positioning
 * bundle, opacity, the PAINT-capable `fill` prop (relabelled "Color" — a solid
 * colour OR a gradient paints the glyphs for free), and the effects bundle. The
 * numeric-FORMAT knobs (decimals / pad / padWidth / group / prefix / suffix) plus
 * typography (font / size / bold / align / valign) are LOCAL rows — a number
 * format is this widget's own concern, not a shared bundle, so nothing is added
 * to the registry. emit() builds exactly ONE legacy single-run text() op from the
 * formatted string; no new IR op, no plugin imports another.
 *
 * ── NO INLINE EDIT ────────────────────────────────────────────────────────────
 * Unlike plaintext, a number box has NO inline canvas text editor: its value is a
 * number (often an equation), edited in the Inspector's Value field — typing a
 * computed value in place would be meaningless / would clobber the equation. So
 * it deliberately omits plaintext's `inlineTextEdit` opt-in.
 */

import { standardBBoxAnchors } from "../core/derive.js";
import { bundle, bundleNestedDefaults, defaults, props } from "../core/properties.js";
import { text } from "../render_gpu/ir.js";
import { DEFAULT_FONT, fontOptions } from "../render_gpu/fonts.js";
import { applyEffects, effectsCullMargin } from "../render_gpu/effects.js";

// The starting readout value — a plain zero until the user types a number or an
// `=` equation. A NUMBER default is what makes `value` an equation slot.
const DEFAULT_VALUE = 0;
// Two fractional places — the everyday float readout (money / measurement). A
// user drops it to 0 for an integer counter or raises it for more precision.
const DEFAULT_DECIMALS = 2;
// Matches plugins/plaintext.js / plugins/text.js's 36u text size so a number box
// reads at the same size as a text box out of the box (one shared convention).
const DEFAULT_TEXT_SIZE = 36;
// The glyph ink used by the sibling text widgets (plaintext/text #1a1a2e).
const DEFAULT_INK = "#1a1a2e";

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
export function groupThousands(magnitude) {
  const [intPart, fracPart] = magnitude.split(".");
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
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
export function formatNumber(value, opts = {}) {
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
export function numberIsEmpty(value) {
  return !Number.isFinite(Number(value));
}

export const numberPlugin = {
  type: "number",
  title: "Number",
  // resizable:true → the standard 8 resize handles (same machinery as plaintext);
  // w constrains the box width the text aligns within, h gives valign its room.
  capabilities: { bbox: true, transform: true, resizable: true, backdrop: false },
  /**
   * Pure function. Is this box a GHOST (nothing finite to draw)? STATE-dependent,
   * shared with emit()'s short-circuit (numberIsEmpty); core/derive.isGhostNode
   * grants the dashed-outline/findable affordance exactly while the box would draw
   * nothing — the empty plaintext/mermaid/qr opt-in.
   *
   * @param {object} state - the folded item state
   * @returns {boolean}
   *
   * @example numberPlugin.isGhost({ value: 3.14 }) // false
   * @example numberPlugin.isGhost({ value: undefined }) // true
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
    font: DEFAULT_FONT, size: DEFAULT_TEXT_SIZE, bold: false,
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
    { key: "group", label: "Thousands", kind: "checkbox", category: "formatting", help: "Group the integer part with thousands separators (1,234,567)." },
    { key: "prefix", label: "Prefix", kind: "text", category: "formatting", help: "Text placed before the number, e.g. a currency symbol like $." },
    { key: "suffix", label: "Suffix", kind: "text", category: "formatting", help: "Text placed after the number, e.g. a unit like % or px." },
    // Ink color reuses the PAINT-capable registry `fill` prop (solid OR gradient),
    // relabelled for a text widget; text() runs it through parsePaint.
    ...props("fill", { fill: { label: "Color", category: "formatting", help: "The color or gradient the digits are painted with. Pick a solid color or a linear/radial gradient." } }),
    ...props("opacity"),
    { key: "font", label: "Font", kind: "select", options: fontOptions().map((o) => o.value), optionLabels: Object.fromEntries(fontOptions().map((o) => [o.value, o.label])), category: "text", help: "The typeface the digits are drawn in — including a seven-segment display face when one is registered." },
    { key: "size", label: "Size", kind: "number", min: 0, category: "text", help: "Font size in canvas units. Larger is bigger on the slide." },
    { key: "bold", label: "Bold", kind: "checkbox", category: "text", help: "Draw the digits in the font's bold weight." },
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
