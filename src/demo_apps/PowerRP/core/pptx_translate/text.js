/**
 * TEXT — DeckIR's resolved `{paragraphs: [{align, runs}]}` (already
 * inheritance-resolved by core/pptx/text.js, per this task's ownership split)
 * -> PowerRP's flat-runs + para-spans rich value (core/richtext.js): `{runs,
 * paras}`, where `paras.length` PARAGRAPHS are delimited by literal `"\n"`
 * characters EMBEDDED in the run text (core/richtext.normalizeRichText's own
 * paragraph-count rule — see that module's header).
 *
 * Every run is written with EXPLICIT style keys (never left to fall back to
 * the text widget's box-level style) because a DeckIR run's resolved style is
 * genuinely per-run — PowerPoint has no "box style" concept a PowerRP-style
 * fallback could stand in for.
 */

import { resolveColorHex } from "./paint.js";
import { resolveFontId } from "./fonts.js";

/** PPTX horizontal alignment -> PowerRP's `align` enum (mapping spec §6, DIRECT). */
const ALIGN_MAP = { l: "left", ctr: "center", r: "right", just: "justify" };

/** PPTX vertical anchor -> PowerRP's `valign` enum (mapping spec §6, DIRECT
 * for t/ctr/b; "just" has no PowerRP equivalent, treated as "middle"). */
const VALIGN_MAP = { t: "top", ctr: "middle", b: "bottom" };

/**
 * Pure function. One DeckIR run -> a PowerRP run (core/richtext.js
 * RUN_STYLE_KEYS), resolving its color through the theme and its font
 * through the font registry. `underline`/`strike` collapse to PowerRP's
 * boolean model (mapping spec §5 TWEAK: PowerRP has no styled-underline
 * variants yet) — any non-"none"/"sng" PPTX underline style is still drawn
 * as a plain underline, reported as a fidelity gap by the caller.
 *
 * @param {object} runIR - a DeckIR text run (already inheritance-resolved)
 * @param {Record<string,string>} colorMap
 * @param {Record<string,string>} colorScheme
 * @param {Map<string,string>} fontTitleIndex - fonts.fontTitleIndex() output
 * @returns {{run: object, fontSubstitution: {wanted:string,used:string}|null, underlineGap: string|null}}
 */
export function translateRun(runIR, colorMap, colorScheme, fontTitleIndex) {
  const { hex } = resolveColorHex({ kind: "srgb", hex: runIR.color ?? "000000" }, colorMap, colorScheme);
  const { used: font, substitution } = resolveFontId(runIR.font ?? "", fontTitleIndex);
  const underlineOn = runIR.underline && runIR.underline !== "none";
  const underlineGap = underlineOn && runIR.underline !== "sng"
    ? `run underline style "${runIR.underline}" has no PowerRP styled-underline equivalent yet (mapping spec §5 TWEAK) — drawn as a plain underline`
    : null;
  return {
    run: {
      text: runIR.text,
      bold: !!runIR.bold,
      italic: !!runIR.italic,
      underline: !!underlineOn,
      strike: false, // DeckIR text.js does not surface strike yet (no PPTX strike field parsed by stage 1)
      size: runIR.sizePt,
      font,
      color: hex,
      outlineColor: "#000000",
      outlineWidth: 0,
      highlight: "",
    },
    fontSubstitution: substitution,
    underlineGap,
  };
}

/**
 * Pure function. A DeckIR `{paragraphs}` -> PowerRP's rich `{runs, paras}`
 * plus the gaps collected translating it (font substitutions, underline
 * style gaps) — one paragraph's runs are emitted in order, followed by a
 * `"\n"` on the LAST run's text if another paragraph follows (embedding the
 * paragraph break the way core/richtext.js's own paragraph-count rule reads
 * it back out). An empty paragraph (no runs — deck 1's bare `endParaRPr`
 * placeholders) still needs a run to carry its own "\n", so it gets one
 * empty-text run.
 *
 * @param {{paragraphs: object[]}} textIR - DeckIR shape.text
 * @param {Record<string,string>} colorMap
 * @param {Record<string,string>} colorScheme
 * @param {Map<string,string>} fontTitleIndex
 * @returns {{rich: {runs:object[], paras:object[]}, fontSubstitutions: object[], gaps: string[]}}
 *
 * @example
 * >>> const ix = new Map();
 * >>> translateText({paragraphs:[{level:0, align:"l", runs:[{text:"Hi", sizePt:18, bold:false, italic:false, underline:"none", color:"000000", font:"Arial"}]}]}, {}, {}, ix).rich.runs[0].text
 * "Hi"
 */
export function translateText(textIR, colorMap, colorScheme, fontTitleIndex) {
  const runs = [];
  const paras = [];
  const fontSubstitutions = [];
  const gaps = [];
  textIR.paragraphs.forEach((p, i) => {
    paras.push({ align: ALIGN_MAP[p.align] ?? "left" });
    const isLast = i === textIR.paragraphs.length - 1;
    if (p.runs.length === 0) {
      runs.push({ text: isLast ? "" : "\n", bold: false, italic: false, underline: false, strike: false, size: 18, font: "system", color: "#000000", outlineColor: "#000000", outlineWidth: 0, highlight: "" });
      return;
    }
    p.runs.forEach((r, ri) => {
      const { run, fontSubstitution, underlineGap } = translateRun(r, colorMap, colorScheme, fontTitleIndex);
      const isLastRunInPara = ri === p.runs.length - 1;
      if (isLastRunInPara && !isLast) run.text += "\n";
      runs.push(run);
      if (fontSubstitution) fontSubstitutions.push(fontSubstitution);
      if (underlineGap) gaps.push(underlineGap);
    });
  });
  return { rich: { runs, paras }, fontSubstitutions, gaps };
}

/**
 * Pure function. PPTX `normAutofit`'s cached `fontScale`/`lnSpcReduction`
 * (percent-as-1000ths, ECMA-376 ST_TextFontScalePercentOrPercentString style
 * — but DeckIR text.js does not surface bodyPr yet, so this takes plain
 * fractions) applied VERBATIM to a translated rich value's run sizes and
 * paragraph line spacing (mapping spec §6: "apply cached values directly,
 * never re-derive"). Absent/1.0 scale is a no-op, so a shape with no
 * autofit is untouched by this function's call site.
 *
 * @param {{runs:object[], paras:object[]}} rich
 * @param {number} fontScale - e.g. 0.925 for 92.5%
 * @param {number} lnSpcReduction - e.g. 0.1 for 10%
 * @param {number} baseLineSpacing - the paragraph's un-reduced line spacing multiplier
 * @returns {{runs:object[], paras:object[]}}
 *
 * @example applyNormAutofit({runs:[{size:36}], paras:[{}]}, 0.5, 0, 1).runs[0].size // 18
 */
export function applyNormAutofit(rich, fontScale, lnSpcReduction, baseLineSpacing) {
  return {
    runs: rich.runs.map((r) => ({ ...r, size: r.size * fontScale })),
    paras: rich.paras.map((p) => ({ ...p, lineSpacing: baseLineSpacing * (1 - lnSpcReduction) })),
  };
}

export { ALIGN_MAP, VALIGN_MAP };
