/**
 * RICH TEXT — the model, string→runs migration, and the ONE pure layout module
 * (manifest "RICH TEXT" / ARCHITECTURE PLAN #7 / "Text boxes are REAL boxes").
 *
 * ── THE MODEL ────────────────────────────────────────────────────────────────
 * A rich-text value is:
 *
 *   { runs:  [{ text, bold, italic, underline, strike, size, font, color }...],
 *     paras: [{ align, lineSpacing, charSpacing, wordSpacing }...] }
 *
 * NESTING — paragraphs are SPANS OVER the run list, NOT containers of runs.
 * A run may straddle a "\n" (a newline inside a run's text splits paragraphs),
 * and a paragraph boundary need not coincide with a run boundary — so making
 * `paras` OWN `runs` (the conventional PPT/HTML nesting) would force every
 * bold/italic toggle to also re-partition paragraphs, and every Enter to
 * re-partition runs. Instead:
 *   - RUNS carry ONLY character-level style (bold/italic/underline/strike/
 *     size/font/color). Run order + text (with embedded "\n") is the whole
 *     character stream.
 *   - PARAS carry ONLY paragraph-level style (align/lineSpacing/charSpacing/
 *     wordSpacing), one entry per paragraph in order. Paragraph i's style is
 *     paras[i] (or the first/only entry as a fallback — see paraStyleFor).
 * This keeps the two style axes ORTHOGONAL: a character-style edit touches only
 * runs, a paragraph-style edit touches only paras, and neither re-partitions
 * the other. The character stream is split into paragraphs at "\n" purely for
 * layout (splitParagraphs) — a derived view, never stored.
 * WHY runs-are-flat over the HTML tree: the SET-2 editing UX (cursor/selection)
 * operates on a linear character offset; a flat run list maps to offsets with
 * no tree walk, and the layout's glyph runs carry that offset back for hit-
 * testing. (Justification recorded per the task's "justify WHY".)
 *
 * TWEEN — the whole value is a NON-NUMERIC leaf (arrays are leaf values to the
 * delta walker, core/deltas.isTree), so it SNAPS DISCRETELY at alpha > 0
 * (manifest: "rich text snaps discretely"). No per-run interpolation.
 *
 * ── THE LAYOUT ───────────────────────────────────────────────────────────────
 * layoutRichText(rich, boxW, measureRun) is PURE and DOM-FREE: all font metrics
 * come through the injected `measureRun` seam (canvas2D in both browser
 * backends; a deterministic mono-metrics stub in node tests). It produces
 * positioned LINE BOXES of GLYPH RUNS plus underline/strike DECORATION LINES,
 * in the widget's LOCAL space (top-left origin, y-down) — the SAME output both
 * the GPU compositor and the PDF/SVG backends consume (one layout, two
 * backends: the parity lever). Word wrap is box-constrained to boxW so text
 * never overflows horizontally (the user's bug); wrapped lines flow downward.
 *
 * DOM-free pure JS (bare-node testable, like the rest of core/).
 */

// ── canonical run/paragraph style ────────────────────────────────────────────

/** The character-level style keys a run carries (paragraph style lives in paras). */
export const RUN_STYLE_KEYS = ["bold", "italic", "underline", "strike", "size", "font", "color"];

/** The paragraph-level style keys a paragraph carries. */
export const PARA_STYLE_KEYS = ["align", "lineSpacing", "charSpacing", "wordSpacing"];

/** Default paragraph style. align ∈ left|center|right|justify; spacings are
 * multipliers/px offsets (lineSpacing × natural line height; char/wordSpacing
 * add device-independent px between chars/words). */
export const DEFAULT_PARA = { align: "left", lineSpacing: 1, charSpacing: 0, wordSpacing: 0 };

// ── the string→runs migration + normalization ────────────────────────────────

/**
 * Pure function. Canonicalizes any stored `text` value into a {runs, paras}
 * rich value. Accepts:
 *   - a bare STRING (legacy / plugin default) → ONE run inheriting the widget's
 *     own font/size/color/bold (the widget-level style keys), split into
 *     paragraphs by "\n" (each paragraph = one DEFAULT_PARA);
 *   - an already-rich {runs, paras} → returned normalized (missing paras filled
 *     with DEFAULT_PARA, runs coerced to carry `text`).
 * A migration is LOUD at the LOAD boundary via richTextMigrations (below); this
 * function itself is the pure normalizer both the migration and emit() use.
 *
 * `inherited` supplies the widget-level fallbacks a legacy string had no runs
 * to carry (so old docs render byte-identically: the single run inherits the
 * widget's font/size/color/bold verbatim).
 *
 * Args:
 *   value (string|object): stored text value
 *   inherited (object): {font, size, color, bold} widget-level fallbacks
 *
 * Returns:
 *   {runs, paras}: canonical rich value (runs carry text + full run style)
 *
 * @example normalizeRichText("Hi", {font: "inter", size: 20, color: "#000", bold: false}).runs.length // 1
 * @example normalizeRichText("Hi", {size: 20}).runs[0].text // "Hi"
 * @example normalizeRichText("a\nb", {}).paras.length // 2
 * @example normalizeRichText({runs: [{text: "x"}], paras: []}, {}).paras.length // 1
 */
export function normalizeRichText(value, inherited = {}) {
  if (typeof value === "string") {
    const paraCount = value.split("\n").length;
    return {
      runs: [runFrom({ text: value }, inherited)],
      paras: Array.from({ length: paraCount }, () => ({ ...DEFAULT_PARA })),
    };
  }
  if (value && typeof value === "object" && Array.isArray(value.runs)) {
    const runs = value.runs.map((r) => runFrom(r, inherited));
    const text = runs.map((r) => r.text).join("");
    const paraCount = Math.max(1, text.split("\n").length);
    const paras = [];
    for (let i = 0; i < paraCount; i++) paras.push({ ...DEFAULT_PARA, ...(value.paras?.[i] ?? {}) });
    return { runs, paras };
  }
  // Any other shape (null/number/etc.) → an empty single run (loud callers
  // report the migration; the render path must never throw on a weird value).
  return { runs: [runFrom({ text: "" }, inherited)], paras: [{ ...DEFAULT_PARA }] };
}

/** Pure function. A canonical run from a partial run + widget-level inherited
 * style. text defaults to ""; run style keys fall back to `inherited` then to
 * sane defaults, so a legacy single run reproduces the old widget exactly.
 *
 * @example runFrom({text: "x"}, {size: 20, color: "#111"}).size // 20
 * @example runFrom({text: "x", bold: true}, {}).bold // true
 * @example runFrom({text: "x"}, {}).italic // false
 */
export function runFrom(r, inherited = {}) {
  return {
    text: typeof r.text === "string" ? r.text : "",
    bold: r.bold ?? inherited.bold ?? false,
    italic: r.italic ?? inherited.italic ?? false,
    underline: r.underline ?? inherited.underline ?? false,
    strike: r.strike ?? inherited.strike ?? false,
    size: r.size ?? inherited.size ?? 36,
    font: r.font ?? inherited.font ?? "system",
    color: r.color ?? inherited.color ?? "#000000",
  };
}

/**
 * Pure function. Is a stored `text` value a LEGACY plain string (needs the
 * loud string→runs migration)? A canonical rich value is a {runs} object.
 *
 * @example isLegacyString("Hi") // true
 * @example isLegacyString({runs: [], paras: []}) // false
 */
export function isLegacyString(value) {
  return typeof value === "string";
}

/**
 * Pure function. The plain-text projection of a rich value (all runs' text
 * concatenated, "\n" preserved). For hit-testing offsets, empty detection, the
 * dblclick stopgap editor, and any consumer that needs a bare string.
 *
 * @example richTextToPlain({runs: [{text: "Hi "}, {text: "there"}], paras: [{}]}) // "Hi there"
 * @example richTextToPlain("legacy") // "legacy"
 * @example richTextToPlain({runs: [], paras: []}) // ""
 */
export function richTextToPlain(value) {
  if (typeof value === "string") return value;
  if (value && Array.isArray(value.runs)) return value.runs.map((r) => r.text ?? "").join("");
  return "";
}

/**
 * Pure function. Is a rich value empty (no visible characters)? An empty text
 * box is a GHOST (manifest: "empty text boxes" are ghost objects) — this is the
 * model-level predicate a ghost/isGhost hook can call.
 *
 * @example richTextIsEmpty({runs: [{text: ""}], paras: [{}]}) // true
 * @example richTextIsEmpty("hi") // false
 * @example richTextIsEmpty({runs: [{text: " "}], paras: [{}]}) // false (whitespace is content)
 */
export function richTextIsEmpty(value) {
  return richTextToPlain(value).length === 0;
}

// ── paragraph splitting (derived view, never stored) ─────────────────────────

/**
 * Pure function. Splits a flat run list into PARAGRAPHS at "\n": returns an
 * array of paragraphs, each a list of {text, style} PIECES (a run split at its
 * newlines; the "\n" itself is dropped — it is the paragraph separator). An
 * empty run list yields one empty paragraph (so an empty text box still lays
 * out one line box — its height/baseline exist for the cursor). A trailing
 * "\n" yields a trailing empty paragraph (PowerPoint shows that blank line).
 *
 * Args:
 *   runs (object[]): canonical runs (each carries text + run style)
 *
 * Returns:
 *   object[][]: paragraphs; each is [{text, style}] pieces (style = the run
 *     minus its text; text has no "\n")
 *
 * @example splitParagraphs([{text: "ab", size: 10}]).length // 1
 * @example splitParagraphs([{text: "a\nb", size: 10}]).length // 2
 * @example splitParagraphs([{text: "a\nb"}])[0][0].text // "a"
 * @example splitParagraphs([]).length // 1
 */
export function splitParagraphs(runs) {
  const paras = [[]];
  for (const run of runs) {
    const { text, ...style } = run;
    const segments = text.split("\n");
    segments.forEach((seg, i) => {
      if (i > 0) paras.push([]); // a "\n" started a new paragraph
      if (seg.length > 0) paras[paras.length - 1].push({ text: seg, style });
    });
  }
  return paras;
}

/** Pure function. Paragraph i's effective style, layering (lowest→highest):
 * DEFAULT_PARA ‹ the widget-level box defaults (align/spacing set on the text
 * item itself — the SET-1 Inspector's one-alignment-per-box control) ‹ this
 * paragraph's own overrides paras[i] (the SET-2 per-paragraph UX). Robust to a
 * paras array shorter than the split paragraph count (a run edit added a "\n"
 * before paras caught up; layout must not throw) — falls back to the first
 * entry then the box defaults.
 *
 * @example paraStyleFor([{align: "center"}], 0).align // "center"
 * @example paraStyleFor([{align: "right"}], 5).align // "right" (falls back to first)
 * @example paraStyleFor([], 0).align // "left" (default)
 * @example paraStyleFor([], 0, {align: "center"}).align // "center" (box default underlies)
 * @example paraStyleFor([{align: "right"}], 0, {align: "center"}).align // "right" (para overrides box)
 */
export function paraStyleFor(paras, i, boxStyle = {}) {
  const box = {};
  for (const k of PARA_STYLE_KEYS) if (boxStyle[k] !== undefined) box[k] = boxStyle[k];
  return { ...DEFAULT_PARA, ...box, ...(paras?.[i] ?? paras?.[0] ?? {}) };
}

// ── word wrap ─────────────────────────────────────────────────────────────────

/**
 * Pure function. Greedy word-wrap of one paragraph's pieces into LINES, each a
 * list of positioned glyph runs is NOT built here — this returns WRAPPED PIECES
 * (piece text broken at wrap points), still unpositioned. Wrapping happens at
 * WHITESPACE; a single word longer than boxW is placed on its own line and
 * allowed to overflow (breaking mid-word arbitrarily is worse for text — PPT
 * also overflows a too-long unbreakable word). Trailing whitespace at a wrap
 * point is dropped so alignment measures the visible width.
 *
 * measureRun(text, style) → {width, ...} supplies each substring's advance;
 * called on substrings (memoize upstream — the atlas already caches per glyph).
 *
 * Args:
 *   pieces (object[]): [{text, style}] of ONE paragraph (no "\n")
 *   boxW (number): wrap width in local units (Infinity disables wrapping)
 *   measureRun (fn): (text, style) → {width}
 *
 * Returns:
 *   object[][]: lines; each is [{text, style}] pieces whose total width ≤ boxW
 *     (except an unbreakable overlong word)
 *
 * @example wrapParagraph([{text: "a b", style: {}}], Infinity, (t) => ({width: t.length})).length // 1
 * @example wrapParagraph([{text: "aa bb", style: {}}], 3, (t) => ({width: t.length})).length // 2
 * @example wrapParagraph([], 100, () => ({width: 0})).length // 1
 */
export function wrapParagraph(pieces, boxW, measureRun) {
  // Tokenize into WORDS and their trailing whitespace, preserving each token's
  // originating run style. A "word" is a maximal run of non-space chars; the
  // whitespace after it is a separate token so a wrap can drop it.
  const tokens = [];
  for (const { text, style } of pieces) {
    const re = /(\s+)|(\S+)/g;
    let m;
    while ((m = re.exec(text)) !== null) tokens.push({ text: m[0], space: m[1] !== undefined, style });
  }
  if (tokens.length === 0) return [[]];

  const lines = [[]];
  let lineW = 0;
  const push = (tok) => lines[lines.length - 1].push({ text: tok.text, style: tok.style });
  const newline = () => { lines.push([]); lineW = 0; };

  for (const tok of tokens) {
    const w = measureRun(tok.text, tok.style).width;
    if (tok.space) {
      // Whitespace: keep it if the line already has content and it fits;
      // otherwise it's a wrap-point casualty (dropped). Never starts a line.
      if (lineW > 0 && lineW + w <= boxW) { push(tok); lineW += w; }
      continue;
    }
    // A word. Fits on the current line? place it. Else wrap first (unless the
    // line is empty — an overlong word on its own line is allowed to overflow).
    if (lineW > 0 && lineW + w > boxW) newline();
    push(tok);
    lineW += w;
  }
  // Drop trailing whitespace tokens left on each line (they'd skew alignment).
  for (const line of lines) {
    while (line.length && /^\s+$/.test(line[line.length - 1].text)) line.pop();
  }
  return lines;
}

// ── the layout ────────────────────────────────────────────────────────────────

/** Default multiplier from a line's max font size to its baseline-to-baseline
 * advance, used only when a face reports no line metrics. 1.2 is the canonical
 * CSS "normal" line-height ratio (W3C CSS2 §10.8.1 examples use 1.0–1.2; 1.2 is
 * the de-facto browser default) — a linked typographic precedent, not an
 * invented number. Paragraph lineSpacing multiplies this. */
export const NATURAL_LINE_HEIGHT = 1.2;

/** Underline/strike stroke thickness as a fraction of run font size, and their
 * vertical offset from the baseline as a fraction of size. Values match common
 * font underlinePosition/underlineThickness ratios (≈1/14 thickness; underline
 * ≈0.1·size below baseline; strike ≈0.3·size above baseline, i.e. mid-x-height)
 * — typographic conventions, flagged PENDING RATIFICATION as the task requires
 * for non-precedent-linked constants. */
export const DECORATION_THICKNESS_FRAC = 1 / 14;
export const UNDERLINE_OFFSET_FRAC = 0.11;
export const STRIKE_OFFSET_FRAC = -0.3;

/**
 * Pure function. Lays out a rich-text value inside a box of width boxW into
 * positioned line boxes of GLYPH RUNS plus decoration lines, in LOCAL space
 * (top-left origin, y-down). This is THE layout both backends consume.
 *
 * measureRun(text, style) MUST return { width, ascent, descent } in the SAME
 * local units as `size` (i.e. metrics at the run's own `style.size`): width =
 * total advance of `text`, ascent/descent = the face's max ascent/descent.
 * (In the browser both backends build it from canvas2D measureText +
 * fontBoundingBoxAscent/Descent; node tests inject a mono stub.) charSpacing/
 * wordSpacing are applied HERE (added per char / per space) so measureRun stays
 * a pure advance query.
 *
 * Args:
 *   rich (object): canonical {runs, paras} (run normalizeRichText first)
 *   boxW (number): wrap width in local units; Infinity ⇒ no wrap
 *   measureRun (fn): (text, style) → {width, ascent, descent}
 *   boxStyle (object): widget-level paragraph defaults (align/lineSpacing/
 *     charSpacing/wordSpacing set on the text item — the SET-1 one-alignment-
 *     per-box control); underlies each paragraph's own paras[i] overrides.
 *
 * Returns:
 *   {
 *     lines: [{ y, baseline, height, width, glyphRuns: [{ x, text, style }] }],
 *     decorations: [{ kind: "underline"|"strike", x, y, w, thickness, color }],
 *     width, height   // total laid-out extent (may exceed boxW for overlong words / h for overflow)
 *   }
 * All coordinates local, y-down; glyphRun.x is the pen origin, .y is the LINE's
 * top (a backend advances the pen and top-anchors each glyph like the existing
 * text op). baseline is the line-top→baseline offset.
 *
 * @example layoutRichText({runs: [{text: "ab", size: 10, color: "#000"}], paras: [{align: "left"}]}, Infinity, monoMeasure).lines.length // 1
 * @example layoutRichText({runs: [{text: "a\nb", size: 10, color: "#000"}], paras: [{}, {}]}, Infinity, monoMeasure).lines.length // 2
 * @example layoutRichText({runs: [], paras: []}, 100, monoMeasure).lines.length // 1
 */
export function layoutRichText(rich, boxW, measureRun, boxStyle = {}) {
  const { runs, paras } = rich;
  const paragraphs = splitParagraphs(runs);
  const lines = [];
  const decorations = [];
  let y = 0;
  let maxWidth = 0;

  paragraphs.forEach((pieces, pIndex) => {
    const pstyle = paraStyleFor(paras, pIndex, boxStyle);
    // Apply char/word spacing by wrapping measureRun so wrap + alignment both
    // see the spaced widths. Spacing is device-independent px added per char
    // (charSpacing) and per space char (wordSpacing).
    const measure = spacedMeasure(measureRun, pstyle.charSpacing ?? 0, pstyle.wordSpacing ?? 0);
    const wrapped = wrapParagraph(pieces, boxW, measure);

    wrapped.forEach((linePieces, lineIndex) => {
      // A paragraph's LAST wrapped line stays left-aligned under justify (the
      // universal typographic rule — justifying a short final line looks wrong);
      // every earlier wrapped line stretches to boxW.
      const isLastLine = lineIndex === wrapped.length - 1;

      // Line metrics: max ascent/descent over the line's runs (empty line uses
      // the paragraph's first piece style, or a default, so blank lines still
      // advance — the cursor needs their height).
      let ascent = 0, descent = 0, lineW = 0;
      const measured = linePieces.map((p) => {
        const m = measure(p.text, p.style);
        ascent = Math.max(ascent, m.ascent);
        descent = Math.max(descent, m.descent);
        lineW += m.width;
        return { ...p, width: m.width };
      });
      if (measured.length === 0) {
        const fallback = pieces[0]?.style ?? runs[0] ?? { size: DEFAULT_PARA_SIZE };
        const m = measure("", fallback);
        ascent = m.ascent; descent = m.descent;
      }
      const naturalHeight = (ascent + descent) * (pstyle.lineSpacing ?? 1);
      // The extra line-gap beyond ascent+descent (from lineSpacing > 1) is split
      // above/below so text sits centered in its line box — matches how browsers
      // distribute half-leading.
      const contentHeight = ascent + descent;
      const halfLeading = Math.max(0, naturalHeight - contentHeight) / 2;
      const baseline = halfLeading + ascent;

      // Horizontal alignment. left/center/right shift the whole line by the
      // slack; justify (non-last lines) instead stretches inter-piece gaps.
      const slack = boxW === Infinity ? 0 : Math.max(0, boxW - lineW);
      let startX = 0;
      if (pstyle.align === "center") startX = slack / 2;
      else if (pstyle.align === "right") startX = slack;

      const gapCount = Math.max(0, measured.length - 1);
      const justifyGap = pstyle.align === "justify" && boxW !== Infinity && gapCount > 0 && !isLastLine
        ? slack / gapCount : 0;

      // Position glyph runs left→right from startX.
      const glyphRuns = [];
      let pen = startX;
      measured.forEach((p, i) => {
        glyphRuns.push({ x: pen, text: p.text, style: p.style });
        // Decoration lines span exactly this piece at its baseline (color +
        // thickness/offset from the run's own style).
        addDecorations(decorations, p, pen, y, baseline);
        pen += p.width + (i < measured.length - 1 ? justifyGap : 0);
      });
      const lineExtent = glyphRuns.length ? (pen - (justifyGap && gapCount ? justifyGap : 0)) : startX;
      maxWidth = Math.max(maxWidth, lineExtent);

      lines.push({ y, baseline, height: naturalHeight, width: lineW, glyphRuns });
      y += naturalHeight;
    });
  });

  return { lines, decorations, width: maxWidth, height: y };
}

/**
 * Pure function. Flattens a rich-text op into backend-neutral POSITIONED DRAWS
 * that BOTH render backends consume identically — the parity lever's single
 * seam. Runs the shared layout, then emits one single-run TEXT DRAW per laid-out
 * glyph run (absolute local coords = op origin + glyph run position, top-
 * anchored exactly like the existing single-run text op) plus one LINE per
 * underline/strike decoration.
 *
 * The GPU compositor packs each textDraw as glyph quads (its existing pen loop)
 * and each line as a segment; the PDF backend emits Tf/Tj per textDraw and a
 * vector line per decoration. Neither backend re-implements layout.
 *
 * Args:
 *   cmd (object): a rich text IR op ({rich, x, y, boxW, boxStyle, opacity, ...})
 *   measureRun (fn): (text, style) → {width, ascent, descent} (backend's seam)
 *
 * Returns:
 *   { textDraws: [{text, x, baselineY, size, color, bold, italic, font, opacity}],
 *     lines:     [{x, y, w, thickness, color, opacity}],
 *     width, height }
 * LOCAL (op-relative) coords. `baselineY` is the run's shared line baseline — a
 * backend top-anchors it at (baselineY − its own measured ascent) so mixed-size
 * runs on one line align at the SAME baseline (not each at its own top). This
 * matches how the existing single-run text op derives baseline = top + ascent.
 * Decoration `lines` have y already at the decoration's world Y (baseline-relative).
 *
 * @example richTextDraws({rich: {runs: [{text: "ab", size: 10, color: "#000"}], paras: [{}]}, x: 5, y: 3, boxW: Infinity, opacity: 1}, monoMeasure).textDraws[0].x // 5
 * @example richTextDraws({rich: {runs: [{text: "ab", size: 10, color: "#000"}], paras: [{}]}, x: 5, y: 3, boxW: Infinity, opacity: 1}, monoMeasure).textDraws.length // 1
 * @example richTextDraws({rich: {runs: [{text: "a", size: 10, color: "#000", underline: true}], paras: [{}]}, x: 0, y: 0, boxW: Infinity, opacity: 1}, monoMeasure).lines.length // 1
 */
export function richTextDraws(cmd, measureRun) {
  const layout = layoutRichText(cmd.rich, cmd.boxW ?? Infinity, measureRun, cmd.boxStyle ?? {});
  const ox = cmd.x, oy = cmd.y, opacity = cmd.opacity ?? 1;
  const textDraws = [];
  for (const line of layout.lines) {
    for (const g of line.glyphRuns) {
      if (g.text.length === 0) continue;
      const st = g.style;
      textDraws.push({
        text: g.text,
        x: ox + g.x,
        baselineY: oy + line.y + line.baseline, // shared line baseline
        size: st.size ?? DEFAULT_PARA_SIZE,
        color: st.color ?? "#000000",
        bold: !!st.bold,
        italic: !!st.italic,
        font: st.font ?? "system",
        opacity,
      });
    }
  }
  const lines = layout.decorations.map((d) => ({
    x: ox + d.x, y: oy + d.y, w: d.w, thickness: d.thickness, color: d.color, opacity,
  }));
  return { textDraws, lines, width: layout.width, height: layout.height };
}

const DEFAULT_PARA_SIZE = 36;

/** Pure helper. Wraps a measureRun to add per-char charSpacing and per-space
 * wordSpacing into the advance (so wrap + alignment see spaced widths). Ascent/
 * descent pass through unchanged. */
function spacedMeasure(measureRun, charSpacing, wordSpacing) {
  if (!charSpacing && !wordSpacing) return measureRun;
  return (text, style) => {
    const base = measureRun(text, style);
    const chars = [...text];
    const spaces = chars.filter((c) => c === " ").length;
    return { ...base, width: base.width + chars.length * charSpacing + spaces * wordSpacing };
  };
}

/** Command (pushes into `out`). Appends underline/strike decoration lines for a
 * positioned piece. x = piece pen origin, lineY = line top, baseline = top→
 * baseline offset; the line spans piece.width. Only runs with underline/strike
 * get lines. */
function addDecorations(out, piece, x, lineY, baseline) {
  const st = piece.style;
  const size = st.size ?? DEFAULT_PARA_SIZE;
  const thickness = Math.max(0.5, size * DECORATION_THICKNESS_FRAC);
  if (st.underline) {
    out.push({ kind: "underline", x, y: lineY + baseline + size * UNDERLINE_OFFSET_FRAC, w: piece.width, thickness, color: st.color ?? "#000000" });
  }
  if (st.strike) {
    out.push({ kind: "strike", x, y: lineY + baseline + size * STRIKE_OFFSET_FRAC, w: piece.width, thickness, color: st.color ?? "#000000" });
  }
}

// ── a deterministic measure stub for node tests / doctests ────────────────────

/**
 * Pure function. A DOM-free monospace measure seam for tests and doctests:
 * every glyph is `size` wide, ascent 0.8·size, descent 0.2·size. Deterministic,
 * no canvas — lets the pure layout be doctested and node-tested without a
 * browser (the real seams inject canvas2D metrics; the layout math is identical).
 *
 * @example monoMeasure("ab", {size: 10}).width // 20
 * @example monoMeasure("a", {size: 10}).ascent // 8
 * @example monoMeasure("", {size: 10}).width // 0
 */
export function monoMeasure(text, style) {
  const size = style?.size ?? DEFAULT_PARA_SIZE;
  return { width: [...text].length * size, ascent: size * 0.8, descent: size * 0.2 };
}

// ── loud document migration (string `text` → runs) ────────────────────────────

/**
 * Pure function. Reports every text item whose stored `text` is a LEGACY plain
 * string that the load boundary must convert to a rich {runs, paras} value.
 * Scans EVERY slide delta (a keyframed text change on a later slide is also a
 * string to migrate). isTextType(type) tells it which items are text widgets —
 * so this module stays registry-free (DOM-free, no plugin import).
 *
 * REPORTING IS THE CALLER'S JOB (the app console.errors each entry at load —
 * silent repairs are forbidden). Idempotent: a fully-rich document reports [].
 *
 * Args:
 *   doc (object): document
 *   isTextType (fn): (typeString) → boolean
 *
 * Returns:
 *   {id, slideIndex}[] — the legacy-string text writes to convert
 *
 * @example richTextMigrations({slides: [{delta: {items: {a: {type: "text", text: "Hi"}}}}]}, (t) => t === "text").length // 1
 * @example richTextMigrations({slides: [{delta: {items: {a: {type: "text", text: {runs: [], paras: []}}}}}]}, (t) => t === "text").length // 0
 * @example richTextMigrations({slides: [{delta: {items: {a: {type: "rect", text: "x"}}}}]}, (t) => t === "text").length // 0 (not a text widget)
 */
export function richTextMigrations(doc, isTextType) {
  // Resolve each id's creation type (first slide that writes a string type).
  const typeOf = new Map();
  for (const s of doc.slides)
    for (const [id, item] of Object.entries(s.delta.items ?? {}))
      if (item && typeof item === "object" && typeof item.type === "string" && !typeOf.has(id))
        typeOf.set(id, item.type);
  const out = [];
  doc.slides.forEach((s, slideIndex) => {
    for (const [id, item] of Object.entries(s.delta.items ?? {})) {
      if (!(item && typeof item === "object") || !("text" in item)) continue;
      if (!isTextType(typeOf.get(id))) continue;
      if (isLegacyString(item.text)) out.push({ id, slideIndex });
    }
  });
  return out;
}

/**
 * Pure function. Document with every legacy-string text value converted IN PLACE
 * to a rich {runs, paras} value (one run inheriting the item's own FOLDED
 * font/size/color/bold at that write — best-effort from the same delta, else the
 * runFrom defaults), plus the migration report. The value stays a single
 * keyframable non-numeric leaf (discrete-snap). REPORTING IS THE CALLER'S JOB.
 * Idempotent.
 *
 * inheritedStyleAt(id, slideIndex) → {font, size, color, bold} supplies the
 * widget-level style the single run should inherit (the app passes a folded-
 * state reader; a null seam falls back to whatever the delta itself carries and
 * runFrom's defaults, which keeps this pure-testable without the fold machinery).
 *
 * @example withRichTextMigrated({slides: [{delta: {items: {a: {type: "text", text: "Hi", size: 20}}}}]}, (t) => t === "text").doc.slides[0].delta.items.a.text.runs[0].text // "Hi"
 * @example withRichTextMigrated({slides: [{delta: {items: {a: {type: "text", text: "Hi", size: 20}}}}]}, (t) => t === "text").migrated.length // 1
 */
export function withRichTextMigrated(doc, isTextType, inheritedStyleAt = null) {
  const migrated = richTextMigrations(doc, isTextType);
  if (migrated.length === 0) return { doc, migrated };
  const slides = doc.slides.map((s, slideIndex) => {
    const entries = migrated.filter((m) => m.slideIndex === slideIndex);
    if (entries.length === 0) return s;
    const items = { ...s.delta.items };
    for (const { id } of entries) {
      const item = items[id];
      // Inheritance: the same delta's own style keys, then the app-supplied
      // folded style (so a size keyframed on an EARLIER slide still applies),
      // then runFrom defaults. The delta's own keys win when both exist (the
      // value written on THIS slide is the most specific).
      const folded = inheritedStyleAt ? (inheritedStyleAt(id, slideIndex) ?? {}) : {};
      const inherited = {
        font: item.font ?? folded.font,
        size: item.size ?? folded.size,
        color: item.color ?? folded.color,
        bold: item.bold ?? folded.bold,
      };
      items[id] = { ...item, text: normalizeRichText(item.text, inherited) };
    }
    return { ...s, delta: { ...s.delta, items } };
  });
  return { doc: { ...doc, slides }, migrated };
}
