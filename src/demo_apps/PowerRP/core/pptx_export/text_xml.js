/**
 * RICH TEXT -> <p:txBody>. Reuses core/richtext.js's `normalizeRichText` — the
 * SAME resolver plugins/text.js's own emit() calls — so a run's effective
 * style (own key, else widget-level inherited, else the house default) is
 * computed exactly once, the same way for the screen and for this exporter.
 *
 * PARAGRAPH SPLITTING: normalizeRichText returns `{runs, paras}` where `runs`
 * is a FLAT list and newlines live INSIDE run text (core/richtext.js's own
 * convention — see splitParagraphs for the canonical splitter). This module
 * reuses splitParagraphs so paragraph boundaries land exactly where PowerRP's
 * own layout engine puts them.
 */

import { normalizeRichText, splitParagraphs, DEFAULT_PARA_SIZE } from "../richtext.js";
import { DEFAULT_FONT } from "../../render_gpu/fonts.js";
import { tag, xmlEscape } from "./xml_writer.js";
import { srgbClrXml } from "./paint_xml.js";

/** PowerRP text align values -> OOXML `<a:pPr algn>`. PowerRP's set
 * (core/richtext.js PARA_STYLE_KEYS/align option list) is a subset of OOXML's,
 * so this is a passthrough table rather than real translation — kept as a
 * table (not a bare pass-through) so an unrecognized value fails loudly
 * instead of writing an invalid `algn` PowerPoint would choke on. */
const ALIGN_TO_OOXML = { left: "l", center: "ctr", right: "r", justify: "just" };

/**
 * Pure function. OOXML paragraph alignment for a PowerRP `align` value; throws
 * on anything not in ALIGN_TO_OOXML (loud, per this app's no-silent-fallback
 * rule — a paint_path/text alignment PowerRP does not itself define should
 * never be silently coerced to "left").
 *
 * @param {string} align
 * @returns {string}
 *
 * @example ooxmlAlign("center") // "ctr"
 * @example ooxmlAlign("left") // "l"
 */
export function ooxmlAlign(align) {
  const v = ALIGN_TO_OOXML[align];
  if (!v) throw new Error(`ooxmlAlign: unrecognized PowerRP text align ${JSON.stringify(align)} (known: ${Object.keys(ALIGN_TO_OOXML).join(", ")})`);
  return v;
}

/**
 * Pure function. `<a:rPr>` + `<a:t>` for one resolved run (core/richtext.js's
 * `runFrom` output: text/bold/italic/underline/strike/size/font/color, all
 * fields always present). `sz` is centipoints (OOXML convention — the inverse
 * of core/pptx/deck.js's own import-side `centipointsToPoints`), computed from
 * PowerRP's `size` field AS POINTS directly (this widget's own unit — see
 * plugins/text.js: box-level default is `DEFAULT_PARA_SIZE`, an absolute ink
 * height already treated as the font size PowerRP's layout engine uses, so no
 * further unit conversion applies beyond points -> centipoints).
 *
 * @param {object} run - core/richtext.js's runFrom() shape
 * @returns {string}
 */
export function runXml(run) {
  const rPrAttrs = {
    sz: Math.round((run.size ?? DEFAULT_PARA_SIZE) * 100),
    b: run.bold ? "1" : "0",
    i: run.italic ? "1" : "0",
    u: run.underline ? "sng" : "none",
    strike: run.strike ? "sngStrike" : "noStrike",
  };
  const fill = tag("a:solidFill", {}, srgbClrXml(colorToRgba(run.color)));
  const latin = tag("a:latin", { typeface: run.font ?? DEFAULT_FONT });
  const rPr = tag("a:rPr", { ...rPrAttrs, lang: "en-US" }, fill + latin);
  return tag("a:r", {}, rPr + tag("a:t", {}, xmlEscape(run.text)));
}

/** Pure function. A hex color string ("#rrggbb") -> [r,g,b,a] 0..1 — a tiny
 * local parse (not render_gpu/ir.js's parseColor) because run.color is ALWAYS
 * a plain "#rrggbb" string per runFrom's own contract (core/richtext.js), and
 * pulling in the full paint parser here would suggest this accepts gradients,
 * which a text run's fill color never does. */
function colorToRgba(hex) {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16) / 255, g = parseInt(h.slice(2, 4), 16) / 255, b = parseInt(h.slice(4, 6), 16) / 255;
  const a = h.length >= 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
  return [r, g, b, a];
}

/**
 * Command (throws if `align` isn't recognized — see ooxmlAlign). `<p:txBody>`
 * for one text/plaintext widget's resolved rich value: box defaults resolved
 * via normalizeRichText (the SAME call plugins/text.js's emit() makes), then
 * split into paragraphs and each paragraph's runs wrapped in `<a:p>` with its
 * OWN `<a:pPr algn>` (paras[i].align falls back to the box-level `align`).
 *
 * @param {object} state - a text/plaintext item's evaluated state (s.text, s.align, s.font, s.size, s.color, s.bold)
 * @returns {string}
 */
export function textBodyXml(state) {
  const inherited = { font: state.font ?? DEFAULT_FONT, size: state.size ?? DEFAULT_PARA_SIZE, color: state.color ?? "#000000", bold: state.bold ?? false };
  const rich = normalizeRichText(state.text, inherited);
  // splitParagraphs(runs) -> [[{text, style}, ...], ...]: one array of
  // {text, style} pieces PER PARAGRAPH (core/richtext.js — style is the run's
  // resolved style minus `text`). Re-flatten each piece to the {text, ...style}
  // shape runXml expects (the same shape runFrom/normalizeRichText's runs carry).
  const paragraphs = splitParagraphs(rich.runs);
  const bodyPr = tag("a:bodyPr", { wrap: "square" }, tag("a:normAutofit"));
  let paraXml = "";
  paragraphs.forEach((pieces, i) => {
    const align = ooxmlAlign(rich.paras[i]?.align ?? state.align ?? "left");
    const runs = pieces.map((p) => runXml({ text: p.text, ...p.style })).join("");
    paraXml += tag("a:p", {}, tag("a:pPr", { algn: align }) + (runs || tag("a:endParaRPr", { lang: "en-US" })));
  });
  return tag("p:txBody", {}, bodyPr + tag("a:lstStyle") + (paraXml || tag("a:p")));
}
