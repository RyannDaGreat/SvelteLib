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
 * TWEEN — `runs` and `paras` are ARRAYS, so the delta walker treats each as ONE
 * leaf (core/deltas.isTree) and hands it whole to core/interpolators.interpolate.
 * THAT IS NOT A DISCRETE SNAP, and this comment used to say it was (so did the
 * manifest; both were measured wrong, bare-node and live, in Round 6). interpolate
 * RECURSES into two arrays of EQUAL LENGTH and into two records with the SAME KEY
 * SET, so rich text interpolates PER RUN, PER KEY whenever the two keyframes agree
 * on the run count and on each run's key set: sizes 48/18 → 54/24 lands on 51/21 at
 * alpha 0.5, colors cross-fade per channel, and booleans/strings snap the way every
 * discrete leaf does. Only a STRUCTURAL change — a different run count, or a run
 * that gained/lost a style key — falls back to snapping to the target value.
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

/** The character-level style keys a run carries (paragraph style lives in paras).
 * OUTLINE and HIGHLIGHT (Round 13.4, the WYSIWYG-editing feature): a run may
 * carry a glyph OUTLINE (a stroke around the letter shapes — {color, width};
 * width 0 = off) and a HIGHLIGHT (a solid background color behind the run's
 * glyphs — the transparent sentinel "" / null = off). Both are per-run, editable
 * per-selection, and default OFF so old docs render byte-identically. */
export const RUN_STYLE_KEYS = ["bold", "italic", "underline", "strike", "size", "font", "color", "outlineColor", "outlineWidth", "highlight"];

/** The paragraph-level style keys a paragraph carries. */
export const PARA_STYLE_KEYS = ["align", "lineSpacing", "charSpacing", "wordSpacing"];

/** Default paragraph style. align ∈ left|center|right|justify; spacings are
 * multipliers/px offsets (lineSpacing × natural line height; char/wordSpacing
 * add device-independent px between chars/words). */
export const DEFAULT_PARA = { align: "left", lineSpacing: 1, charSpacing: 0, wordSpacing: 0 };

/** THE canonical font size a run falls back to when neither the run nor its
 * widget supplies one (runFrom's floor). It is EXPORTED because it was not, and
 * the cost was measured: twelve local re-declarations of the bare literal 36
 * across plugins, the two text-editing components, the built-in plugin library
 * and render_gpu/skia/text_layout.js — one of which documents itself as "mirrors
 * core/richtext DEFAULT_PARA_SIZE". That is the hand-maintained-mirror defect
 * class this codebase already names; an export is the whole cure. */
export const DEFAULT_PARA_SIZE = 36;

/** The smallest font size any size edit may produce. A run at 0 would be
 * invisible with no way back — repeated shrinking must asymptote at "tiny", not
 * at "gone" — so every size write goes through steppedSize, which floors here. */
export const MIN_RUN_SIZE = 1;

/** Font-size px per stepper press: the increment BOTH the floating toolbar's
 * +/- buttons and Cmd+Plus / Cmd+Minus apply (the PowerPoint default increment).
 * ONE declaration on purpose. It used to be declared twice — web/TextFormatToolbar
 * and web/TextEditController — and the pair beside it (the size a MIXED selection
 * counted from) had already drifted, so the same gesture on the same selection
 * produced 38 from the toolbar and 50 from the keyboard. */
export const SIZE_STEP = 2;

// ── vertical alignment (box-level; Round 15.6) ───────────────────────────────

/** The THREE canonical vertical-alignment values, in visual order. valign is a
 * BOX-level property (not per-paragraph, unlike the horizontal `align`): it
 * places the WHOLE laid-out line stack within the box height h. "top" (the
 * default) reproduces the historical behavior exactly (stack at y=0), so old
 * docs render byte-identically. ONE canonical form — the exact three strings;
 * anything else is rejected loudly at the layout entry (valignOffset), never
 * silently aliased (house rule: no tolerant aliasing). */
export const VALIGN_VALUES = ["top", "middle", "bottom"];
export const DEFAULT_VALIGN = "top";

/**
 * Pure function. The vertical offset (local px, y-down) to add to EVERY laid-out
 * line's y so the text stack sits top / middle / bottom within a box of height
 * boxH. contentH is the stack's total laid-out height (layoutRichText's `height`).
 * "top" → 0 (historical behavior; old docs unchanged). "middle" → centered slack.
 * "bottom" → all slack above. An unbounded box (boxH Infinity) or overflowing
 * content (contentH ≥ boxH) yields 0 — there is no room to push down, and text
 * grows DOWNWARD past h (the manifest OVERFLOW-vs-h rule: never clip, never push
 * content off the top). REJECTS a non-canonical valign LOUDLY (house rule: one
 * canonical form, no tolerant aliasing) so a typo can never silently fall back
 * to top.
 *
 * Args:
 *   valign (string): exactly "top" | "middle" | "bottom"
 *   boxH (number): box height in local units (Infinity ⇒ no vertical box)
 *   contentH (number): total laid-out text height (layoutRichText.height)
 *
 * Returns:
 *   number: local-px y offset to add to every line (≥ 0)
 *
 * @example valignOffset("top", 100, 40) // 0
 * @example valignOffset("middle", 100, 40) // 30 (slack 60, half above)
 * @example valignOffset("bottom", 100, 40) // 60 (all slack above)
 * @example valignOffset("middle", Infinity, 40) // 0 (no box to center in)
 * @example valignOffset("bottom", 30, 40) // 0 (content overflows — grows down, not up)
 */
export function valignOffset(valign, boxH, contentH) {
  if (!VALIGN_VALUES.includes(valign))
    throw new Error(`valignOffset: "valign" must be one of ${JSON.stringify(VALIGN_VALUES)}, got ${JSON.stringify(valign)}`);
  if (valign === "top" || boxH === Infinity) return 0;
  const slack = boxH - contentH;
  if (slack <= 0) return 0; // content taller than the box ⇒ no room (grows down)
  return valign === "middle" ? slack / 2 : slack; // "bottom" ⇒ all slack above
}

// ── the string→runs migration + normalization ────────────────────────────────

/**
 * Pure function. Canonicalizes any stored `text` value into a {runs, paras}
 * rich value. Accepts:
 *   - a bare STRING (legacy / plugin default) → ONE run inheriting the widget's
 *     own font/size/color/bold (the widget-level style keys), split into
 *     paragraphs by "\n" (a legacy string carries NO paragraph style, so each
 *     paragraph is an EMPTY override object);
 *   - an already-rich {runs, paras} → returned normalized (paras backfilled to
 *     the paragraph count with EMPTY override objects, runs coerced to carry
 *     `text` + full run style).
 * A migration is LOUD at the LOAD boundary via richTextMigrations (below); this
 * function itself is the pure normalizer both the migration and emit() use.
 *
 * ASYMMETRY, ON PURPOSE: `runs` come back FULLY RESOLVED (runFrom layers the
 * widget-level `inherited` style under each run) but `paras` come back carrying
 * ONLY WHAT WAS STORED. That is not an inconsistency — the two axes resolve at
 * DIFFERENT layers. Run style has no later layer: the renderer reads
 * `run.style.size` directly (render_gpu/skia/text_layout.textStyle), so the box
 * → run inheritance must be applied HERE or it is lost. Paragraph style DOES have
 * a later layer: paraStyleFor(paras, i, boxStyle) layers DEFAULT_PARA ‹ box ‹
 * paras[i] at layout time, and every consumer goes through it (layoutRichText,
 * skia/text_layout, TextFormatToolbar). Filling a default in HERE therefore
 * DESTROYS the box layer instead of supplying it.
 *
 * WHY THIS IS WRITTEN DOWN: it used to stamp `{...DEFAULT_PARA, ...stored}` into
 * every paragraph, which made all FOUR box-level paragraph Inspector rows
 * (align / lineSpacing / charSpacing / wordSpacing) unreachable for EVERY
 * document shape — paraStyleFor spreads the paragraph LAST, so a stamped default
 * always beat the box. Measured by byte-diffing renderDocToPng: changing the box
 * `align` from left to right moved zero pixels. The rule that prevents the
 * recurrence: a normalizer may resolve a layer only if no layer sits ABOVE it.
 *
 * `inherited` supplies the widget-level fallbacks a legacy string had no runs
 * to carry (so old docs render byte-identically: the single run inherits the
 * widget's font/size/color/bold verbatim).
 *
 * THIS IS THE READ SIDE ONLY. Its output must never be written back to the
 * document: resolved runs leave `inherited` nothing to supply, which is exactly
 * how the box-level typography rows get SHADOWED. The WRITE side is
 * unresolvedRichText (below) — same shape, style left alone.
 *
 * Args:
 *   value (string|object): stored text value
 *   inherited (object): {font, size, color, bold} widget-level fallbacks
 *
 * Returns:
 *   {runs, paras}: canonical rich value (runs carry text + full run style;
 *     paras carry only the stored per-paragraph overrides)
 *
 * @example normalizeRichText("Hi", {font: "inter", size: 20, color: "#000", bold: false}).runs.length // 1
 * @example normalizeRichText("Hi", {size: 20}).runs[0].text // "Hi"
 * @example normalizeRichText("a\nb", {}).paras.length // 2
 * @example normalizeRichText("a\nb", {}).paras[0] // {} (a legacy string set no paragraph style)
 * @example normalizeRichText({runs: [{text: "x"}], paras: []}, {}).paras.length // 1
 * @example normalizeRichText({runs: [{text: "a\nb"}], paras: [{align: "center"}]}, {}).paras[1] // {} (backfilled EMPTY, so the box row still reaches paragraph 2)
 */
export function normalizeRichText(value, inherited = {}) {
  if (typeof value === "string") {
    const paraCount = value.split("\n").length;
    return {
      runs: [runFrom({ text: value }, inherited)],
      paras: Array.from({ length: paraCount }, () => ({})),
    };
  }
  if (value && typeof value === "object" && Array.isArray(value.runs)) {
    const runs = value.runs.map((r) => runFrom(r, inherited));
    const text = runs.map((r) => r.text).join("");
    const paraCount = Math.max(1, text.split("\n").length);
    const paras = [];
    for (let i = 0; i < paraCount; i++) paras.push({ ...(value.paras?.[i] ?? {}) });
    return { runs, paras };
  }
  // Any other shape (null/number/etc.) → an empty single run (loud callers
  // report the migration; the render path must never throw on a weird value).
  return { runs: [runFrom({ text: "" }, inherited)], paras: [{}] };
}

/** Pure function. A canonical run from a partial run + widget-level inherited
 * style. text defaults to ""; run style keys fall back to `inherited` then to
 * sane defaults, so a legacy single run reproduces the old widget exactly.
 *
 * THE `??` CHAIN IS A LIVE FALLBACK, AND THAT MAKES IT SHADOWABLE. `r.X` wins
 * over `inherited.X` by design — per-run style is the FEATURE. But a caller that
 * STORES a fully-resolved run (every key materialized, even the ones the user
 * never touched) leaves nothing for `inherited` to supply, so the widget-level
 * font/size/bold/color Inspector rows go dead. That failure is SHADOWED, not
 * inert: this function is correct, its unit tests pass, and only the app's own
 * DEFAULT STATE reveals it (see plugins/text.js `defaults.text`, where the stamp
 * was removed). The invariant: only USER-SET run keys may be stored; resolution
 * happens per render, in emit().
 * outlineColor/outlineWidth/highlight (Round 13.4) default OFF (width 0, no
 * background) so a run from an OLD doc — which carries none of these keys —
 * renders byte-identically (no outline, no highlight). This IS the migration
 * for the new run properties: every run flows through runFrom (normalizeRichText
 * → runFrom), so an old rich value gains the off defaults with no separate
 * migration pass.
 *
 * @example runFrom({text: "x"}, {size: 20, color: "#111"}).size // 20
 * @example runFrom({text: "x", bold: true}, {}).bold // true
 * @example runFrom({text: "x"}, {}).italic // false
 * @example runFrom({text: "x"}, {}).outlineWidth // 0 (outline off by default)
 * @example runFrom({text: "x"}, {}).highlight // "" (no highlight by default)
 * @example runFrom({text: "x", outlineColor: "#f00", outlineWidth: 2}, {}).outlineWidth // 2
 */
export function runFrom(r, inherited = {}) {
  return {
    text: typeof r.text === "string" ? r.text : "",
    bold: r.bold ?? inherited.bold ?? false,
    italic: r.italic ?? inherited.italic ?? false,
    underline: r.underline ?? inherited.underline ?? false,
    strike: r.strike ?? inherited.strike ?? false,
    size: r.size ?? inherited.size ?? DEFAULT_PARA_SIZE,
    font: r.font ?? inherited.font ?? "system",
    color: r.color ?? inherited.color ?? "#000000",
    // Glyph outline: a stroke around the letter shapes. width 0 ⇒ off.
    outlineColor: r.outlineColor ?? inherited.outlineColor ?? "#000000",
    outlineWidth: r.outlineWidth ?? inherited.outlineWidth ?? 0,
    // Highlight: a solid background color behind the run's glyphs. "" ⇒ off
    // (the canonical "no highlight" sentinel — a plain-string leaf, never null,
    // so it snaps discretely like every run field and survives serialization).
    highlight: r.highlight ?? inherited.highlight ?? "",
  };
}

/**
 * Pure function. The STORABLE twin of normalizeRichText: canonicalizes the SHAPE
 * of a stored `text` value — a {runs, paras} object with one `paras` entry per
 * paragraph — WITHOUT RESOLVING STYLE. A run keeps ONLY the style keys it
 * actually carries; an absent key stays absent. Accepts exactly what
 * normalizeRichText accepts (a legacy string, a rich value, or junk).
 *
 * WHY BOTH EXIST — the two functions answer two different questions, and using
 * one for the other's job is the SHADOWING defect (see runFrom):
 *   normalizeRichText  → "what does this text LOOK LIKE?"  (resolved; layout,
 *                         emit(), and every toolbar read need real values)
 *   unresolvedRichText → "what may this text be WRITTEN BACK as?" (unresolved;
 *                         the in-place editor's model and every staged value)
 * The editor derives BOTH from the same stored value, edits the unresolved one,
 * and displays the resolved one. Feeding a resolved value into the write-back is
 * how ONE keystroke used to re-materialize all ten run keys and re-shadow the
 * four box-level typography rows (font/size/bold/color) that 437df12 had just
 * freed — measured: run keys ["text"] → eleven, and the four rows went
 * byte-identical under renderDocToPng again.
 *
 * IDENTITY THAT MAKES THE SPLIT SAFE (locked by richtext_test): for every value,
 *   normalizeRichText(unresolvedRichText(v), inherited)
 *     deep-equals normalizeRichText(v, inherited)
 * so routing the editor's display through the unresolved value changes NOTHING
 * about what is drawn. Resolution is not skipped, only deferred to the one layer
 * that owns it (emit()).
 *
 * Args:
 *   value (string|object): stored text value
 *
 * Returns:
 *   {runs, paras}: canonical SHAPE; runs carry `text` + only their own style
 *     keys, paras carry only the stored per-paragraph overrides
 *
 * @example unresolvedRichText({runs: [{text: "Text"}], paras: [{}]}).runs[0] // {text: "Text"} (set nothing, stores nothing)
 * @example unresolvedRichText({runs: [{text: "Hi", size: 76}], paras: [{}]}).runs[0] // {text: "Hi", size: 76} (authored size KEPT; the other nine keys stay absent)
 * @example unresolvedRichText({runs: [{text: "x", size: 36, bold: false}], paras: [{}]}).runs[0] // {text: "x", bold: false, size: 36} (an OLD stamped run keeps its stamp — no migration)
 * @example unresolvedRichText("a\nb").paras.length // 2 (a legacy string still splits into paragraphs)
 * @example unresolvedRichText("Hi").runs[0] // {text: "Hi"} (a legacy string carries no run style)
 * @example unresolvedRichText(null).runs[0] // {text: ""} (junk → one empty run, never throws)
 */
export function unresolvedRichText(value) {
  if (typeof value === "string") {
    return {
      runs: [{ text: value }],
      paras: Array.from({ length: value.split("\n").length }, () => ({})),
    };
  }
  if (value && typeof value === "object" && Array.isArray(value.runs)) {
    const runs = value.runs.map(bareRun);
    const paraCount = Math.max(1, runs.map((r) => r.text).join("").split("\n").length);
    const paras = [];
    for (let i = 0; i < paraCount; i++) paras.push({ ...(value.paras?.[i] ?? {}) });
    return { runs, paras };
  }
  return { runs: [{ text: "" }], paras: [{}] };
}

/** Pure function. A run reduced to `text` plus ONLY the RUN_STYLE_KEYS it
 * actually carries, in canonical key order. The exact complement of runFrom:
 * runFrom materializes every key, this one materializes none. A `null` style
 * value counts as ABSENT (runFrom's `??` treats it that way, so keeping it would
 * break the normalizeRichText∘unresolvedRichText identity). Unknown keys are
 * dropped, as runFrom drops them.
 *
 * @example bareRun({text: "x", bold: true}) // {text: "x", bold: true}
 * @example bareRun({text: "x", size: undefined, color: null}) // {text: "x"} (absent stays absent)
 * @example bareRun({}) // {text: ""}
 */
function bareRun(r) {
  const out = { text: typeof r.text === "string" ? r.text : "" };
  for (const k of RUN_STYLE_KEYS) if (r[k] !== undefined && r[k] !== null) out[k] = r[k];
  return out;
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

/**
 * Pure function. The half-open CHARACTER range [start, end) of each paragraph in
 * the concatenated run text (richTextToPlain), where paragraphs are separated by
 * "\n". The separator "\n" belongs to NO paragraph — paragraph i ends at the "\n"
 * and paragraph i+1 starts after it. Used to map a linear character selection
 * onto the paragraph indices it touches (applyParaStyle) — the paragraph twin of
 * the run-offset math applyRunStyle uses. Always returns at least one range (an
 * empty text ⇒ [{start:0,end:0}], a trailing "\n" ⇒ a trailing empty range) so
 * it agrees with splitParagraphs' paragraph count exactly.
 *
 * Args:
 *   runs (object[]): canonical runs (each carries text; "\n" splits paragraphs)
 *
 * Returns:
 *   {start, end}[]: one char range per paragraph, in order
 *
 * @example paragraphRanges([{text: "ab"}]) // [{start: 0, end: 2}]
 * @example paragraphRanges([{text: "ab\ncd"}]) // [{start: 0, end: 2}, {start: 3, end: 5}]
 * @example paragraphRanges([{text: "a\n"}]) // [{start: 0, end: 1}, {start: 2, end: 2}]
 * @example paragraphRanges([]) // [{start: 0, end: 0}]
 */
export function paragraphRanges(runs) {
  const text = (runs ?? []).map((r) => r.text ?? "").join("");
  const ranges = [];
  let start = 0;
  const chars = [...text];
  for (let i = 0; i <= chars.length; i++) {
    if (i === chars.length || chars[i] === "\n") {
      ranges.push({ start, end: i });
      start = i + 1; // the "\n" itself is the separator, owned by no paragraph
    }
  }
  return ranges;
}

/**
 * Pure function. Applies a paragraph-style delta (a partial paragraph-style
 * object, e.g. {align: "center"}) to EVERY paragraph the selection [start, end)
 * intersects, returning a NEW paras array (never mutates the input). This is the
 * paragraph twin of applyRunStyle — but paragraphs do NOT split/merge (a "\n" is
 * the only paragraph boundary and it lives in the run text, not in paras), so
 * this is a straight per-entry overlay: touched entries get {...entry, ...delta}.
 *
 * A paragraph is "touched" iff its character range overlaps [lo, hi), OR the
 * selection is an empty caret (lo === hi) sitting inside/at the paragraph (a
 * caret with no characters still selects its containing paragraph — aligning a
 * paragraph with the cursor merely placed in it is the universal editor
 * convention, unlike a character-style caret which is a no-op). The `paras`
 * array is normalized to `paraCount` entries first (backfilling DEFAULT_PARA)
 * so an under-populated paras (a run edit added a "\n" before paras caught up)
 * still receives the override on the right index.
 *
 * Args:
 *   paras (object[]): current paragraph styles (may be shorter than paraCount)
 *   runs (object[]): canonical runs (define the paragraph ranges via "\n")
 *   start (number): selection start char offset
 *   end (number): selection end char offset
 *   styleDelta (object): partial paragraph style to overlay (e.g. {align:"right"})
 *
 * Returns:
 *   object[]: new paras array (one entry per paragraph; touched ones carry delta)
 *
 * @example applyParaStyle([{}], [{text: "ab"}], 0, 2, {align: "center"})[0].align // "center"
 * @example applyParaStyle([{}, {}], [{text: "ab\ncd"}], 0, 2, {align: "right"})[1].align // undefined (2nd para untouched — raw entry, no default applied)
 * @example applyParaStyle([{}, {}], [{text: "ab\ncd"}], 1, 4, {align: "right"})[1].align // "right" (selection spans both)
 * @example applyParaStyle([{}, {}], [{text: "ab\ncd"}], 4, 4, {align: "center"})[1].align // "center" (empty caret in para 2)
 * @example applyParaStyle([{}, {}], [{text: "ab\ncd"}], 4, 4, {align: "center"})[0].align // undefined (para 1 untouched by the caret)
 */
export function applyParaStyle(paras, runs, start, end, styleDelta) {
  const ranges = paragraphRanges(runs);
  const paraCount = ranges.length;
  const lo = Math.min(start, end);
  const hi = Math.max(start, end);
  const out = [];
  for (let i = 0; i < paraCount; i++) {
    const base = paras?.[i] ?? paras?.[0] ?? {};
    const { start: ps, end: pe } = ranges[i];
    // Overlap for a non-empty selection: [lo,hi) ∩ [ps,pe] nonempty (pe inclusive
    // so a paragraph selected exactly up to its end "\n" still counts). Empty
    // caret: it sits in paragraph i iff ps ≤ lo ≤ pe.
    const touched = lo === hi ? (lo >= ps && lo <= pe) : (lo <= pe && hi > ps);
    out.push(touched ? { ...base, ...styleDelta } : { ...base });
  }
  return out;
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

// ── does a BOX-LEVEL Inspector row still reach anything? ─────────────────────
// A text widget's font / size / bold / color rows underlie every RUN and its
// align / lineSpacing / charSpacing / wordSpacing rows underlie every PARAGRAPH
// (runFrom and paraStyleFor respectively). Both layerings put the stored element
// value FIRST — that is the per-run/per-paragraph feature — so a value in which
// EVERY element stores the key leaves the box row nothing to supply. The row is
// then not merely inert: it keeps displaying the box's value while the canvas
// draws the runs' (projects/"Untitled cheese" shows 36 / system / #1a1a2e in the
// box while the glyphs render 76 / futura / #000000). A row that CONTRADICTS the
// canvas is worse than an absent one, so it hides — the same answer, and the same
// mechanism (`visibleWhen`), as the user's own ruling on stroke width under an
// OFF stroke material (core/properties.js strokeMaterialIsOn).

/**
 * Pure function. Builds the `visibleWhen(state)` predicate for a text widget's
 * BOX-LEVEL row of style key `key` — true while at least one run (for a
 * RUN_STYLE_KEYS key) or one paragraph (for a PARA_STYLE_KEYS key) still leaves
 * that key for the box to supply.
 *
 * The key decides which axis is consulted, and an unknown key THROWS rather than
 * defaulting to either one: a typo would otherwise produce a row that hides for a
 * reason nobody can name, which is exactly the class of defect this is fixing.
 *
 * Args:
 *   key (string): a RUN_STYLE_KEYS or PARA_STYLE_KEYS name
 *
 * Returns:
 *   fn: (state) → boolean, reading only `state.text`
 *
 * @example boxStyleRowVisibility("size")({text: {runs: [{text: "a"}], paras: [{}]}}) // true (a bare run inherits it)
 * @example boxStyleRowVisibility("size")({text: {runs: [{text: "a", size: 76}], paras: [{}]}}) // false (the only run overrides it)
 * @example boxStyleRowVisibility("size")({text: {runs: [{text: "a", size: 76}, {text: "b"}], paras: [{}]}}) // true (the second run still inherits)
 * @example boxStyleRowVisibility("align")({text: {runs: [{text: "a"}], paras: [{align: "center"}]}}) // false (the only paragraph overrides it)
 * @example boxStyleRowVisibility("align")({text: {runs: [{text: "a"}], paras: [{}]}}) // true
 * @example boxStyleRowVisibility("size")({}) // true (no rich value yet ⇒ nothing overrides anything)
 */
export function boxStyleRowVisibility(key) {
  const perRun = RUN_STYLE_KEYS.includes(key);
  if (!perRun && !PARA_STYLE_KEYS.includes(key))
    throw new Error(`boxStyleRowVisibility: "${key}" is neither a run style key (${RUN_STYLE_KEYS.join(", ")}) nor a paragraph style key (${PARA_STYLE_KEYS.join(", ")})`);
  return (state) => {
    const value = unresolvedRichText(state?.text);
    const elements = perRun ? value.runs : value.paras;
    return elements.some((e) => e[key] === undefined);
  };
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
 * VERTICAL ALIGNMENT (Round 15.6): boxStyle.valign ∈ top|middle|bottom (default
 * top) places the WHOLE line stack within the box height boxH — the entire
 * layout (every line, decoration, highlight) is shifted DOWN by valignOffset()
 * as a final pass. "top" is a no-op (offset 0), so old docs render byte-
 * identically. Because ALL THREE backends consume this positioned output
 * (richTextDraws), the vertical offset is inherited by GPU/PDF/SVG with zero
 * backend changes — the parity lever, extended vertically.
 *
 * Args:
 *   rich (object): canonical {runs, paras} (run normalizeRichText first)
 *   boxW (number): wrap width in local units; Infinity ⇒ no wrap
 *   measureRun (fn): (text, style) → {width, ascent, descent}
 *   boxStyle (object): widget-level paragraph defaults (align/lineSpacing/
 *     charSpacing/wordSpacing set on the text item — the SET-1 one-alignment-
 *     per-box control); underlies each paragraph's own paras[i] overrides.
 *     boxStyle.valign (box-level) drives the vertical placement (see above).
 *   boxH (number): box height in local units for vertical alignment; Infinity
 *     ⇒ no vertical box (valign is a no-op). Only "middle"/"bottom" read it.
 *
 * Returns:
 *   {
 *     lines: [{ y, baseline, height, width, glyphRuns: [{ x, text, style }] }],
 *     highlights: [{ x, y, w, h, color }],  // background rects BEHIND runs (Round 13.4)
 *     decorations: [{ kind: "underline"|"strike", x, y, w, thickness, color }],
 *     width, height   // total laid-out extent (may exceed boxW for overlong words / h for overflow)
 *   }
 * All coordinates local, y-down; glyphRun.x is the pen origin, .y is the LINE's
 * top (a backend advances the pen and top-anchors each glyph like the existing
 * text op). baseline is the line-top→baseline offset. A highlight rect spans its
 * piece's advance width × the line's content box (ascent+descent, at the line
 * top) so it sits directly behind the glyphs — a backend draws it FIRST.
 *
 * @example layoutRichText({runs: [{text: "ab", size: 10, color: "#000"}], paras: [{align: "left"}]}, Infinity, monoMeasure).lines.length // 1
 * @example layoutRichText({runs: [{text: "a\nb", size: 10, color: "#000"}], paras: [{}, {}]}, Infinity, monoMeasure).lines.length // 2
 * @example layoutRichText({runs: [], paras: []}, 100, monoMeasure).lines.length // 1
 * @example layoutRichText({runs: [{text: "a", size: 10, color: "#000"}], paras: [{}]}, Infinity, monoMeasure, {valign: "bottom"}, 100).lines[0].y // 90 (10-tall line pushed to the box bottom of 100)
 */
export function layoutRichText(rich, boxW, measureRun, boxStyle = {}, boxH = Infinity) {
  const { runs, paras } = rich;
  const paragraphs = splitParagraphs(runs);
  const lines = [];
  const highlights = [];
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
        // Highlight rect (background) spans this piece's advance width × the
        // line's content box (ascent+descent at the line top) — a solid color
        // behind the glyphs. Emitted first so a backend paints it under the run.
        addHighlight(highlights, p, pen, y, halfLeading, ascent, descent);
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

  // VERTICAL ALIGNMENT (Round 15.6): shift the WHOLE laid-out stack down so it
  // sits top/middle/bottom within boxH. `y` is now the total content height.
  // Applied as one final pass over lines/decorations/highlights so every
  // coordinate the backends consume already carries the offset (they never
  // re-derive a y-origin — the parity lever, inherited by GPU/PDF/SVG).
  const vOffset = valignOffset(boxStyle.valign ?? DEFAULT_VALIGN, boxH, y);
  if (vOffset !== 0) {
    for (const line of lines) line.y += vOffset;
    for (const d of decorations) d.y += vOffset;
    for (const h of highlights) h.y += vOffset;
  }

  return { lines, highlights, decorations, width: maxWidth, height: y };
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
  // boxH (Round 15.6) flows into the layout for VERTICAL alignment (valign lives
  // in cmd.boxStyle). The IR text() op carries boxH; a hand-built cmd without it
  // ⇒ Infinity (no vertical box ⇒ valign is a no-op, top-anchored as before).
  const layout = layoutRichText(cmd.rich, cmd.boxW ?? Infinity, measureRun, cmd.boxStyle ?? {}, cmd.boxH ?? Infinity);
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
        // Glyph OUTLINE (Round 13.4): a run with outlineWidth > 0 strokes its
        // letters (outlineColor). Carried per-draw so each backend renders it in
        // its own way (GPU atlas strokeText, PDF Tr 2, SVG stroke+paint-order).
        outlineColor: st.outlineColor ?? "#000000",
        outlineWidth: st.outlineWidth ?? 0,
        opacity,
      });
    }
  }
  // HIGHLIGHT background rects (Round 13.4) — op-relative, drawn BEHIND glyphs.
  const highlights = layout.highlights.map((h) => ({
    x: ox + h.x, y: oy + h.y, w: h.w, h: h.h, color: h.color, opacity,
  }));
  const lines = layout.decorations.map((d) => ({
    x: ox + d.x, y: oy + d.y, w: d.w, thickness: d.thickness, color: d.color, opacity,
  }));
  return { textDraws, highlights, lines, width: layout.width, height: layout.height };
}

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

/** Command (pushes into `out`). Appends a HIGHLIGHT background rect for a
 * positioned piece whose run has a highlight color (Round 13.4). The rect spans
 * the piece's advance width × the line's CONTENT box (ascent+descent), placed at
 * the line's content top (lineY + halfLeading) so it sits directly behind the
 * glyphs of ANY size on the line. No highlight ("" sentinel) → nothing pushed.
 *
 * x = piece pen origin, lineY = line top, halfLeading = the extra line-gap split
 * above the content, ascent/descent = the LINE's metrics (so a small run's
 * highlight still fills the line's height — matches how the browser paints a
 * highlight over the line box, not just the glyph ink). */
function addHighlight(out, piece, x, lineY, halfLeading, ascent, descent) {
  const bg = piece.style.highlight;
  if (typeof bg !== "string" || bg.length === 0) return; // "" ⇒ off
  out.push({ x, y: lineY + halfLeading, w: piece.width, h: ascent + descent, color: bg });
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

// ── INK BOUNDS (the laid-out extent, which is NOT the property box) ───────────

/**
 * Pure function. The LOCAL rect a laid-out text stack's INK actually occupies,
 * given the box it was laid out in — THE BOUNDS protocol's answer for a text
 * widget (core/view.js localBoundsOf), computed from the SAME layout that
 * positions the glyphs, so the rect can never describe a different stack than
 * the one drawn.
 *
 * ── WHY IT IS NOT THE BOX (the defect this exists to fix) ─────────────────────
 * Text OVERFLOWS. `valignOffset` documents the rule the layout already obeys —
 * content taller than boxH "grows DOWNWARD past h … never clip" — so a two-line
 * caption in a one-line box has ink below its box, and a single unbreakable word
 * has ink past its right edge (wrapParagraph places an overlong word on its own
 * line "and allowed to overflow"). Reporting the box as the bounds is therefore
 * wrong in exactly the two directions users hit first, and the consequences were
 * all four BOUNDS consumers at once: overflowing type got CULLED when its box
 * left the view, could not be caught by a band, was cropped out of an export
 * capture rect, and — the report that prompted this — could not be CLICKED.
 *
 * ── WHAT EACH EDGE IS, AND WHY ───────────────────────────────────────────────
 * Mirrors render_gpu/skia/paint_skia.textOpLocalBounds (the Skia painter's
 * effect-substrate rect) edge for edge, because two rects claiming to bound the
 * same ink must agree:
 *   · LEFT/WIDTH — the wrap box when finite, OR the widest laid-out line,
 *     whichever is wider. NEITHER ALONE IS SAFE: a fixed box is overrun by an
 *     unbreakable word (so the laid-out width matters), and a right- or
 *     centre-aligned line is positioned against the box edge (so the box
 *     matters). x stays 0 — alignment never moves ink left of the box origin.
 *   · TOP/HEIGHT — from the vertical-align offset down to the stack bottom. The
 *     offset is 0 or positive here (valignOffset clamps overflow to 0), so the
 *     top is 0 and the height is offset + laid-out height, which EXCEEDS boxH
 *     exactly when the text overflows. boxH is deliberately not a floor: an
 *     empty box's ink is small, and claiming otherwise would defeat culling.
 *
 * NO PAD. The painter's rect adds an em of headroom because a raster substrate
 * that clips ink is a visible artifact; this rect is a GEOMETRIC claim that hit
 * testing, band select and "Set size to ink bounds" consume, and padding it would
 * make the fitted box visibly loose around the type.
 *
 * Args:
 *   rich (object): canonical {runs, paras} (normalizeRichText first)
 *   boxW (number): the wrap width the widget lays out at; Infinity ⇒ no wrap
 *   measureRun (fn): (text, style) → {width, ascent, descent} — core/ink_metrics.inkMeasure()
 *   boxStyle (object): the widget's align/valign (and any paragraph defaults)
 *   boxH (number): the box height valign places the stack within; Infinity ⇒ none
 *
 * Returns:
 *   {x, y, w, h}: local-unit ink rect, top-left origin, y-down
 *
 * @example // one 10-tall line of "ab" (monoMeasure: 20 wide) in a 100x100 box: the box wins on width, the line on height
 * @example textInkBounds({runs: [{text: "ab", size: 10, color: "#000"}], paras: [{}]}, 100, monoMeasure, {}, 100) // {x: 0, y: 0, w: 100, h: 10}
 * @example // THE OVERFLOW CASE: two lines (20 tall) in a 5-tall box — the ink is 20 tall, four times the box
 * @example textInkBounds({runs: [{text: "a\nb", size: 10, color: "#000"}], paras: [{}, {}]}, 100, monoMeasure, {}, 5) // {x: 0, y: 0, w: 100, h: 20}
 * @example // AN UNBREAKABLE WORD overruns a narrow box: "aaaa" measures 40 wide against a box of 15
 * @example textInkBounds({runs: [{text: "aaaa", size: 10, color: "#000"}], paras: [{}]}, 15, monoMeasure, {}, 100) // {x: 0, y: 0, w: 40, h: 10}
 * @example // valign pushes the stack down, and the ink rect follows it rather than starting at the box top
 * @example textInkBounds({runs: [{text: "a", size: 10, color: "#000"}], paras: [{}]}, 100, monoMeasure, {valign: "bottom"}, 100) // {x: 0, y: 0, w: 100, h: 100}
 */
export function textInkBounds(rich, boxW, measureRun, boxStyle = {}, boxH = Infinity) {
  const layout = layoutRichText(rich, boxW, measureRun, boxStyle, boxH);
  const vOffset = valignOffset(boxStyle.valign ?? DEFAULT_VALIGN, boxH, layout.height);
  return {
    x: 0,
    y: 0,
    w: Math.max(Number.isFinite(boxW) ? boxW : 0, layout.width),
    h: vOffset + layout.height,
  };
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

// ── run editing: split / merge / per-selection style (SET-2 UX substrate) ──────
// The floating PPT toolbar + Ctrl+B/I/U operate on a linear CHARACTER SELECTION
// [start, end). These PURE helpers split runs at the selection boundaries, apply
// a style delta to the covered runs, then MERGE adjacent runs whose style became
// identical — so the stored run list stays in CANONICAL form (no redundant
// splits persist; a bold-then-unbold round-trips to one run). All offsets are in
// characters over the concatenated run text (richTextToPlain), "\n" included.

/** Pure function. Total character length of a run list (concatenated text).
 *
 * @example runsLength([{text: "ab"}, {text: "cde"}]) // 5
 * @example runsLength([]) // 0
 */
export function runsLength(runs) {
  let n = 0;
  for (const r of runs) n += [...(r.text ?? "")].length;
  return n;
}

/** Pure function. The style object of a run (everything except `text`). Compared
 * by canonicalStyleKey to decide run merging.
 *
 * @example styleOf({text: "x", bold: true, size: 10}) // {bold: true, size: 10}
 */
export function styleOf(run) {
  const { text, ...style } = run;
  return style;
}

/** Pure function. Do two runs carry IDENTICAL style (mergeable)? Compares every
 * RUN_STYLE_KEY (order-independent), so two runs differing only in text can be
 * concatenated into one.
 *
 * `inherited` is the WIDGET-LEVEL style an absent run key resolves to (the box's
 * font/size/bold/color rows — emit()'s `inherited`). It MUST be supplied whenever
 * the runs may be UNRESOLVED, because "mergeable" means "renders identically",
 * and what an absent key renders as is decided by that layer. Omitting it
 * compares against runFrom's hardcoded defaults instead, which silently DESTROYS
 * authored style: in a box with `bold: true`, an explicit {bold:false} on a word
 * resolved to false, an ABSENT bold also resolved to false, the two runs merged,
 * and the un-bold vanished with no pixel change (measured through
 * renderDocToPng). Same for an explicit size 36 / color #000000 / font "system"
 * under a box that says otherwise. It defaults to {} only so the many
 * already-resolved callers (where every key is present and the box layer cannot
 * matter) read unchanged.
 *
 * @example sameStyle({text: "a", bold: true}, {text: "b", bold: true}) // true
 * @example sameStyle({text: "a", bold: true}, {text: "b", bold: false}) // false
 * @example sameStyle({text: "a"}, {text: "b", bold: false}) // true (absent = the default false ⇒ a bold-then-unbold round-trips to ONE run)
 * @example sameStyle({text: "a"}, {text: "b", bold: false}, {bold: true}) // false (in a BOLD box, absent means bold — the un-bold is real style)
 * @example sameStyle({text: "a"}, {text: "b", size: 36}, {size: 60}) // false (absent means the box's 60, not the hardcoded 36)
 */
export function sameStyle(a, b, inherited = {}) {
  // Compare DEFAULTED values (via runFrom) so an ABSENT key and its EXPLICIT
  // DEFAULT are equal for merging: {bold:false} and {} both mean "not bold", so
  // unbolding a bolded range round-trips to ONE canonical run (not two — the
  // stored form must not depend on whether a default was written explicitly).
  // "The default" is `inherited` FIRST (the box row), then runFrom's own floor.
  const na = runFrom({ text: "", ...a }, inherited), nb = runFrom({ text: "", ...b }, inherited);
  for (const k of RUN_STYLE_KEYS) if (na[k] !== nb[k]) return false;
  return true;
}

/**
 * Pure function. Canonicalizes a run list: drops empty-text runs (unless it is
 * the ONLY run — an empty box keeps one empty run so the cursor has a style to
 * inherit) and merges ADJACENT runs of identical style into one. The result
 * renders and stores identically but has no redundant partitions — the canonical
 * form every edit produces.
 *
 * EMPTIED-OUT LIST → a BARE empty run, never a resolved one. deleteRange over the
 * whole text leaves NO runs at all, so this branch is on the most ordinary editing
 * path there is: select all, delete, retype. It used to seed `runFrom({text: ""})`
 * with no `inherited`, i.e. every key at the HARDCODED floor — so retyping in a
 * size-60 lora box produced size 36 system, VISIBLY shrinking and re-facing the
 * text the user had just styled. Seeding `{text: ""}` instead leaves all ten keys
 * for the box rows to supply, which is what the cursor should inherit.
 *
 * `inherited` = the widget-level style an absent run key resolves to; forwarded
 * verbatim to sameStyle, which is where it decides mergeability (see there for
 * the authored-style loss it prevents).
 *
 * @example mergeAdjacentRuns([{text: "a", bold: true}, {text: "b", bold: true}]).length // 1
 * @example mergeAdjacentRuns([{text: "a", bold: true}, {text: "b", bold: true}])[0].text // "ab"
 * @example mergeAdjacentRuns([{text: "a", bold: true}, {text: "b", bold: false}]).length // 2
 * @example mergeAdjacentRuns([{text: "a"}, {text: "b", bold: false}], {bold: true}).length // 2 (a BOLD box makes the un-bold real — no merge)
 * @example mergeAdjacentRuns([{text: ""}, {text: "x"}]).length // 1 (empty dropped)
 * @example mergeAdjacentRuns([{text: ""}]).length // 1 (lone empty kept)
 */
export function mergeAdjacentRuns(runs, inherited = {}) {
  const nonEmpty = runs.filter((r) => (r.text ?? "").length > 0);
  if (nonEmpty.length === 0) return [runs[0] ? { ...runs[0] } : { text: "" }];
  const out = [];
  for (const r of nonEmpty) {
    const last = out[out.length - 1];
    if (last && sameStyle(styleOf(last), styleOf(r), inherited)) last.text += r.text;
    else out.push({ ...r });
  }
  return out;
}

/**
 * Pure function. Splits the run list so that a run boundary falls EXACTLY at
 * character `offset` (0 ≤ offset ≤ length). A run straddling the offset is cut
 * into two runs of the same style; offsets at existing boundaries are no-ops.
 * Returns the new run list (never mutates the input). Style is preserved on both
 * halves — the cut is purely positional.
 *
 * @example splitRunAt([{text: "abcd", bold: true}], 2).length // 2
 * @example splitRunAt([{text: "abcd", bold: true}], 2)[0].text // "ab"
 * @example splitRunAt([{text: "abcd", bold: true}], 2)[1].text // "cd"
 * @example splitRunAt([{text: "abcd"}], 0).length // 1 (boundary already there)
 * @example splitRunAt([{text: "abcd"}], 4).length // 1 (end boundary)
 */
export function splitRunAt(runs, offset) {
  const out = [];
  let pos = 0;
  for (const r of runs) {
    const chars = [...(r.text ?? "")];
    const len = chars.length;
    if (offset > pos && offset < pos + len) {
      const cut = offset - pos;
      out.push({ ...r, text: chars.slice(0, cut).join("") });
      out.push({ ...r, text: chars.slice(cut).join("") });
    } else {
      out.push({ ...r });
    }
    pos += len;
  }
  return out;
}

/**
 * Pure function. Applies a style delta (a partial run-style object, e.g.
 * {bold: true} or {color: "#f00", highlight: "#ff0"}) to every character in the
 * selection [start, end), splitting runs at the two boundaries first and merging
 * the result back to canonical form. start === end (empty selection) is a no-op
 * (returns the input canonicalized) — a caret has no characters to style; the
 * editor handles caret-style as a pending style, not a run edit. Clamped to the
 * valid range. Never mutates the input.
 *
 * This is THE toolbar/shortcut primitive: bold/italic/underline/strike toggles,
 * per-selection color, outline, highlight, size, and font ALL route through it
 * with the appropriate delta.
 *
 * `inherited` = the widget-level style an absent run key resolves to; forwarded
 * to the canonicalizing merge so a delta that matches runFrom's hardcoded floor
 * but NOT the box row survives (see sameStyle).
 *
 * @example applyRunStyle([{text: "abcd"}], 1, 3, {bold: true}).length // 3
 * @example applyRunStyle([{text: "abcd"}], 1, 3, {bold: true})[1].text // "bc"
 * @example applyRunStyle([{text: "abcd"}], 1, 3, {bold: true})[1].bold // true
 * @example applyRunStyle([{text: "abcd", bold: true}], 0, 4, {bold: false}).length // 1 (whole-range unbold → one run)
 * @example applyRunStyle([{text: "abcd"}], 2, 2, {bold: true}).length // 1 (empty selection no-op)
 * @example applyRunStyle([{text: "abcd"}], 0, 2, {bold: false}, {bold: true}).length // 2 (un-bold half of a BOLD box: kept, not merged away)
 */
export function applyRunStyle(runs, start, end, styleDelta, inherited = {}) {
  return overCoveredRuns(runs, start, end, () => styleDelta, inherited);
}

/**
 * Pure function. Steps the FONT SIZE of every character in [start, end) BY
 * `delta`, so a MIXED selection keeps its relative differences: 48+18 stepped by
 * +2 becomes 50+20, not one flattened run. Otherwise identical to applyRunStyle —
 * runs split at the boundaries, only fully-covered runs change, the result
 * re-merges to canonical form, the input is never mutated, and an empty selection
 * is a no-op (the caret's pending style is the editor's job, not a run edit).
 *
 * READS RESOLVED, WRITES EXPLICIT, and that asymmetry is deliberate. The step must
 * start from what the user SEES, so each covered run's current size comes from
 * runFrom (run key ‹ widget `inherited` ‹ DEFAULT_PARA_SIZE); the result is then
 * STORED on the run, which shadows the box-level Size row for that run from then
 * on. Storing a resolved value is normally the SHADOWING defect (see runFrom), but
 * pressing a size stepper IS the user choosing a size, and only the runs the
 * selection covers are stamped — so the box row keeps supplying every run the
 * gesture did not touch.
 *
 * WHY THIS EXISTS AS ITS OWN PRIMITIVE rather than a {size: n} delta: an absolute
 * delta cannot express "shift each run by 2". The floating toolbar used to build
 * one from the selection's COMMON size, which is `undefined` on a mixed selection,
 * so it fell back to a constant — flattening 48+18 to a single run at 38 while the
 * keyboard path, computing its fallback differently, produced a single run at 50.
 * Both entry points now call this.
 *
 * Args:
 *   runs (object[]): current runs (resolved or unresolved)
 *   start (number): selection start char offset
 *   end (number): selection end char offset
 *   delta (number): px to add to every covered run's size (negative to shrink)
 *   inherited (object): widget-level style an absent run key resolves to
 *
 * Returns:
 *   object[]: new runs, canonicalized
 *
 * @example adjustRunSize([{text: "Big ", size: 48}, {text: "small", size: 18}], 0, 9, 2).map((r) => r.size) // [50, 20]
 * @example adjustRunSize([{text: "Big ", size: 48}, {text: "small", size: 18}], 0, 9, 2).length // 2 (the boundary SURVIVES — the whole point)
 * @example adjustRunSize([{text: "abcd"}], 0, 4, 2, {size: 60}).map((r) => r.size) // [62] (an absent size resolves through the BOX row first)
 * @example adjustRunSize([{text: "abcd"}], 0, 4, 2).map((r) => r.size) // [38] (…then through DEFAULT_PARA_SIZE)
 * @example adjustRunSize([{text: "ab", size: 10}, {text: "cd", size: 10}], 0, 4, 2).length // 1 (equal sizes still merge — canonical form)
 * @example adjustRunSize([{text: "abcd", size: 2}], 0, 4, -99).map((r) => r.size) // [1] (floored at MIN_RUN_SIZE, never 0)
 * @example adjustRunSize([{text: "abcd", size: 20}], 1, 3, 5).map((r) => r.size) // [20, 25, 20] (only the covered characters move)
 * @example adjustRunSize([{text: "abcd", size: 20}], 2, 2, 5).map((r) => r.size) // [20] (empty selection is a no-op)
 */
export function adjustRunSize(runs, start, end, delta, inherited = {}) {
  return overCoveredRuns(
    runs, start, end,
    (run) => ({ size: steppedSize(runFrom(run, inherited).size, delta) }),
    inherited
  );
}

/**
 * Pure function. A font size moved by `delta` and floored at MIN_RUN_SIZE — the
 * ONE place a size step decides what "smaller" bottoms out at, shared by
 * adjustRunSize (a selection) and the editor's caret path (the pending style for
 * text not yet typed), so the two can never disagree about the floor.
 *
 * @example steppedSize(36, 2) // 38
 * @example steppedSize(36, -2) // 34
 * @example steppedSize(2, -10) // 1 (floored, never 0 or negative)
 */
export function steppedSize(size, delta) {
  return Math.max(MIN_RUN_SIZE, size + delta);
}

/**
 * Pure function. MULTIPLIES the font size of every character in [start, end) by
 * `factor`, so a MIXED selection keeps its PROPORTIONS: 48+18 scaled by 1.5
 * becomes 72+27, whose ratio is still 8:3. The third of the three size verbs,
 * beside adjustRunSize (ADDITIVE) and applyRunStyle's {size: n} (ABSOLUTE) — see
 * the trio's contract in the SIZE VERBS note below.
 *
 * WHY A SEPARATE VERB AND NOT A DELTA (user ruling, 2026-08-02): "if I drag it up
 * and down, it should make them all bigger or smaller, maintaining the myriad of
 * different sizes I may have selected … it should do so proportionally when I'm
 * using the slider, as opposed to the pluses and minuses. The reason why is
 * because I want to keep the relative proportions of the different font sizes the
 * same when I use the slider, and increment or decrement when I use the increment
 * or decrement buttons." An additive shift does NOT preserve proportions (48+18
 * +2 → 50/20, ratio 5:2 ≠ 8:3), so the contrast the user asked for cannot be
 * expressed by reusing adjustRunSize with a computed delta.
 *
 * Reads resolved and writes explicit exactly as adjustRunSize does, floors at
 * MIN_RUN_SIZE through the same steppedSize, and rounds to whole px — a font size
 * is authored in whole px everywhere else in this editor (SIZE_STEP is 2, the
 * scrubber's grid is 1), and an unrounded scale would leave 48 × 1.01 = 48.48 in
 * the document where the readout says 48.
 *
 * A NON-POSITIVE OR NON-FINITE factor is REFUSED LOUDLY rather than clamped:
 * factor ≤ 0 means the caller's ratio arithmetic divided by a zero or a negative
 * size, and silently substituting 1 would make a broken drag look like a
 * successful no-op.
 *
 * Args:
 *   runs (object[]): current runs (resolved or unresolved)
 *   start (number): selection start char offset
 *   end (number): selection end char offset
 *   factor (number): multiplier applied to every covered run's size (must be > 0)
 *   inherited (object): widget-level style an absent run key resolves to
 *
 * Returns:
 *   object[]: new runs, canonicalized
 *
 * @example scaleRunSize([{text: "Big ", size: 48}, {text: "small", size: 18}], 0, 9, 1.5).map((r) => r.size) // [72, 27] (ratio 8:3 preserved)
 * @example scaleRunSize([{text: "Big ", size: 48}, {text: "small", size: 18}], 0, 9, 1.5).length // 2 (the boundary SURVIVES)
 * @example scaleRunSize([{text: "abcd"}], 0, 4, 2, {size: 30}).map((r) => r.size) // [60] (an absent size resolves through the BOX row first)
 * @example scaleRunSize([{text: "abcd", size: 48}], 0, 4, 1.01).map((r) => r.size) // [48] (rounded to whole px)
 * @example scaleRunSize([{text: "abcd", size: 4}], 0, 4, 0.01).map((r) => r.size) // [1] (floored at MIN_RUN_SIZE)
 * @example scaleRunSize([{text: "abcd", size: 20}], 2, 2, 2).map((r) => r.size) // [20] (empty selection is a no-op)
 */
export function scaleRunSize(runs, start, end, factor, inherited = {}) {
  if (!Number.isFinite(factor) || factor <= 0) {
    throw new Error(`scaleRunSize: factor must be a positive finite number, got ${factor}`);
  }
  return overCoveredRuns(
    runs, start, end,
    (run) => ({ size: scaledSize(runFrom(run, inherited).size, factor) }),
    inherited
  );
}

/**
 * Pure function. A font size MULTIPLIED by `factor`, rounded to whole px and
 * floored at MIN_RUN_SIZE — the multiplicative sibling of steppedSize, and the
 * ONE place the proportional verb decides its rounding and its floor.
 *
 * @example scaledSize(48, 1.5) // 72
 * @example scaledSize(18, 1.5) // 27
 * @example scaledSize(48, 1.01) // 48 (rounded — sizes stay whole px)
 * @example scaledSize(4, 0.01) // 1 (floored, never 0 or negative)
 */
export function scaledSize(size, factor) {
  return Math.max(MIN_RUN_SIZE, Math.round(size * factor));
}

// ── THE THREE SIZE VERBS (user ruling, 2026-08-02 — see scaleRunSize) ────────
// A font-size control acting on a MIXED selection has three honestly different
// answers, and this codebase names all three rather than picking one:
//   ABSOLUTE   applyRunStyle(runs, s, e, {size: n})  every covered run becomes n
//              (NORMALIZE — what a TYPED number means: the user named a size)
//   ADDITIVE   adjustRunSize(runs, s, e, delta)      every run shifts by delta
//              (what the +/- STEPPERS mean; proportions deliberately NOT kept)
//   PROPORTIONAL scaleRunSize(runs, s, e, factor)    every run × factor
//              (what a DRAG means; proportions exactly kept)
// The verbs are separate primitives because no one of them can express another
// on a mixed selection: an absolute write flattens the run boundary, an additive
// shift changes every ratio, and a scale cannot reach an exact typed number.
// web/TextEditController.svelte owns the ONE mapping from gesture to verb.

/**
 * Pure helper. The shared spine of every per-selection run edit: split the run
 * list at both selection boundaries, overlay `deltaFor(run)` onto each FULLY
 * COVERED run, and re-merge to canonical form. Offsets are clamped; an empty
 * selection returns the input canonicalized.
 *
 * `deltaFor` is a function of the run rather than a fixed object ONLY because the
 * two public ops differ exactly there: applyRunStyle overlays the SAME delta on
 * every covered run, adjustRunSize computes a per-run one from the run's own
 * resolved size. The public API stays two named primitives — this indirection is
 * private, and exists so the twelve lines of split/cover/merge below are written
 * once instead of twice (the hand-maintained-copy defect, in miniature).
 */
function overCoveredRuns(runs, start, end, deltaFor, inherited) {
  const len = runsLength(runs);
  const lo = Math.max(0, Math.min(start, end, len));
  const hi = Math.min(len, Math.max(start, end, 0));
  if (lo >= hi) return mergeAdjacentRuns(runs, inherited);
  // Split at BOTH boundaries so [lo, hi) is spanned by whole runs.
  const split = splitRunAt(splitRunAt(runs, lo), hi);
  const out = [];
  let pos = 0;
  for (const r of split) {
    const rlen = [...(r.text ?? "")].length;
    // A run lies fully inside [lo, hi) iff its whole extent is covered.
    if (pos >= lo && pos + rlen <= hi && rlen > 0) out.push({ ...r, ...deltaFor(r) });
    else out.push({ ...r });
    pos += rlen;
  }
  return mergeAdjacentRuns(out, inherited);
}

/**
 * Pure function. The style of the run covering character `offset` (the caret's
 * style — used to seed a toolbar for an empty selection and to inherit style for
 * typed insertions). At a run boundary the LEFT run's style wins (typing at a
 * boundary continues the preceding run's style — the universal editor
 * convention); offset 0 uses the first run; past the end uses the last run.
 *
 * @example runStyleAt([{text: "ab", bold: true}, {text: "cd", bold: false}], 1).bold // true
 * @example runStyleAt([{text: "ab", bold: true}, {text: "cd", bold: false}], 2).bold // true (left wins at boundary)
 * @example runStyleAt([{text: "ab", bold: true}, {text: "cd", bold: false}], 3).bold // false
 * @example runStyleAt([], 0) // {}
 */
export function runStyleAt(runs, offset) {
  if (runs.length === 0) return {};
  let pos = 0;
  let last = runs[0];
  for (const r of runs) {
    const rlen = [...(r.text ?? "")].length;
    // offset strictly inside this run, OR at its END with a following run
    // (boundary → left wins): this run's style applies.
    if (offset > pos && offset <= pos + rlen) last = r;
    else if (offset <= pos && pos === 0) last = r;
    pos += rlen;
    if (offset < pos) break;
  }
  return styleOf(last);
}

/**
 * Pure function. The COMMON value of style key `key` across the selection
 * [start, end): the shared value if every covered character agrees, else
 * `undefined` (mixed) — what the toolbar reads to show a control as set,
 * unset, or indeterminate. An empty selection reads runStyleAt(start).
 *
 * @example commonStyle([{text: "ab", bold: true}, {text: "cd", bold: true}], 0, 4, "bold") // true
 * @example commonStyle([{text: "ab", bold: true}, {text: "cd", bold: false}], 0, 4, "bold") // undefined (mixed)
 * @example commonStyle([{text: "abcd", bold: true}], 1, 3, "bold") // true
 */
export function commonStyle(runs, start, end, key) {
  const len = runsLength(runs);
  const lo = Math.max(0, Math.min(start, end, len));
  const hi = Math.min(len, Math.max(start, end, 0));
  if (lo >= hi) return runStyleAt(runs, lo)[key];
  let value; let seen = false;
  let pos = 0;
  for (const r of runs) {
    const rlen = [...(r.text ?? "")].length;
    // This run overlaps [lo, hi) iff its extent intersects it.
    if (pos < hi && pos + rlen > lo) {
      const v = styleOf(r)[key];
      if (!seen) { value = v; seen = true; }
      else if (v !== value) return undefined;
    }
    pos += rlen;
  }
  return value;
}

// ── text insert / delete at a character offset (the editing substrate) ─────────
// The in-place editor mutates the MODEL (not the DOM) on every keystroke/paste/
// delete. These two PURE primitives are all it needs: both reuse splitRunAt +
// mergeAdjacentRuns (runs) and paragraphRanges (paras), so a typed character
// inherits the caret's style (runStyleAt, left-wins) and an inserted/removed "\n"
// grows/shrinks the paras array in lock-step with the paragraph count. Offsets are
// CODE POINTS over the concatenated run text (richTextToPlain), "\n" included —
// the SAME offset space applyRunStyle/applyParaStyle/commonStyle consume.

/** Pure function. Number of "\n" characters in `text`.
 *
 * @example countNewlines("a\nb\nc") // 2
 * @example countNewlines("abc") // 0
 */
export function countNewlines(text) {
  let n = 0;
  for (const ch of text) if (ch === "\n") n += 1;
  return n;
}

/**
 * Pure function. Inserts `text` (which may contain "\n") at character `offset`
 * into a rich {runs, paras} value, returning a NEW value (never mutates). The
 * inserted characters inherit the caret's style (runStyleAt at `offset` — the
 * left-run-wins convention, so typing at a boundary continues the preceding run's
 * style). Every "\n" in `text` splits the paragraph at `offset` into more
 * paragraphs, each inheriting that paragraph's style — so the paras array grows by
 * countNewlines(text) and stays 1:1 with the paragraph count. Runs are re-merged
 * to canonical form (a typed char adjacent to an identically-styled run coalesces).
 *
 * Args:
 *   value ({runs, paras}): canonical rich value
 *   offset (number): character offset (clamped to [0, length])
 *   text (string): the characters to insert (may include "\n")
 *   inherited (object): widget-level style an absent run key resolves to,
 *     forwarded to the canonicalizing merge (see sameStyle)
 *
 * Returns:
 *   {runs, paras}: new rich value
 *
 * @example insertText({runs: [{text: "ac"}], paras: [{}]}, 1, "b").runs[0].text // "abc"
 * @example insertText({runs: [{text: "ab", bold: true}], paras: [{}]}, 2, "c").runs[0].bold // true (inherits left run's style)
 * @example insertText({runs: [{text: "ab"}], paras: [{}]}, 1, "\n").paras.length // 2 (a newline adds a paragraph)
 * @example insertText({runs: [{text: ""}], paras: [{}]}, 0, "hi").runs[0].text // "hi"
 * @example insertText({runs: [{text: "ab"}], paras: [{}]}, 2, "c").runs[0] // {text: "abc"} (a BARE run stays bare — the typed char stores no style)
 */
export function insertText(value, offset, text, inherited = {}) {
  const runs = value.runs ?? [];
  const paras = value.paras ?? [];
  const len = runsLength(runs);
  const at = Math.max(0, Math.min(offset, len));
  if (text.length === 0) return { runs: mergeAdjacentRuns(runs, inherited), paras: [...paras] };
  const style = runStyleAt(runs, at); // caret style (left wins at a boundary)
  const split = splitRunAt(runs, at); // ensure a run boundary exactly at `at`
  const out = [];
  let pos = 0, inserted = false;
  for (const r of split) {
    if (!inserted && pos === at) { out.push({ text, ...style }); inserted = true; }
    out.push({ ...r });
    pos += [...(r.text ?? "")].length;
  }
  if (!inserted) out.push({ text, ...style }); // at === len (end of text)
  return { runs: mergeAdjacentRuns(out, inherited), paras: paraInsert(paras, runs, at, countNewlines(text)) };
}

/**
 * Pure function. Deletes the characters in [start, end) from a rich {runs, paras}
 * value, returning a NEW value (never mutates). Splits runs at both boundaries,
 * drops the fully-covered runs, and re-merges to canonical form. Every "\n" inside
 * the deleted range merges two paragraphs, so the paras array shrinks by the
 * number of deleted newlines (the surviving merged paragraph keeps the FIRST
 * touched paragraph's style — the universal "delete-across-paragraphs joins into
 * the first" convention). An empty range (start === end) is a no-op (canonicalized).
 *
 * Args:
 *   value ({runs, paras}): canonical rich value
 *   start (number): range start offset
 *   end (number): range end offset
 *   inherited (object): widget-level style an absent run key resolves to,
 *     forwarded to the canonicalizing merge (see sameStyle)
 *
 * Returns:
 *   {runs, paras}: new rich value
 *
 * @example deleteRange({runs: [{text: "abc"}], paras: [{}]}, 1, 2).runs[0].text // "ac"
 * @example deleteRange({runs: [{text: "a\nb"}], paras: [{}, {}]}, 1, 2).paras.length // 1 (the newline was deleted → paragraphs merge)
 * @example deleteRange({runs: [{text: "abc"}], paras: [{}]}, 1, 1).runs[0].text // "abc" (empty range no-op)
 * @example deleteRange({runs: [{text: "abcd"}], paras: [{}]}, 0, 4).runs[0].text // "" (all gone → one empty run kept)
 * @example deleteRange({runs: [{text: "ab"}, {text: "cd", bold: false}], paras: [{}]}, 4, 4, {bold: true}).runs.length // 2 (a no-op delete in a BOLD box does not merge the un-bold away)
 */
export function deleteRange(value, start, end, inherited = {}) {
  const runs = value.runs ?? [];
  const paras = value.paras ?? [];
  const len = runsLength(runs);
  const lo = Math.max(0, Math.min(start, end, len));
  const hi = Math.min(len, Math.max(start, end, 0));
  if (lo >= hi) return { runs: mergeAdjacentRuns(runs, inherited), paras: [...paras] };
  const split = splitRunAt(splitRunAt(runs, lo), hi);
  const out = [];
  let pos = 0;
  for (const r of split) {
    const rlen = [...(r.text ?? "")].length;
    if (pos >= lo && pos + rlen <= hi) { pos += rlen; continue; } // fully inside → drop
    out.push({ ...r });
    pos += rlen;
  }
  const deletedNewlines = countNewlines([...richTextToPlain(value)].slice(lo, hi).join(""));
  return { runs: mergeAdjacentRuns(out, inherited), paras: paraDelete(paras, runs, lo, deletedNewlines) };
}

/** Pure helper. The paras array after inserting `k` newlines inside the paragraph
 * containing `at`: that paragraph's style entry is replaced by k+1 copies (each
 * split piece inherits it), so the array grows by k and stays 1:1 with the new
 * paragraph count. */
function paraInsert(paras, oldRuns, at, k) {
  if (k === 0) return [...paras];
  const ranges = paragraphRanges(oldRuns);
  let p = ranges.findIndex((r) => at <= r.end);
  if (p < 0) p = ranges.length - 1;
  const base = paras?.[p] ?? paras?.[0] ?? { ...DEFAULT_PARA };
  const copies = Array.from({ length: k + 1 }, () => ({ ...base }));
  return [...paras.slice(0, p), ...copies, ...paras.slice(p + 1)];
}

/** Pure helper. The paras array after deleting `m` newlines starting in the
 * paragraph containing `lo`: paragraphs p..p+m merge into one (keeping p's style),
 * so the array shrinks by m and stays 1:1 with the new paragraph count. */
function paraDelete(paras, oldRuns, lo, m) {
  if (m === 0) return [...paras];
  const ranges = paragraphRanges(oldRuns);
  let p = ranges.findIndex((r) => lo <= r.end);
  if (p < 0) p = ranges.length - 1;
  const kept = paras?.[p] ?? paras?.[0] ?? { ...DEFAULT_PARA };
  return [...paras.slice(0, p), { ...kept }, ...paras.slice(p + 1 + m)];
}

/**
 * Pure function. The rich value whose PLAIN-TEXT projection is `plain`, changing
 * as little of the run structure as possible: the shared prefix and the shared
 * suffix are left untouched and only the span between them is deleteRange'd and
 * insertText'd. So retyping one word keeps every other run's style, and the
 * replacement takes the style at the splice point — byte-identically to typing
 * the same edit in the canvas editor, which reaches the same two primitives.
 *
 * WHY A MINIMAL SPLICE AND NOT `{runs: [{text: plain}], paras: [{}]}`. The naive
 * form is the reason plugins/text.js refused a content row for so long: it
 * CLOBBERS — a whole document's per-run typography vanishes because one letter
 * was retyped. The splice is what makes a plain-string surface honest over a
 * structured value, and it is the only reason such a surface may exist at all.
 *
 * Offsets are CODE POINTS, matching insertText/deleteRange (and runsLength).
 *
 * Args:
 *   value ({runs, paras}|string): the current rich value
 *   plain (string): the plain text the result must project to
 *   inherited (object): widget-level style forwarded to the canonicalizing merge
 *
 * Returns:
 *   {runs, paras}: new rich value with richTextToPlain(result) === plain
 *
 * @example richTextToPlain(withPlainTextReplaced({runs: [{text: "Hi "}, {text: "there"}], paras: [{}]}, "Hi world"))
 * // "Hi world"
 * @example withPlainTextReplaced({runs: [{text: "Big ", size: 48}, {text: "small", size: 18}], paras: [{}]}, "Big smaller").runs
 * // [{text: "Big ", size: 48}, {text: "smaller", size: 18}] — editing inside one run keeps BOTH sizes
 * @example withPlainTextReplaced({runs: [{text: "Big ", size: 48}, {text: "small", size: 18}], paras: [{}]}, "Bigger small").runs
 * // [{text: "Bigger ", size: 48}, {text: "small", size: 18}] — and so does editing inside the other
 * @example withPlainTextReplaced({runs: [{text: "Big ", size: 48}, {text: "small", size: 18}], paras: [{}]}, "Big SMALL").runs
 * // [{text: "Big SMALL", size: 48}] — THE HONEST BOUND: replacing a run's text ENTIRELY leaves no
 * // character of it to carry its style, so the replacement takes the neighbour's — which is exactly
 * // what selecting that word in the canvas editor and retyping it does
 * @example withPlainTextReplaced({runs: [{text: "ab", bold: true}], paras: [{}]}, "ab").runs
 * // [{text: "ab", bold: true}] — an unchanged string is an exact no-op
 * @example withPlainTextReplaced({runs: [{text: "ab"}], paras: [{}]}, "a\nb").paras.length
 * // 2 — a typed newline splits the paragraph, exactly as insertText does
 * @example richTextToPlain(withPlainTextReplaced({runs: [{text: "abc"}], paras: [{}]}, ""))
 * // "" — clearing the row empties the box (and makes it a ghost) rather than failing
 */
export function withPlainTextReplaced(value, plain, inherited = {}) {
  const before = [...richTextToPlain(value)];
  const after = [...plain];
  const limit = Math.min(before.length, after.length);
  let head = 0;
  while (head < limit && before[head] === after[head]) head += 1;
  let tail = 0;
  while (tail < limit - head && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail += 1;
  // unresolvedRichText, never normalizeRichText: this value is WRITTEN BACK, and
  // normalize would RESOLVE the widget-level style onto every run — the
  // re-shadowing TextEditController's header warns about, which is exactly how
  // the eight box rows died the first time. It also absorbs a legacy string and
  // junk, so this function needs no shape branch of its own.
  const cut = deleteRange(unresolvedRichText(value), head, before.length - tail, inherited);
  return insertText(cut, head, after.slice(head, after.length - tail).join(""), inherited);
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
