/**
 * Shared in-widget ERROR / WARNING affordance IR — the loud "not silent, not a
 * blank widget" chrome for SVG-flatten consumers. Hoisted VERBATIM from
 * plugins/svg.js so that plugins/iconify.js (a thin specialization on the same
 * shared flatten, the cursor-widget pattern) can draw the identical chrome
 * without a plugin→plugin import (the "no plugin imports another" rule).
 * plugins/svg.js re-exports these, so its public surface (and the
 * svg_warning_test.js suite) is unchanged. plugins/latex.js still carries its
 * own earlier copy of the error box — collapsing that one is a separate cleanup.
 *
 * Everything here is a PURE function from (box, message) → vector rect+text IR
 * ops, identical in every backend — see the originals' docblocks below.
 */

import { rect, text } from "./ir.js";

/** Error-affordance colors — a LOUD, unmissable red treatment (the "not silent,
 * not a blank widget" rule), the SAME literals plugins/latex.js documents (emit
 * can't read app.css --a-* tokens; DOM-free IR chrome). */
const ERROR_BG = "#f6c9c4";
const ERROR_BORDER = "#c0392b";
const ERROR_TEXT = "#7a1210";
const ERROR_BORDER_WIDTH = 3;
const ERROR_PADDING = 8;
const ERROR_TEXT_FRACTION = 0.16; // an SVG error message can be long; a smaller fraction fits more

/** Warning-affordance colors — the SAME rect+text chrome as the error box in an
 * AMBER notice treatment. Deliberately not red and not full-box: a flatten warning
 * means the art DID render, only degraded, so the affordance ANNOTATES it instead
 * of replacing it (a mildly-degraded SVG must stay usable). */
const WARN_BG = "#f7dfa5";
const WARN_BORDER = "#a5761b";
const WARN_TEXT = "#4a3505";
const WARN_BORDER_WIDTH = 1;
/** The notice band sits along the BOTTOM edge, at this fraction of the box height
 * but never taller than WARN_BAND_MAX box units — so a small icon is not swallowed
 * and a huge widget gets a slim strip, not a billboard. */
const WARN_BAND_FRACTION = 0.24;
const WARN_BAND_MAX = 40;
/** Slightly translucent, so whatever art the band overlaps stays readable. */
const WARN_BAND_OPACITY = 0.9;
const WARN_TEXT_FRACTION = 0.34; // of the BAND height (the band is the text's box)
const WARN_PADDING = 3;
/** How many punts the band spells out before summarizing the rest as "+N more" —
 * bounded text keeps the band legible on a badly-degraded SVG. */
const WARN_MAX_LISTED = 2;

/**
 * Pure function. The loud in-widget ERROR affordance IR: a red-bordered filled
 * box across the widget's local bbox + the parser error message in red, as
 * VECTOR rect+text ops (crisp, identical in every backend — never a blank
 * widget). The plugins/latex.js errorAffordance, verbatim in shape.
 *
 * @example errorAffordance(200, 60, "malformed SVG").length // 2
 * @example errorAffordance(200, 60, "x")[0].op // "rect"
 */
export function errorAffordance(w, h, message) {
  const box = rect({ x: 0, y: 0, w, h, cornerRadius: 0, fill: ERROR_BG, stroke: ERROR_BORDER, strokeWidth: ERROR_BORDER_WIDTH });
  const size = Math.max(1, h * ERROR_TEXT_FRACTION);
  const label = text({
    text: `SVG error: ${message}`,
    x: ERROR_PADDING, y: ERROR_PADDING,
    size, color: ERROR_TEXT,
    boxW: Math.max(1, w - 2 * ERROR_PADDING), boxH: Math.max(1, h - 2 * ERROR_PADDING),
  });
  return [box, label];
}

/**
 * Pure function. The user-facing label for a flatten warning list: each notice
 * with core/svg_paths.js's `svg: ` prefix dropped (the band already says SVG),
 * the first WARN_MAX_LISTED spelled out, the rest summarized. Empty list → "".
 *
 * @param {string[]} warnings - core/svg_paths.js flatten warnings
 * @returns {string} the band's text
 *
 * @example warningLabel([]) // ""
 * @example warningLabel(["svg: <text> is unsupported in v1 (skipped)"]) // "Unsupported: <text> is unsupported in v1 (skipped)"
 * @example warningLabel(["svg: a", "svg: b", "svg: c"]) // "Unsupported: a; b (+1 more)"
 */
export function warningLabel(warnings) {
  if (!warnings.length) return "";
  const shown = warnings.slice(0, WARN_MAX_LISTED).map((w) => w.replace(/^svg:\s*/, ""));
  const rest = warnings.length - shown.length;
  return `Unsupported: ${shown.join("; ")}${rest > 0 ? ` (+${rest} more)` : ""}`;
}

/**
 * Pure function. The in-widget WARNING affordance IR: an amber notice band along
 * the widget's BOTTOM edge naming the unsupported features (and the elements
 * carrying them), as the same VECTOR rect+text pair errorAffordance uses — so a
 * degraded SVG (a mask/filter/clip-path ignored, a radial gradient
 * flattened) can never quietly look correct. The ART IS STILL DRAWN: this band is
 * appended OVER it, not in place of it (the error box's opposite trade).
 *
 * @param {number} w - widget box width (box-local units)
 * @param {number} h - widget box height
 * @param {string[]} warnings - core/svg_paths.js flatten warnings (non-empty)
 * @returns {object[]} [rect, text] IR ops in box-local space
 *
 * @example warningAffordance(200, 100, ["svg: <text> unsupported"]).length // 2
 * @example warningAffordance(200, 100, ["svg: <text> unsupported"])[0].op // "rect"
 * @example warningAffordance(200, 100, ["svg: <text> unsupported"])[0].y // 76  (h − band, the band hugs the bottom edge)
 */
export function warningAffordance(w, h, warnings) {
  const band = Math.min(h * WARN_BAND_FRACTION, WARN_BAND_MAX);
  const top = h - band;
  const box = rect({
    x: 0, y: top, w, h: band, cornerRadius: 0,
    fill: WARN_BG, stroke: WARN_BORDER, strokeWidth: WARN_BORDER_WIDTH, opacity: WARN_BAND_OPACITY,
  });
  const label = text({
    text: warningLabel(warnings),
    x: WARN_PADDING, y: top + WARN_PADDING,
    size: Math.max(1, band * WARN_TEXT_FRACTION), color: WARN_TEXT,
    boxW: Math.max(1, w - 2 * WARN_PADDING), boxH: Math.max(1, band - 2 * WARN_PADDING),
  });
  return [box, label];
}
