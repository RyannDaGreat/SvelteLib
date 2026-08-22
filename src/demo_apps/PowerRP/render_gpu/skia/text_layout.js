/**
 * TEXT LAYOUT — the ONE CanvasKit Paragraph builder the RENDER and the EDITOR
 * both go through, so caret/selection geometry is derived from the EXACT shaped
 * layout that produced the on-screen glyphs (no second text engine to drift from
 * — the fix for the transparent-contenteditable caret drift on mixed runs).
 *
 * A text op (rich {runs,paras} + box) is laid out as ONE CanvasKit Paragraph PER
 * hard-newline paragraph, stacked vertically and shifted by the box's vertical-
 * alignment offset — mirroring the historical drawTextOp math EXACTLY (so the
 * refactor is render-neutral). The built stack is CACHED (keyed on the value +
 * box + opacity), so:
 *   - the render draws the cached Paragraphs (paint_skia.drawTextOp), and
 *   - the editor queries the SAME cached Paragraphs for geometry
 *     (offsetAtPoint / caretRect / selectionRects / wordAt / lineMove),
 * guaranteeing render and editor share one layout by construction, not by luck.
 *
 * ── INDEX DISCIPLINE ──────────────────────────────────────────────────────────
 * The MODEL (core/richtext.js) counts CODE POINTS (its helpers iterate `[...t]`);
 * CanvasKit's Paragraph indices are UTF-16 code units. This module converts at
 * the boundary (cpToU16 / u16ToCp against each paragraph's own text) so callers
 * pass/receive MODEL code-point offsets over richTextToPlain(rich) — the exact
 * offset space applyRunStyle/applyParaStyle/insertText/deleteRange consume.
 *
 * Empty paragraphs are rendered with an injected U+200B (matching drawTextOp), so
 * their built Paragraph has 1 UTF-16 unit but the model charCount is 0 — handled
 * as a special case (caret maps to the strut rect; queries clamp to local 0).
 *
 * Coordinates returned are LOCAL (op-relative, top-left origin, y-down) — the
 * caller maps local → world → screen through the item's transform. Out-of-range
 * hit-test coordinates are clamped (Skia's getGlyphPositionAtCoordinate can hit
 * an `unreachable` on some coords — flutter#135180).
 *
 * DOM-free; imported by paint_skia.js (render) and web/TextEditController.svelte
 * (editor). CanvasKit is a process-wide singleton in both node and browser, so
 * the module-level cache never mixes Paragraphs across instances.
 */

import { parseColor, parsePaint, isGradientPaint, isMaterialPaint, isPaintOff, paintSolidColor } from "../ir.js";
import { skShaderForPaint } from "./gradient.js";
import { getMaterial, materialEffect, isFillCapableMaterial, isBackdropMaterial, isSamplerMaterial } from "./materials.js";
import { fontFamilyChain } from "../fonts.js";
import { splitParagraphs, paragraphRanges, paraStyleFor, valignOffset, DEFAULT_VALIGN, NATURAL_LINE_HEIGHT } from "../../core/richtext.js";

export const DEFAULT_TEXT_SIZE = 36; // mirrors core/richtext DEFAULT_PARA_SIZE (a bare run/op with no size)
const INFINITE_LAYOUT_WIDTH = 1e7; // an unbounded (boxW===Infinity) op lays out left-aligned at a width it can never fill (no wrap, no alignment slack)

// ── UTF-16 ⇄ code-point conversion (the model↔CanvasKit index boundary) ────────

/**
 * Pure function. UTF-16 code-unit offset for the first `cp` code points of `str`
 * (clamped to str's code-point count). The model counts code points; CanvasKit
 * counts UTF-16 units — this converts a model-local offset into a Paragraph index.
 *
 * @example cpToU16("abc", 2) // 2
 * @example cpToU16("a\u{1F600}b", 2) // 3 (the emoji is 2 UTF-16 units)
 */
export function cpToU16(str, cp) {
  const arr = [...str];
  let u = 0;
  for (let i = 0; i < Math.min(cp, arr.length); i++) u += arr[i].length;
  return u;
}

/**
 * Pure function. Code-point offset for a UTF-16 code-unit offset into `str` (the
 * inverse of cpToU16). A UTF-16 offset landing INSIDE a surrogate pair rounds
 * DOWN to the code point's start (CanvasKit never returns a split index, but the
 * clamp keeps it total).
 *
 * @example u16ToCp("abc", 2) // 2
 * @example u16ToCp("a\u{1F600}b", 3) // 2 (past the 2-unit emoji)
 */
export function u16ToCp(str, u16) {
  let cp = 0, i = 0;
  while (i < u16 && i < str.length) {
    const code = str.codePointAt(i);
    i += code > 0xffff ? 2 : 1;
    cp += 1;
  }
  return cp;
}

// ── the cache ──────────────────────────────────────────────────────────────────

const CACHE_MAX = 32; // bounded so continuous edits/tweens never leak WASM Paragraphs
const _cache = new Map(); // key → TextLayout (LRU by Map insertion order)

/**
 * Query→build (cached; owns the returned TextLayout's lifecycle). Returns the
 * TextLayout for a text op, building + caching it on a miss and disposing the LRU
 * victim past CACHE_MAX. Both the render and the editor call this with the same
 * op ⇒ the SAME cached TextLayout, so their geometry is identical by construction.
 *
 * THE CACHE OWNS THE RETURNED LAYOUT, AND THAT IS A CONTRACT WITH TEETH. The
 * caller must not dispose it, and — the half that shipped a crash — must not STORE
 * it either: eviction is driven by OTHER callers building OTHER layouts (a
 * node-graph slide lays out far more than CACHE_MAX distinct text ops per frame),
 * so a held layout is freed under you with nothing to observe. Fetch fresh at each
 * geometry query; a hit is O(1) while the value is stable. A reader that ignores
 * this now gets `TextLayout.live()`'s sentence instead of an anonymous TypeError.
 *
 * Args:
 *   CanvasKit: the initialized CanvasKit module
 *   fc (FontCollection): the shared committed + fallback FontCollection
 *   cmd (object): a text IR op ({rich}|legacy single-run, boxW, boxH, boxStyle)
 *   opacity (number): folded into glyph/highlight/decoration alpha (render parity)
 *
 * Returns:
 *   TextLayout
 */
export function getTextLayout(CanvasKit, fc, cmd, opacity = 1) {
  const norm = normalizeCmd(cmd);
  const key = layoutKey(norm, opacity);
  const hit = _cache.get(key);
  if (hit) { _cache.delete(key); _cache.set(key, hit); return hit; } // LRU bump
  const layout = buildTextLayout(CanvasKit, fc, norm, opacity);
  _cache.set(key, layout);
  while (_cache.size > CACHE_MAX) {
    const oldestKey = _cache.keys().next().value;
    const old = _cache.get(oldestKey);
    _cache.delete(oldestKey);
    old.dispose();
  }
  return layout;
}

/** Pure function. The normalized {rich, boxStyle, boxW, boxH} of a text op (rich
 * op passes through; a legacy single-run op is wrapped). Origin x/y are excluded
 * — they do not affect the LOCAL layout/geometry, only the draw position. */
function normalizeCmd(cmd) {
  return {
    rich: cmd.rich ?? singleRunRich(cmd),
    boxStyle: cmd.boxStyle ?? {},
    boxW: cmd.boxW ?? Infinity,
    boxH: cmd.boxH ?? Infinity,
  };
}

/** Pure function. A stable cache key from the normalized op + opacity. Infinity
 * serializes to null (stable + consistent); x/y are absent by construction. */
function layoutKey(norm, opacity) {
  return JSON.stringify({ r: norm.rich, s: norm.boxStyle, w: norm.boxW, h: norm.boxH, o: opacity });
}

/** Pure-ish helper. A one-run rich value from a legacy single-run text op (its
 * fields ARE the run style; color may be an rgba array — ckColor handles both). */
function singleRunRich(cmd) {
  return {
    runs: [{ text: cmd.text, size: cmd.size, color: cmd.color, bold: cmd.bold, italic: false, underline: false, strike: false, font: cmd.font, outlineColor: "#000000", outlineWidth: 0, highlight: "" }],
    paras: [{}],
  };
}

// ── build ────────────────────────────────────────────────────────────────────

/**
 * Query→build (allocates Paragraphs — the returned TextLayout owns them). Builds
 * the per-paragraph Paragraph stack for a normalized op, mirroring drawTextOp's
 * math exactly: one Paragraph per hard-newline paragraph, stacked by height and
 * shifted down by the box vertical-align offset. Attaches each paragraph's MODEL
 * code-point range (textStart/charCount, from paragraphRanges) + its plain text
 * (for UTF-16 conversion) + its local yTop.
 */
function buildTextLayout(CanvasKit, fc, norm, opacity) {
  const { rich, boxStyle, boxW, boxH } = norm;
  const fallbackStyle = rich.runs[0] ?? { size: DEFAULT_TEXT_SIZE, font: "system", color: "#000000" };
  const paragraphs = splitParagraphs(rich.runs);
  const ranges = paragraphRanges(rich.runs); // model code-point ranges (1:1 with paragraphs)
  const built = paragraphs.map((pieces, i) => {
    const b = buildParagraph(CanvasKit, fc, pieces, paraStyleFor(rich.paras, i, boxStyle), boxW, fallbackStyle, opacity);
    return {
      para: b.para,
      height: b.height,
      text: pieces.map((p) => p.text).join(""), // MODEL plain text (no injected U+200B)
      textStart: ranges[i].start,
      charCount: ranges[i].end - ranges[i].start,
      yTop: 0,
      // The paragraph's own pieces, kept so `shapedGlyphs()` can name the RUN
      // style a shaped glyph belongs to (which face the outline source must
      // load). Plain data already in hand — no extra work at build time.
      pieces,
      // Per-piece shaped-glyph groups for the OUTLINE (and gradient-fill) glyph
      // pass — EMPTY (fast path) unless a piece needs one (outline / gradient).
      glyphGroups: glyphGroupsFor(CanvasKit, b.para, pieces),
    };
  });
  const totalH = built.reduce((s, b) => s + b.height, 0);
  const vOffset = valignOffset(boxStyle.valign ?? DEFAULT_VALIGN, boxH, totalH);
  let y = vOffset;
  for (const b of built) { b.yTop = y; y += b.height; }
  return new TextLayout(CanvasKit, built, vOffset, totalH, opacity);
}

// ── glyph pass (OUTLINE stroke + gradient fill) ───────────────────────────────
// CanvasKit 0.41.1's Paragraph TextStyle exposes only foregroundColor (a COLOR,
// NOT a Paint — verified empirically), so a per-run STROKE outline or a gradient
// SHADER fill cannot ride the Paragraph. Instead we read the shaped glyph runs
// (para.getShapedLines(): glyph ids + absolute positions + the resolved typeface)
// and re-draw them with canvas.drawGlyphs + an arbitrary Paint (stroke for the
// outline, MakeLinearGradient/MakeRadialGradient shader for gradient text). The
// glyphs align EXACTLY with the Paragraph fill (same shaping), so the outline
// sits under the fill (paint-order:stroke, matching the SVG/PDF export idiom).

/** Pure function. UTF-16 char ranges of a paragraph's pieces (splitParagraphs
 * output), concatenated in order: piece i spans [start, end) with its style.
 * The shaped-run glyph `offsets` index this same paragraph text, so a glyph's
 * offset locates its owning piece (styleAtOffset).
 *
 * @example pieceCharRanges([{text: "ab", style: {}}, {text: "cd", style: {}}]).map((r) => [r.start, r.end]) // [[0, 2], [2, 4]]
 * @example pieceCharRanges([]) // []
 */
export function pieceCharRanges(pieces) {
  const out = [];
  let at = 0;
  for (const p of pieces) {
    const len = p.text.length; // UTF-16 units (matches getShapedLines offsets)
    out.push({ start: at, end: at + len, style: p.style });
    at += len;
  }
  return out;
}

/** Pure function. The style whose char range contains `offset` (the last range
 * whose start <= offset, clamped to the final piece for a trailing offset). null
 * if there are no ranges.
 *
 * @example styleAtOffset([{start: 0, end: 2, style: {a: 1}}, {start: 2, end: 4, style: {a: 2}}], 3).a // 2
 * @example styleAtOffset([{start: 0, end: 2, style: {a: 1}}], 5).a // 1 (trailing → last piece)
 * @example styleAtOffset([], 0) // null
 */
export function styleAtOffset(ranges, offset) {
  if (ranges.length === 0) return null;
  for (const r of ranges) if (offset >= r.start && offset < r.end) return r.style;
  return ranges[ranges.length - 1].style;
}

/** Pure function. Is a run's fill a GRADIENT specifically — an object paint that
 * is NOT a material? `isGradientPaint` is deliberately the broad "object ⇒ needs a
 * shader" test (ir.js), so it answers TRUE for a material paint too; every
 * consumer that can draw only ONE of the two must qualify it, which is the idiom
 * pdf_backend.js already uses (`isGradientPaint(fill) && fill.type === "material"`).
 * Without this split a material fill fell into drawGlyphGradientFill and
 * skShaderForPaint read `paint.stops.map` on a paint that has no stops — a
 * TypeError mid-paint, which is how material-on-text failed before it was built.
 *
 * @param {*} paint - a run style's `color`
 * @returns {boolean}
 *
 * @example isGradientOnlyPaint({ type: "linearGradient", stops: [] }) // true
 * @example isGradientOnlyPaint({ type: "material", material: { id: "comic" } }) // false
 * @example isGradientOnlyPaint("#f00") // false
 */
export function isGradientOnlyPaint(paint) {
  return isGradientPaint(paint) && !isMaterialPaint(paint);
}

/** Pure function. True iff a run style needs the glyph pass (an outline stroke,
 * or a gradient/MATERIAL fill the Paragraph can't render). A plain solid-fill,
 * no-outline run needs nothing → the byte-identical drawParagraph-only fast path.
 *
 * A MATERIAL fill joins the gradient here for the SAME structural reason the
 * gradient is here at all: CanvasKit 0.41.1's TextStyle exposes foregroundColor,
 * a COLOR and not a Paint, so no shader of any kind can ride the Paragraph. Both
 * therefore draw the Paragraph glyphs TRANSPARENT and re-draw the shaped glyphs
 * with drawGlyphs under a shader Paint.
 *
 * @example styleNeedsGlyphPass({ outlineWidth: 2 }) // true
 * @example styleNeedsGlyphPass({ color: { type: "linearGradient" } }) // true
 * @example styleNeedsGlyphPass({ color: { type: "material", material: { id: "comic" } } }) // true
 * @example styleNeedsGlyphPass({ color: "#f00", outlineWidth: 0 }) // false
 * @example styleNeedsGlyphPass({}) // false
 */
export function styleNeedsGlyphPass(style) {
  if ((style.outlineWidth ?? 0) > 0) return true;
  const c = style.color;
  return !!(c && typeof c === "object" && !Array.isArray(c));
}

/**
 * Query→build (reads shaped glyphs; allocates typed arrays, holds Paragraph-owned
 * typeface refs). Splits a laid-out Paragraph's shaped glyph runs into contiguous
 * groups sharing ONE piece style + typeface + size, so each group can be redrawn
 * with drawGlyphs under a single Paint. Returns [] on the fast path (no piece
 * needs an outline or gradient fill) — the Paragraph fill alone is then used and
 * the render is byte-identical to before this pass existed.
 *
 * The returned typeface refs are owned by `para` (valid while the cached layout
 * lives); the caller builds Fonts from them per draw and disposes those.
 */
function glyphGroupsFor(CanvasKit, para, pieces) {
  if (!pieces.some((p) => styleNeedsGlyphPass(p.style))) return [];
  const ranges = pieceCharRanges(pieces);
  const groups = [];
  for (const line of para.getShapedLines()) {
    for (const run of line.runs) {
      let cur = null;
      for (let i = 0; i < run.glyphs.length; i++) {
        const style = styleAtOffset(ranges, run.offsets[i]);
        if (!cur || cur.style !== style) {
          cur = { typeface: run.typeface, size: run.size, style, glyphs: [], positions: [] };
          groups.push(cur);
        }
        cur.glyphs.push(run.glyphs[i]);
        cur.positions.push(run.positions[2 * i], run.positions[2 * i + 1]);
      }
    }
  }
  return groups.map((g) => ({
    typeface: g.typeface, size: g.size, style: g.style,
    glyphs: Uint16Array.from(g.glyphs),
    positions: Float32Array.from(g.positions),
  }));
}

/**
 * Query→build (allocates a Paragraph; the TextLayout deletes it). Builds one
 * CanvasKit Paragraph for a single paragraph's pieces. A forced STRUT pins the
 * line height to the paragraph's own text metrics so a tall COLOR-EMOJI face on
 * the line does NOT inflate the line height. boxW===Infinity ⇒ left-aligned at
 * INFINITE_LAYOUT_WIDTH (no wrap, no alignment slack). (Moved verbatim from
 * paint_skia.js so render + editor share one build path.)
 */
export function buildParagraph(CanvasKit, fc, pieces, pstyle, boxW, fallbackStyle, opacity) {
  const infinite = boxW === Infinity;
  const strutSize = pieces.length ? Math.max(...pieces.map((p) => p.style.size ?? DEFAULT_TEXT_SIZE)) : (fallbackStyle.size ?? DEFAULT_TEXT_SIZE);
  const strutFont = (pieces[0]?.style ?? fallbackStyle).font ?? "system";
  const lineSpacing = pstyle.lineSpacing ?? 1;
  const strut = { strutEnabled: true, forceStrutHeight: true, fontFamilies: fontFamilyChain(strutFont), fontSize: strutSize };
  if (lineSpacing !== 1) strut.heightMultiplier = lineSpacing * NATURAL_LINE_HEIGHT;

  const pStyle = new CanvasKit.ParagraphStyle({
    textStyle: { color: CanvasKit.BLACK, fontFamilies: fontFamilyChain(strutFont), fontSize: strutSize },
    textAlign: infinite ? CanvasKit.TextAlign.Left : alignEnum(CanvasKit, pstyle.align),
    strutStyle: strut,
  });
  const builder = CanvasKit.ParagraphBuilder.MakeFromFontCollection(pStyle, fc);
  const charSpacing = pstyle.charSpacing ?? 0, wordSpacing = pstyle.wordSpacing ?? 0;
  if (pieces.length === 0) {
    builder.pushStyle(textStyle(CanvasKit, fallbackStyle, charSpacing, wordSpacing, opacity));
    builder.addText("​"); // U+200B zero-width space — gives a blank line its strut height without ink
    builder.pop();
  } else {
    for (const p of pieces) {
      builder.pushStyle(textStyle(CanvasKit, p.style, charSpacing, wordSpacing, opacity));
      builder.addText(p.text);
      builder.pop();
    }
  }
  const para = builder.build();
  para.layout(infinite ? INFINITE_LAYOUT_WIDTH : boxW);
  const height = para.getHeight();
  builder.delete();
  return { para, height };
}

/** Fully transparent ink — what an OFF (`{type:"none"}`) run paints, glyphs and
 * decorations alike. An rgba array, so it flows through ckColor/parseColor. */
const TRANSPARENT_INK = [0, 0, 0, 0];

/**
 * Pure function. Does this RUN FILL need the shader glyph pass — i.e. will
 * something repaint the glyphs after the Paragraph draws them transparent?
 *
 * THE ONE PLACE THAT QUESTION IS ANSWERED, because it is asked from two sides that
 * MUST agree: `textStyle` uses it to decide whether to draw the Paragraph glyphs
 * transparent, and `drawGlyphShaderFill` uses it to decide whether to build a
 * shader and repaint them. A disagreement renders the run INVISIBLE — transparent
 * glyphs that nothing repaints — with no error anywhere, which is precisely the
 * failure mode this codebase treats as worse than a crash.
 *
 * It must be asked of the PARSED paint, never the raw one. `isGradientPaint` is the
 * broad "is an object" test, so it answers TRUE for two objects that are not
 * shaders: `{type:"none"}` (parses to null) and `{type:"solid", solid}` (parses to
 * an rgba array — a solid paint OBJECT is not a string, but it is still a plain
 * colour the Paragraph draws perfectly well). A MATERIAL is the exception in the
 * other direction: parsePaint passes its sparse record through unchanged, so it
 * stays an object and correctly reports true.
 *
 * @param {*} color - a run style's `color` (raw model paint)
 * @returns {boolean}
 *
 * @example runFillNeedsShader({type: "linearGradient", linear: {stops: [{offset: 0, color: "#f00"}, {offset: 1, color: "#00f"}], angle: 0}}) // true
 * @example runFillNeedsShader({type: "material", material: {id: "comic"}}) // true
 * @example runFillNeedsShader({type: "solid", solid: "#123456"}) // false (an ordinary solid)
 * @example runFillNeedsShader({type: "none"}) // false (nothing to paint)
 * @example runFillNeedsShader("#f00") // false
 */
function runFillNeedsShader(color) {
  if (!isGradientPaint(color)) return false;
  if (isMaterialPaint(color)) return true; // built from the RAW sparse record
  return isGradientPaint(parsePaint(color));
}

/**
 * Pure function. A RUN COLOUR's representative solid, with a sentence when the
 * paint is malformed. Delegates to ir.js's paintSolidColor — the ONE resolver that
 * knows every paint shape (multi-sub-state, legacy inline, solid object, material,
 * crossfade) — and exists only to name the RUN when that resolver refuses.
 *
 * A NAMED ERROR BEATS BOTH THE CRASH AND A SILENT DEFAULT. Before this, a paint
 * shape the layout did not understand produced `Cannot read properties of
 * undefined (reading '0')` from inside a CanvasKit builder — a stack with no
 * mention of text, of a run, or of a paint, which is why the deployed crash took
 * three days and two workstreams to place. Substituting a quiet black would be
 * worse: the text would render in the wrong colour with nothing to look at, which
 * is the silent wrongness this codebase forbids.
 *
 * @param {*} paint - a run style's `color` (raw model paint, never parsed)
 * @returns {string|Array<number>} a colour paintSolidColor resolved
 *
 * @example solidInkForRun({type: "linearGradient", solid: "#f00", linear: {stops: [{offset: 0, color: "#0f0"}]}}) // "#f00"
 * @example solidInkForRun({type: "linearGradient", stops: [{offset: 0, color: "#0f0"}]}) // "#0f0" (legacy inline)
 * @example solidInkForRun({type: "material", material: {id: "comic"}}) // "#888888"
 */
function solidInkForRun(paint) {
  try {
    return paintSolidColor(paint);
  } catch (e) {
    throw new Error(
      `text_layout: a text run carries a paint no colour can be resolved from — ${JSON.stringify(paint)}. ` +
      `A run colour is RAW model state (ir.js text() does not parsePaint rich.runs), so it must be one of: ` +
      `a CSS string, an rgba array, {type:"solid",solid}, a gradient with stops (under linear/radial, or inline), ` +
      `{type:"material"}, {type:"crossfade"} or {type:"none"}. Underlying: ${e.message}`,
      { cause: e },
    );
  }
}

/** Pure-ish helper. A run's style → CanvasKit TextStyle. (Moved verbatim from
 * paint_skia.js.) color/backgroundColor/decorationColor fold `opacity` into their
 * alpha; the RGB is never forced onto color-glyph (emoji) fonts. */
function textStyle(CanvasKit, st, charSpacing, wordSpacing, opacity) {
  // NO SHADER fill can ride the Paragraph (foregroundColor is a color, not a
  // Paint, in ckwasm 0.41.1) — draw the glyph fill TRANSPARENT here and let the
  // shader glyph pass (drawGlyphShaderFill) paint it. That is true of a GRADIENT
  // and equally of a MATERIAL, so both take the same transparent-glyph route.
  //
  // Decorations (underline / strike) still need ONE representative SOLID, because
  // a decoration is a Paragraph-drawn rule with a plain colour: a gradient lends
  // its first stop, and a material has no meaningful single colour at all, so it
  // reduces through ir.js's paintSolidColor — the documented neutral-gray stand-in
  // every other single-colour consumer of a material paint already uses. An
  // underline under material text is therefore gray rather than materialled; that
  // is a real bound, and it is the same one a material border/shadow tint has.
  //
  // EVERY PAINT SHAPE GOES THROUGH paintSolidColor, AND THAT IS THE WHOLE FIX FOR
  // THE DOUBLE-CLICK CRASH (workstream TEXTCRASH, 2026-08-12). This read used to be
  // a hand-rolled `st.color.stops[0].color`, which knew exactly ONE of the shapes a
  // run colour actually takes: the LEGACY INLINE gradient (`{type, stops, from,
  // to}`). A run colour arrives here RAW — `ir.js text()` parsePaints the op-level
  // `color` but passes `rich` THROUGH UNTOUCHED, so `rich.runs[i].color` is model
  // state, not a parsed paint — and the shape the PaintField writes TODAY is the
  // multi-sub-state record (`{type, solid, linear: {stops}, radial: {stops}}`),
  // whose stops live under `linear`/`radial` and NEVER at the top level. So the
  // modern, current-schema gradient run was the crashing case and the legacy one
  // was the only shape that worked — the exact inverse of how it was triaged. A
  // `{type: "solid"}` object and an OFF paint fell down the same hole.
  // paintSolidColor (ir.js) is the funnel that already resolves all of them —
  // sub-state, legacy inline, solid object, material, crossfade — so routing here
  // deletes the duplicate rather than adding a guard beside it. It is also what
  // ckColor→parseColor does with an object on the line below, so the two halves of
  // this function now agree by construction instead of by coincidence.
  // THE SAME PREDICATE THE GLYPH PASS ROUTES ON — see runFillNeedsShader. These two
  // decisions are one decision: this line decides to draw the glyphs TRANSPARENT
  // because something else will repaint them, and the glyph pass decides whether
  // anything actually does. If they ever disagree the run renders INVISIBLE, which
  // is why the question is asked once, in one place, by both callers.
  const shader = runFillNeedsShader(st.color);
  // An OFF paint (`{type: "none"}`) is INVISIBLE INK, not a broken paint: it is the
  // one object paintSolidColor has no answer for, and correctly refuses. Decorations
  // take the same nothing the glyphs do, so it resolves to transparent here rather
  // than throwing — matching every other backend's `if (cmd.fill)` skip.
  const solidInk = isPaintOff(st.color) ? TRANSPARENT_INK
    : !isGradientPaint(st.color) ? (st.color ?? "#000000")
    : solidInkForRun(st.color);
  const spec = {
    // A SHADER run draws its glyphs TRANSPARENT (the glyph pass repaints them). An
    // OFF run also paints nothing — but it reaches that through solidInk/ckColor's
    // transparent ink rather than through `shader`, because runFillNeedsShader says
    // FALSE for it (there is no shader to build) — and a fully transparent colour
    // draws exactly the same nothing.
    color: shader ? CanvasKit.Color4f(0, 0, 0, 0) : ckColor(CanvasKit, solidInk, opacity),
    fontFamilies: fontFamilyChain(st.font ?? "system"),
    fontSize: st.size ?? DEFAULT_TEXT_SIZE,
    fontStyle: {
      weight: st.bold ? CanvasKit.FontWeight.Bold : CanvasKit.FontWeight.Normal,
      slant: st.italic ? CanvasKit.FontSlant.Italic : CanvasKit.FontSlant.Upright,
      width: CanvasKit.FontWidth.Normal,
    },
  };
  if (charSpacing) spec.letterSpacing = charSpacing;
  if (wordSpacing) spec.wordSpacing = wordSpacing;
  if (typeof st.highlight === "string" && st.highlight.length > 0) spec.backgroundColor = ckColor(CanvasKit, st.highlight, opacity);
  let deco = CanvasKit.NoDecoration;
  if (st.underline) deco |= CanvasKit.UnderlineDecoration;
  if (st.strike) deco |= CanvasKit.LineThroughDecoration;
  if (deco !== CanvasKit.NoDecoration) {
    spec.decoration = deco;
    spec.decorationColor = ckColor(CanvasKit, solidInk, opacity);
    spec.decorationStyle = CanvasKit.DecorationStyle.Solid;
  }
  return new CanvasKit.TextStyle(spec);
}

/** Pure-ish helper. A CanvasKit Color4f from a CSS string OR rgba array, folding
 * `opacity` into the alpha channel. */
function ckColor(CanvasKit, c, opacity = 1) {
  const rgba = parseColor(c);
  return CanvasKit.Color4f(rgba[0], rgba[1], rgba[2], rgba[3] * opacity);
}

/** Pure-ish helper. Paragraph horizontal-align string → CanvasKit TextAlign. */
function alignEnum(CanvasKit, align) {
  switch (align) {
    case "center": return CanvasKit.TextAlign.Center;
    case "right": return CanvasKit.TextAlign.Right;
    case "justify": return CanvasKit.TextAlign.Justify;
    default: return CanvasKit.TextAlign.Left;
  }
}

// ── the INK-METRICS seam (core/ink_metrics) ───────────────────────────────────

/**
 * Query→build (builds and disposes one throwaway Paragraph per distinct run;
 * memoized per (text, style)). Builds THE per-run measure function
 * core/ink_metrics wants: `(text, {size, bold, font, italic}) → {width, ascent,
 * descent}` in LOCAL units, measured through the SAME CanvasKit FontCollection
 * that shapes the glyphs this module draws.
 *
 * ── WHY THIS IS THE RIGHT MEASURE AND canvas2D IS NOT ────────────────────────
 * There is already a canvas2D-backed run measure in the tree (web/pdfFonts.js
 * measureText, feeding the PDF/SVG vector exporters). This one exists ALONGSIDE
 * it rather than replacing it because the two answer for different renderers: the
 * exporters lay out with canvas2D metrics and so must measure with canvas2D, and
 * the SKIA path shapes with this FontCollection and so must measure with it.
 * Using either seam for the other's renderer would make the ink rect disagree
 * with the glyphs it claims to bound — which is precisely the defect INK BOUNDS
 * exists to remove. It also works in BARE NODE, where there is no canvas2D at
 * all, so the CLI still gets true bounds.
 *
 * MEMOIZED because a bounds query runs per node per frame while the text is
 * unchanged, and each miss allocates a WASM Paragraph. The cache is bounded and
 * LRU'd for the same reason the layout cache is: continuous typing would
 * otherwise grow it without limit.
 *
 * `measureRun` is called on SUBSTRINGS by the wrapper (core/richtext.wrapParagraph
 * measures each word), so the key is the substring, not the whole string.
 *
 * @param CanvasKit the initialized CanvasKit module
 * @param fc the shared committed + fallback FontCollection
 * @returns {function} (text, style) → {width, ascent, descent}
 *
 * @example // const measure = makeSkiaRunMeasure(CanvasKit, fc);
 * @example // measure("Hello", {size: 36, bold: false, font: "inter"}) // {width: 92.4…, ascent: 34.9…, descent: 8.7…}
 * @example // measure("", {size: 36}) // {width: 0, ascent: <face ascent>, descent: <face descent>} — an empty run still has line metrics
 */
export function makeSkiaRunMeasure(CanvasKit, fc) {
  const cache = new Map(); // "text|size|bold|font|italic" → {width, ascent, descent} (LRU by insertion order)
  return (text, style) => {
    const size = style?.size ?? DEFAULT_TEXT_SIZE;
    const font = style?.font ?? "system";
    const bold = !!style?.bold, italic = !!style?.italic;
    const key = `${text}|${size}|${bold ? 1 : 0}|${font}|${italic ? 1 : 0}`;
    const hit = cache.get(key);
    if (hit) { cache.delete(key); cache.set(key, hit); return hit; }
    // ONE unbounded-width paragraph holding just this run: its max intrinsic
    // width IS the run's advance, and its line metrics are the face's ascent /
    // descent at this size. Built through the SAME buildParagraph the draw uses,
    // so the strut and the font-family chain are identical to the drawn stack.
    const { para } = buildParagraph(CanvasKit, fc, text.length ? [{ text, style: { size, font, bold, italic } }] : [], {}, Infinity, { size, font }, 1);
    const lm = para.getLineMetricsAt(0);
    const m = {
      width: para.getMaxIntrinsicWidth(),
      ascent: lm ? lm.ascent : size * 0.8,
      descent: lm ? lm.descent : size * 0.2,
    };
    para.delete();
    cache.set(key, m);
    while (cache.size > MEASURE_CACHE_MAX) cache.delete(cache.keys().next().value);
    return m;
  };
}

/**
 * Query→build (cached through getTextLayout). Builds THE shaped-placement
 * function core/glyph_outlines.js's `setGlyphShapedPlacement` takes: a text STATE
 * BAG → where the fill's own paragraph put each of its glyphs.
 *
 * The `makeSkiaRunMeasure` twin, installed from the same two bootstraps at the
 * same point for the same reason (the FontCollection must be ready). It exists so
 * that the GLYPH STROKE — whose outlines must come from fontkit, because
 * CanvasKit 0.41.1 has no glyph-outline API — is nonetheless PLACED by the engine
 * that draws the fill. `TextLayout.shapedGlyphs()`'s docblock carries the measured
 * disagreement this removes.
 *
 * The state bag is the same flat single-run shape `textMorphPayload` and
 * paint_skia's `textStateForOutlines` speak, so this converts it back into the op
 * `getTextLayout` wants. Going through `getTextLayout` (not a fresh build) is what
 * makes this cheap AND exact: on a stroked text op the fill has just built that
 * very layout, so this is a cache HIT on the identical Paragraph stack — the same
 * object, not an equal one.
 *
 * @param CanvasKit the initialized CanvasKit module
 * @param fc the shared committed + fallback FontCollection
 * @returns {function} (state) → [{glyphId, x, baselineY, size, font, bold}]
 *
 * @example // setGlyphShapedPlacement(makeSkiaShapedPlacement(CanvasKit, fc));
 * @example // makeSkiaShapedPlacement(CK, fc)({text: "Hi!", size: 96, font: "inter", w: 400, h: 200})
 * @example // // → [{glyphId: 21, x: 0, baselineY: 93, size: 96, font: "inter", bold: false}, …]
 */
export function makeSkiaShapedPlacement(CanvasKit, fc) {
  return (s) => getTextLayout(CanvasKit, fc, {
    text: String(s.text ?? ""),
    size: s.size ?? DEFAULT_TEXT_SIZE,
    font: s.font ?? "system",
    bold: !!s.bold,
    color: "#000000", // placement is colour-independent; a constant keeps the cache key stable
    // 0/absent means "no box" in the state bag and Infinity means it in the op —
    // the same translation textStateForOutlines makes in the other direction.
    boxW: (s.w ?? 0) > 0 ? s.w : Infinity,
    boxH: (s.h ?? 0) > 0 ? s.h : Infinity,
    // The PARAGRAPH style rides on boxStyle, which is where paraStyleFor already
    // looks for a box-level default. Spread conditionally so an absent key stays
    // absent rather than becoming an explicit undefined — a `{lineSpacing:
    // undefined}` in the op would change the layout CACHE KEY without changing the
    // layout, turning every stroked draw into a miss.
    boxStyle: {
      align: s.align ?? "left",
      valign: s.valign ?? "top",
      ...(s.lineSpacing !== undefined ? { lineSpacing: s.lineSpacing } : {}),
      ...(s.charSpacing !== undefined ? { charSpacing: s.charSpacing } : {}),
      ...(s.wordSpacing !== undefined ? { wordSpacing: s.wordSpacing } : {}),
    },
  }, 1).shapedGlyphs();
}

/** Distinct (substring, style) run measures held before the oldest is dropped.
 * Bounded for the same reason CACHE_MAX above is — a measure is a few numbers, so
 * this can be far larger than the Paragraph cache, but not unbounded: word-level
 * measuring means one entry per distinct word per style, and continuous editing
 * would otherwise accumulate one per keystroke prefix forever. */
const MEASURE_CACHE_MAX = 4096;

// ── the laid-out object (draw + geometry) ──────────────────────────────────────

/**
 * A built, laid-out paragraph stack for one text op. Owns the CanvasKit
 * Paragraph(s); the cache disposes it. Draw through draw(); query geometry in
 * LOCAL (op-relative) space with MODEL code-point offsets.
 */
export class TextLayout {
  constructor(CanvasKit, built, vOffset, totalH, opacity = 1) {
    this.CanvasKit = CanvasKit;
    this.built = built;      // [{para, height, text, textStart, charCount, yTop, glyphGroups}]
    this.vOffset = vOffset;  // local y the whole stack is shifted by (valign)
    this.totalH = totalH;    // total laid-out height (pre-valign)
    this.opacity = opacity;  // folded into the stroke/gradient glyph-pass alpha (Paragraph fill already folds it at build)
    this.disposed = false;   // true once the cache has evicted + freed this layout (see live())
  }

  /**
   * Query. Throws unless this layout is still LIVE — i.e. the cache has not
   * evicted and freed it out from under the caller. Every public reader below
   * calls it first.
   *
   * ── WHY THIS EXISTS (the `undefined.charCount` crash, 2026-08-21) ────────────
   * `getTextLayout`'s LRU calls `dispose()` on the victim past CACHE_MAX, which
   * DELETES the WASM Paragraphs and empties `built`. Its docblock therefore says
   * the caller must "fetch fresh each time geometry is needed" and never store
   * the object. A caller that stored one anyway — `web/TextEditController.svelte`
   * held it in a memoized Svelte `$derived`, which only recomputes when the
   * DOCUMENT changes, while eviction is driven by OTHER text ops the renderer
   * lays out — was left reading a freed layout. It failed as:
   *
   *     TypeError: Cannot read properties of undefined (reading 'charCount')
   *       at paraAndLocal   ← built[built.length - 1] on an EMPTY built
   *       at caretRect / wordAt
   *
   * An anonymous TypeError naming neither text, nor a layout, nor the contract it
   * broke — and it repeated ~100 times, once per caret recompute, on a real deck.
   *
   * THE EMPTY-TEXT CASE IS NOT THIS AND NEVER WAS: `splitParagraphs` returns
   * `[[]]` for no runs and `paragraphRanges` returns `[{start:0,end:0}]`, so a
   * built layout ALWAYS has at least one paragraph (an empty box is one empty
   * line, and its caret/word queries are answered honestly below). An empty
   * `built` therefore means exactly one thing — this layout was freed — which is
   * why the guard names that and nothing else. It is also why `paraAndLocal`'s
   * trailing `built[built.length - 1]` needs no length check of its own.
   */
  live() {
    if (this.disposed)
      throw new Error(
        "text_layout: this TextLayout was DISPOSED by getTextLayout's LRU cache and its CanvasKit Paragraphs are freed — " +
        "a caller stored the object instead of re-fetching it. The cache OWNS every layout it returns (see getTextLayout's " +
        "docblock): call getTextLayout(…) again at each geometry query — a hit is O(1) while the value is stable — rather " +
        "than holding the returned layout across other layouts being built.",
      );
    return this;
  }

  /** Command (draws each paragraph at its local yTop). Origin (ox,oy) is the op's
   * top-left (cmd.x, cmd.y); yTop already carries the valign offset.
   *
   * Draw order per paragraph (matches the SVG paint-order:stroke / PDF fill+stroke
   * export idiom): the OUTLINE stroke glyph pass FIRST (behind), then the
   * Paragraph (solid fill + decorations + highlight + emoji + fallback), then the
   * SHADER-FILL glyph pass on top of the (transparent-glyph) gradient AND material
   * pieces. With no outline/gradient/material piece every glyphGroups is empty and
   * this is exactly the historical single drawParagraph call (byte-identical).
   *
   * `aa` is THE camera's coverage-AA flag (render_settings.cameraAntialias): it
   * reaches the OUTLINE-stroke + SHADER-FILL glyph passes so "off" gives crisp,
   * jagged glyph edges. The plain Paragraph fill (canvas.drawParagraph) has no
   * per-draw coverage flag in CanvasKit, so solid un-outlined text keeps its
   * internal AA regardless — the toggle bites on outlines and shader-filled text. */
  draw(canvas, ox, oy, aa = true) {
    this.live();
    const CK = this.CanvasKit;
    for (const b of this.built) {
      const y = oy + b.yTop;
      for (const g of b.glyphGroups) drawGlyphOutline(CK, canvas, g, y, ox, this.opacity, aa);
      canvas.drawParagraph(b.para, ox, y);
      for (const g of b.glyphGroups) drawGlyphShaderFill(CK, canvas, g, y, ox, this.opacity, aa);
    }
  }

  /**
   * Query. WHERE THE FILL ACTUALLY PUT EVERY GLYPH — the shaped placement of
   * this laid-out text in LOCAL (op-relative) coordinates.
   *
   * ── WHY THIS EXISTS (workstream AN, 2026-08-02) ──────────────────────────────
   * The glyph STROKE traces real letterform outlines (fontkit, via
   * core/glyph_outlines.js) because CanvasKit 0.41.1 has no glyph-outline API.
   * Those outlines have to be PLACED, and until this method existed they were
   * placed by re-running core/richtext.layoutRichText — a SECOND layout engine,
   * over the injected ink measure. The two engines do not agree, and the
   * disagreement is measurable in three separate ways:
   *
   *   1. `para.getHeight()` is ROUNDED TO A WHOLE NUMBER while core keeps the
   *      exact `ascent + descent`. Measured on the committed faces: Inter@36
   *      44.000 vs 43.559, JetBrains Mono@36 48.000 vs 47.520 — so every line's
   *      baseline, and the valign offset derived from the stack height, differ by
   *      up to half a pixel. This is the residual sub-pixel drift.
   *   2. `lineSpacing` is distributed DIFFERENTLY. Core splits the extra leading
   *      half above / half below (`halfLeading`); CanvasKit's strut
   *      `heightMultiplier` puts effectively all of it above. Measured at
   *      lineSpacing 1.5, size 96: baseline 138.55 (paragraph) vs 122.04 (core) —
   *      a SIXTEEN PIXEL offset, and the visible half of the reported defect.
   *   3. Shaping itself. Core measures per WORD through the ink measure and lays
   *      pen positions out by summing advances; the paragraph shapes the whole run
   *      through HarfBuzz, so kerning pairs and ligatures land elsewhere.
   *
   * Reading the paragraph's OWN shaped runs removes all three at once, because
   * there is then only one layout: the stroke is placed by the very object that
   * drew the fill. That is why this is a method on TextLayout rather than a
   * standalone helper — the caller must not be able to ask about a layout other
   * than the one on screen.
   *
   * `getShapedLines()` reports each run's glyph ids plus ABSOLUTE (x, baselineY)
   * pairs relative to its paragraph's top-left, so the only arithmetic here is
   * adding the paragraph's own `yTop` (which already carries the valign offset).
   *
   * THE GLYPH IDS ARE PORTABLE. They index the resolved TYPEFACE, and measured
   * 2026-08-02 the committed TTFs give byte-identical ids under CanvasKit and
   * under fontkit — so an id is a usable name for a letterform in the outline
   * source, which is the whole reason this can be handed across the seam.
   *
   * Returns:
   *   Array<{glyphId, x, baselineY, size, font, bold}>: one entry per shaped
   *     glyph in draw order. `font`/`bold` name the RUN's requested face (what the
   *     outline source must load), not whatever face Skia fell back to — a glyph
   *     the requested face does not have comes back with an id the source refuses,
   *     which is the honest answer rather than a wrong letterform.
   *
   * @example // layout.shapedGlyphs() // [{glyphId: 21, x: 0, baselineY: 93, size: 96, font: "inter", bold: false}, …]
   */
  shapedGlyphs() {
    this.live();
    const out = [];
    for (const b of this.built) {
      const ranges = pieceCharRanges(b.pieces);
      for (const line of b.para.getShapedLines()) {
        for (const run of line.runs) {
          for (let i = 0; i < run.glyphs.length; i++) {
            const style = styleAtOffset(ranges, run.offsets[i]);
            out.push({
              glyphId: run.glyphs[i],
              x: run.positions[2 * i],
              baselineY: b.yTop + run.positions[2 * i + 1],
              size: run.size,
              font: style?.font ?? "system",
              bold: !!style?.bold,
            });
          }
        }
      }
    }
    return out;
  }

  /** Command (deletes the WASM Paragraphs). Called by the cache on eviction. */
  dispose() {
    for (const b of this.built) b.para.delete();
    this.built = [];
    this.disposed = true; // every reader below now throws a NAMED sentence — see live()
  }

  /** Query. The local y just below the last line (stack bottom incl. valign) —
   * how far down the text actually reaches. */
  get contentBottom() {
    this.live();
    return this.vOffset + this.totalH;
  }

  /** Query. The widest laid-out line width (LOCAL). For an auto-width (Infinity
   * boxW) op this is the real ink width; for a fixed box it is ≤ boxW. Used to
   * size the editor's pointer hit-surface for unbounded text. */
  contentWidth() {
    this.live();
    let w = 0;
    for (const b of this.built) w = Math.max(w, b.para.getMaxIntrinsicWidth());
    return w;
  }

  /** Query. Map a global MODEL code-point offset → {b, i, localCp}: the paragraph
   * it sits in and the local code-point offset within it. A caret at a paragraph's
   * end (before its "\n") stays in that paragraph; the next paragraph's start is
   * the offset AFTER the "\n". Past the end → the last paragraph's end; a negative
   * offset → the first paragraph's start (Math.max clamps localCp).
   *
   * The trailing `built[built.length - 1]` is TOTAL, not a hopeful read: a BUILT
   * layout always has ≥ 1 paragraph (splitParagraphs returns `[[]]` for no runs —
   * an empty box is one empty line), so the only empty `built` is a FREED layout,
   * and `live()` has already refused that above with a sentence naming it. */
  paraAndLocal(offset) {
    const built = this.live().built;
    for (let i = 0; i < built.length; i++) {
      const b = built[i];
      if (offset <= b.textStart + b.charCount) return { b, i, localCp: Math.max(0, offset - b.textStart) };
    }
    const last = built[built.length - 1];
    return { b: last, i: built.length - 1, localCp: last.charCount };
  }

  /** Query. Global MODEL code-point offset at a LOCAL point (click/drag hit-test).
   * Routes to the paragraph under localY (nearest if outside), clamps the coords
   * (Skia can crash on out-of-range), and maps the UTF-16 result back to a code
   * point. */
  offsetAtPoint(localX, localY) {
    const built = this.live().built;
    if (built.length === 0) return 0;
    let b = built.find((p) => localY >= p.yTop && localY < p.yTop + p.height);
    if (!b) b = localY < built[0].yTop ? built[0] : built[built.length - 1];
    if (b.charCount === 0) return b.textStart; // blank line: only one caret slot
    const CK = this.CanvasKit;
    const maxW = b.para.getMaxWidth();
    const x = Math.max(0, Math.min(localX, maxW > 0 ? maxW : localX));
    const y = Math.max(0, Math.min(localY - b.yTop, b.height - 1e-3));
    const pos = b.para.getGlyphPositionAtCoordinate(x, y).pos; // UTF-16
    return b.textStart + u16ToCp(b.text, pos);
  }

  /** Query. The caret rectangle (LOCAL) at a global MODEL offset: {x, top, h}. x
   * is the glyph-boundary edge (leading edge of the glyph at the offset, or the
   * trailing edge of the previous glyph at line/text end); the height is the
   * line's uniform (RectHeightStyle.Max) height. */
  caretRect(offset) {
    const { b, localCp } = this.paraAndLocal(offset);
    const CK = this.CanvasKit;
    if (b.charCount === 0) {
      const r = firstRect(b.para.getRectsForRange(0, 1, CK.RectHeightStyle.Max, CK.RectWidthStyle.Tight));
      if (r) return { x: r[0], top: r[1] + b.yTop, h: r[3] - r[1] };
      const lm = b.para.getLineMetricsAt(0);
      return { x: 0, top: b.yTop, h: lm ? lm.height : 0 };
    }
    if (localCp <= 0) {
      const u16End = cpToU16(b.text, 1);
      const r = firstRect(b.para.getRectsForRange(0, u16End, CK.RectHeightStyle.Max, CK.RectWidthStyle.Tight));
      if (r) return { x: r[0], top: r[1] + b.yTop, h: r[3] - r[1] }; // LEFT edge of first glyph
    } else {
      const u16Prev = cpToU16(b.text, localCp - 1);
      const u16Here = cpToU16(b.text, localCp);
      const r = firstRect(b.para.getRectsForRange(u16Prev, u16Here, CK.RectHeightStyle.Max, CK.RectWidthStyle.Tight));
      if (r) return { x: r[2], top: r[1] + b.yTop, h: r[3] - r[1] }; // RIGHT edge of the preceding glyph
    }
    // Fallback (e.g. trailing whitespace with no rect): line-metrics top/height at x 0.
    const lm = b.para.getLineMetricsAt(0);
    return { x: 0, top: b.yTop, h: lm ? lm.height : 0 };
  }

  /** Query. Selection highlight rectangles (LOCAL) for a global MODEL range
   * [lo, hi): one clean band per line via RectHeightStyle.Max (uniform height even
   * across mixed run sizes). Each paragraph the range intersects contributes its
   * own rects. Returns [{x, y, w, h}]. */
  selectionRects(lo, hi) {
    this.live();
    if (hi <= lo) return [];
    const CK = this.CanvasKit;
    const out = [];
    for (const b of this.built) {
      const s = Math.max(0, Math.min(lo - b.textStart, b.charCount));
      const e = Math.max(0, Math.min(hi - b.textStart, b.charCount));
      if (e <= s) continue;
      const sU16 = cpToU16(b.text, s), eU16 = cpToU16(b.text, e);
      for (const rd of b.para.getRectsForRange(sU16, eU16, CK.RectHeightStyle.Max, CK.RectWidthStyle.Tight)) {
        const [l, t, r, btm] = rd.rect;
        out.push({ x: l, y: t + b.yTop, w: r - l, h: btm - t });
      }
    }
    return out;
  }

  /** Query. The word boundary [start, end) (global MODEL offsets) around a global
   * offset — double-click word select, Ctrl/Alt+arrow word motion. */
  wordAt(offset) {
    const { b, localCp } = this.paraAndLocal(offset);
    if (b.charCount === 0) return { start: b.textStart, end: b.textStart };
    const textU16 = b.text.length;
    const u16 = Math.min(cpToU16(b.text, localCp), Math.max(0, textU16 - 1));
    const wb = b.para.getWordBoundary(u16); // {start, end} UTF-16
    return { start: b.textStart + u16ToCp(b.text, wb.start), end: b.textStart + u16ToCp(b.text, wb.end) };
  }

  /** Query. Vertical caret motion: the global MODEL offset one line up (dir=-1) or
   * down (dir=+1) from `offset`, preserving the caret's x (or an explicit goalX in
   * LOCAL space for repeated moves). Returns the same offset if there is no line
   * that way. */
  lineMove(offset, dir, goalX = null) {
    const c = this.caretRect(offset);
    const x = goalX != null ? goalX : c.x;
    const targetY = dir < 0 ? c.top - 1 : c.top + c.h + 1;
    if (targetY < 0 || targetY > this.totalH + this.vOffset) return offset;
    return this.offsetAtPoint(x, targetY);
  }
}

/** Pure function. The first RectWithDirection's [l,t,r,b] Float32Array, or null.
 *
 * @example firstRect([]) // null
 */
function firstRect(rects) {
  return rects && rects.length ? rects[0].rect : null;
}

/** Command (draws one glyph group's OUTLINE stroke, behind the fill). No-op when
 * the group's piece has no outline (outlineWidth <= 0). Stroke width is in LOCAL
 * units (the canvas is already view+world transformed) and the join is Skia's
 * default MITER — matching the SVG export's unset stroke-linejoin. `aa` is the
 * camera's coverage-AA flag: false ⇒ crisp, jagged glyph edges. */
function drawGlyphOutline(CanvasKit, canvas, group, y, ox, opacity, aa = true) {
  const width = group.style.outlineWidth ?? 0;
  if (!(width > 0)) return;
  const rgba = parseColor(group.style.outlineColor ?? "#000000");
  const paint = new CanvasKit.Paint();
  paint.setColor(CanvasKit.Color4f(rgba[0], rgba[1], rgba[2], rgba[3] * opacity));
  paint.setStyle(CanvasKit.PaintStyle.Stroke);
  paint.setStrokeWidth(width);
  paint.setAntiAlias(aa);
  const font = new CanvasKit.Font(group.typeface, group.size);
  canvas.drawGlyphs(group.glyphs, group.positions, ox, y, font, paint);
  font.delete();
  paint.delete();
}

/** Command (draws one glyph group's SHADER fill — gradient OR material — on top
 * of the transparent-glyph Paragraph pass). No-op when the piece's fill is solid
 * (a plain color): that fill is handled by the Paragraph, so an ordinary run's
 * render is byte-identical to before any of this existed.
 *
 * THE GLYPHS ARE THE MASK, and that is the whole trick — for BOTH kinds. There is
 * no clip, no offscreen and no mask filter here: `drawGlyphs` rasterizes the
 * glyph coverage and the Paint's shader supplies the colour at every covered
 * pixel, so the shader is seen through exactly the letterforms. A gradient and a
 * material differ ONLY in which shader is built; the masking is shared, which is
 * why extending gradient text to material text needed no new drawing machinery.
 *
 * `aa` is the camera's coverage-AA flag: false ⇒ crisp, jagged glyph edges. */
function drawGlyphShaderFill(CanvasKit, canvas, group, y, ox, opacity, aa = true) {
  const fill = group.style.color;
  if (!isGradientPaint(fill)) return;
  const bounds = glyphGroupBounds(group, ox, y, CanvasKit);
  // A MATERIAL is asked of the RAW paint (its shader is built from the sparse
  // {material:{id,params}} record, which parsePaint passes through untouched).
  if (isMaterialPaint(fill)) {
    drawGlyphShader(CanvasKit, canvas, group, y, ox, opacity, aa, materialShaderForGlyphs(CanvasKit, fill, bounds), true);
    return;
  }
  // EVERY OTHER KIND IS ROUTED ON THE **PARSED** PAINT, NOT THE RAW SHAPE, AND
  // THAT DISTINCTION IS THE BUG THIS GUARD FIXES (workstream TEXTCRASH) — asked
  // through runFillNeedsShader so this pass and textStyle's transparent-glyph
  // decision are literally the same predicate. See its docblock for why the raw
  // shape cannot answer it ({type:"none"} and {type:"solid"} are both objects that
  // skShaderForPaint refuses with "expected a gradient Paint").
  if (!runFillNeedsShader(fill)) return;
  const parsed = parsePaint(fill); // model gradient (string stops) → rgba stops
  drawGlyphShader(CanvasKit, canvas, group, y, ox, opacity, aa, skShaderForPaint(CanvasKit, parsed, bounds, opacity, canvas.getTotalMatrix()), false);
}

/** Command (draws one glyph group under a prepared shader Paint, then disposes the
 * shader). Split out of drawGlyphShaderFill so the material and gradient routes
 * share ONE drawing body — the masking was always identical between them, and only
 * the shader construction and the opacity handling differ.
 *
 * `materialOpacity` selects which of those two: a gradient folds `opacity` into its
 * stop alphas, so its Paint must NOT also carry it (that would square it); a
 * material's shader has no stops to fold into, so the Paint carries it — the same
 * split handleMaterialFill applies. */
function drawGlyphShader(CanvasKit, canvas, group, y, ox, opacity, aa, shader, materialOpacity) {
  // No null guard: BOTH builders either return a shader or throw with a reason
  // (materialShaderForGlyphs checks makeShader's result itself). A `if (!shader)
  // return` here would be dead code that reads like a real fallback — i.e. it
  // would suggest there is a silent-skip path when there is deliberately none.
  const p = new CanvasKit.Paint();
  p.setShader(shader);
  p.setStyle(CanvasKit.PaintStyle.Fill);
  // A gradient folds `opacity` into its stop alphas; a material's shader has no
  // stops to fold it into, so the Paint carries it. Same visual result, and it is
  // also what handleMaterialFill does (the blit applies opacity, never the raster).
  if (materialOpacity) p.setAlphaf(opacity);
  p.setAntiAlias(aa);
  const font = new CanvasKit.Font(group.typeface, group.size);
  canvas.drawGlyphs(group.glyphs, group.positions, ox, y, font, p);
  font.delete();
  p.delete();
  shader.delete();
}

/**
 * Query→build (compiles/caches the material's RuntimeEffect; the CALLER deletes
 * the returned shader). The Skia shader for a MATERIAL ink, framed on the GLYPH
 * AABB so the material's own geometry is the ink box rather than the whole
 * surface.
 *
 * SHARED BY BOTH GLYPH CONSUMERS — the text glyph pass here and the LaTeX
 * equation's shader ink (paint_skia drawLatexShaderInk). They mask differently
 * (text has no glyph-outline API in CanvasKit 0.41.1 so it masks through
 * drawGlyphs coverage; an equation has real outlines and clips to their union),
 * but the SHADER is the same question — "what does this material look like over
 * this ink box" — so it is answered once, here.
 *
 * ── WHY A FOREGROUND MATERIAL AND NOT A BACKDROP ONE ─────────────────────────
 * A FOREGROUND material (`backdrop: false` — comic, sky, metal, the pattern and
 * corkboard families) synthesizes its whole look from uniforms alone, with NO
 * children, so its shader is self-sufficient and can simply be handed to a Paint.
 * A BACKDROP material (glass, CRT, frosted) is defined as a function OF THE
 * COMPOSITE BENEATH IT: its SkSL declares the {blurredBackdrop, sharpBackdrop}
 * child pair, which only handleMaterialBackdrop can supply, because only it runs
 * the below-content re-render. Text has no such re-render at this seam — the glyph
 * pass draws inside an already-composited canvas — so a backdrop material is
 * REFUSED here with a sentence naming it, rather than compiled with missing
 * children (which returns a null shader and paints nothing at all: the silent
 * failure this codebase's paint-containment doctrine exists to forbid).
 *
 * SAMPLER (magnify) and PATTERN (vector_pattern) materials carry no SkSL and
 * dispatch their own ops, so they are refused for the same reason.
 *
 * ── THE UNIFORM FRAME ────────────────────────────────────────────────────────
 * A material's `pack(u)` wants the region resolved to DEVICE px — {cx, cy, halfW,
 * halfH, cornerRadius, angle} plus `scale`. This seam draws under the canvas's
 * CURRENT transform (view+world are already applied, exactly as the gradient pass
 * assumes), so `bounds` is in the same LOCAL space the glyphs are placed in and
 * is handed through unchanged. `scale: 1` says "one local unit is one shader
 * unit", which is the honest statement for a shader painted in this space; a
 * material with a world-locked pitch therefore keys off the text's own em box
 * rather than the camera, which is the behaviour that makes material text look
 * the same when you zoom.
 *
 * @param CanvasKit - the initialized CanvasKit module
 * @param {object} fill - a resolved material paint {type:"material", material:{id}, resolvedParams}
 * @param {{x:number, y:number, w:number, h:number}} bounds - the glyph group's AABB
 * @returns {object} a Skia shader (caller deletes)
 *
 * @example // materialShaderForGlyphs(CK, {type:"material", material:{id:"comic"}, resolvedParams:{…}}, {x:0,y:0,w:200,h:40})
 * @example // → a Skia shader painting the comic halftone across a 200x40 ink box
 */
export function materialShaderForGlyphs(CanvasKit, fill, bounds) {
  const id = fill.material?.id;
  const material = getMaterial(id); // LOUD on an unknown id — never a silently blank word
  if (!isFillCapableMaterial(material))
    throw new Error(`text_layout: the "${id}" material is not fill-capable (it declares no fillParams), so it cannot paint text — pick a material offered by the Color row's Mat tab`);
  if (isSamplerMaterial(material))
    throw new Error(`text_layout: "${id}" carries no SkSL (it is a sampler/pattern material that dispatches its own op), so it cannot be compiled as a text fill`);
  // A BACKDROP MATERIAL NEVER REACHES HERE ANY MORE, and the reason it is still
  // refused rather than deleted is that this seam genuinely still cannot draw one.
  // It has no below-content, no view and no device space, so compiling the shader
  // without its {blurredBackdrop, sharpBackdrop} children returns null and paints
  // NOTHING — the silent failure paint containment forbids.
  //
  // What changed in N2 is the ROUTING, not this limit: paint_skia's
  // opNeedsGlyphBackdrop intercepts a glyph-bearing op carrying a backdrop material
  // BEFORE the glyph pass runs, and handleGlyphBackdropMaterial draws it by clipping
  // the device canvas to the letterforms and running the ordinary backdrop
  // machinery inside — the same trick handleMaterialPaintShape has always used for
  // shapes. So "glassy text" works, and this line is now a BACKSTOP: if a future
  // caller reaches the glyph pass with a backdrop material it has bypassed that
  // route, and saying so loudly is better than painting an invisible word.
  if (isBackdropMaterial(material))
    throw new Error(`text_layout: "${id}" is a BACKDROP material and reached the GLYPH PASS, which cannot supply its {blurredBackdrop, sharpBackdrop} children. It should have been routed to paint_skia's handleGlyphBackdropMaterial (which clips the device canvas to the letterforms and runs the real backdrop machinery inside) — reaching here means opNeedsGlyphBackdrop did not fire for this op.`);
  // resolveMaterialPaint (render_gpu/ports.js, at scene-build time) is what fills
  // resolvedParams. Its absence means this paint skipped resolution, and a shader
  // packed from half a knob set renders confidently wrong — so it is a hard error,
  // the same contract every other material painter states.
  if (!fill.resolvedParams)
    throw new Error(`text_layout: the "${id}" material text fill carries no resolvedParams — it never went through ports.js resolveMaterialPaint, and packing an unresolved knob set would render wrong rather than fail`);
  // SCHEMA params are not UNIFORM params. A material's fillParams schema is the
  // AUTHORING vocabulary (named presets, colour strings, mode selectors); several
  // materials declare `toUniformParams` to translate it into the numeric knobs
  // their packer actually reads (metal's metalType → its reflectance triple, say).
  // Skipping that translation is why `metal` first failed here with "unsupported
  // color undefined" — the packer asked for a knob only the mapping produces.
  // handleMaterialPaintShape does exactly this for shapes; this is the same line.
  const params = material.toUniformParams ? material.toUniformParams(fill.resolvedParams) : fill.resolvedParams;
  const u = {
    cx: bounds.x + bounds.w / 2, cy: bounds.y + bounds.h / 2,
    halfW: bounds.w / 2, halfH: bounds.h / 2,
    cornerRadius: 0, angle: 0, scale: 1,
    ...params,
  };
  const effect = materialEffect(CanvasKit, material); // compiled once per material, memoized
  const shader = effect.makeShader(material.pack(u));
  if (!shader) throw new Error(`text_layout: material "${id}" makeShader returned null for a text fill`);
  return shader;
}

/** Pure function. The device-local AABB {x, y, w, h} covering a glyph group's
 * glyph origins plus one em of headroom, used as the gradient's objectBoundingBox
 * frame. Origins live in positions[]; a full glyph-outline bound would need per-
 * glyph metrics, so the em-padded origin span is a cheap, stable approximation
 * that keeps the gradient anchored to the drawn text. */
function glyphGroupBounds(group, ox, y, CanvasKit) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  const pos = group.positions;
  for (let i = 0; i < pos.length; i += 2) {
    minX = Math.min(minX, pos[i]); maxX = Math.max(maxX, pos[i]);
    minY = Math.min(minY, pos[i + 1]); maxY = Math.max(maxY, pos[i + 1]);
  }
  if (!Number.isFinite(minX)) { minX = 0; maxX = 0; minY = 0; maxY = 0; }
  const em = group.size;
  return { x: ox + minX, y: y + minY - em, w: (maxX - minX) + em, h: (maxY - minY) + em };
}
