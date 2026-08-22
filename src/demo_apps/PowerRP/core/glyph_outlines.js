/**
 * GLYPH OUTLINES — the one injectable seam through which DOM-free core may ask
 * "what are the actual letterforms of this run?", so a TEXT widget can morph.
 *
 * ── WHY A SEAM, AND WHY A SECOND ONE ─────────────────────────────────────────
 * core/ink_metrics.js already injects a text MEASURE, and this is its exact twin
 * one level deeper: a measure answers "how wide is this run", this answers "what
 * SHAPE is it". Both are installed from the same two bootstraps
 * (render_gpu/skia/browser_canvaskit.js and render_gpu/skia/node_render.js) at
 * the same point, for the same reason — the answer needs real font faces, faces
 * live outside core/, and the consumer runs on a frame loop and cannot await.
 *
 * They are SEPARATE seams rather than one because they have different sources and
 * different availability, which the next paragraph is entirely about.
 *
 * ── CANVASKIT CANNOT DO THIS, AND THAT IS MEASURED, NOT ASSUMED ──────────────
 * The obvious implementation is CanvasKit's `Font.getPath` / `getGlyphPaths`, and
 * it does not exist. Measured against the pinned build (canvaskit-wasm 0.41.1,
 * which is also the LATEST published version — there is no upgrade to wait for):
 * a `Font` exposes exactly
 *
 *     getGlyphBounds, getGlyphIDs, getGlyphIntercepts, getGlyphWidths,
 *     getMetrics, getScaleX, getSize, getSkewX, getTypeface, is/set*
 *
 * — bounds and advances, no outlines. `CanvasKit.MakePathFromText` does not exist
 * either; `Path` can only be built from an SVG string, from verbs, or from
 * another path. render_gpu/skia/text_layout.js's own comment says the same thing
 * from the other side ("text has no glyph-outline API in CanvasKit 0.41.1 so it
 * masks through drawGlyphs coverage"), and that comment is why the glyph SHADER
 * pass is a coverage mask rather than a clip.
 *
 * So the outlines come from FONTKIT (`@pdf-lib/fontkit`), which is already a
 * shipped dependency of this app — render_gpu/pdf_backend.js registers it to
 * embed subsetted TTFs, so the PDF export already parses these very font files
 * for their glyph data. The installer reads THE SAME TTFs the renderer draws
 * with (render_gpu/fonts.js fontFileFor), which is what keeps a morph's first
 * frame aligned with the ink at alpha 0: same file, same glyph ids, same
 * outlines.
 *
 * ── THE FALLBACK IS A REFUSAL, NOT AN APPROXIMATION ──────────────────────────
 * ink_metrics falls back to a monospace ESTIMATE and says so, because an
 * approximate bounding box is still qualitatively right — it grows when the text
 * overflows. There is no such thing here. A morph has no approximate letterform:
 * the alternatives to a real outline are an empty payload (every contour
 * collapsing to a point, which renders as the text IMPLODING and reads as an
 * engine bug) or a box per glyph (which renders as the text turning into a row
 * of dominoes and reads as a rendering failure). Both are worse than not
 * morphing. So when no source is installed this module answers "not ready", the
 * widget's `morphNotReady` says which seam is missing, and core/derive.js's
 * existing pair policy falls back to the discrete switch and reports the reason
 * once. That is the whole no-silent-wrong-picture rule applied to a case where
 * there is genuinely nothing honest to draw.
 *
 * ── THE CACHE ────────────────────────────────────────────────────────────────
 * Outlines are memoized per (font, bold, glyph) in EM units — the registry
 * precedent (render_gpu/gpu/image_registry.js and friends). Keying on the EM
 * outline rather than the sized one is what makes the cache worth having: a
 * scrub over a font-size tween asks for the same letterforms at a hundred sizes,
 * and the size is one multiply at the end. The cache is a PERFORMANCE fact and
 * never a semantic one — clearing it changes no pixel.
 *
 * DOM-free. Imported by plugins (morphPaths) and by core; the installer is
 * called from the browser/node render side.
 */

import { reportOnce } from "./report.js";
import { richTextDraws } from "./richtext.js";
import { inkMeasure } from "./ink_metrics.js";
import { morphPayloadFromPaths } from "./morph_payload.js";
import { matMul, transformPathD } from "./svg_paths.js";

/**
 * The installed outline source, or null until a render side installs one.
 *
 *     {
 *       glyphPaths(text, style) -> [{d, advance}],   // EM units, y-UP baseline
 *       unitsPerEm: number,
 *     }
 *
 * `d` is a plain SVG path string in FONT UNITS with the baseline at y = 0 and
 * ink ABOVE it at POSITIVE y (a font file's own convention). `advance` is the
 * glyph's advance width in the same units. This module owns the conversion into
 * the engine's y-DOWN box-local frame, so an installer never has to think about
 * it and two installers cannot disagree about it.
 */
let _source = null;

/**
 * THE SHAPED-PLACEMENT SOURCE, or null — the answer to "where did the FILL
 * actually put each glyph?", installed beside the outline source by the same two
 * render bootstraps.
 *
 *     shapedGlyphs(state) -> [{glyphId, x, baselineY, size, font, bold}] | null
 *
 * in LOCAL (box-local, y-DOWN) coordinates, or null when this state cannot be
 * laid out through the fill's engine.
 *
 * ── WHY IT IS SEPARATE FROM THE OUTLINE SOURCE (workstream AN, 2026-08-02) ────
 * They come from DIFFERENT LIBRARIES and that is not incidental. The outlines
 * come from fontkit because CanvasKit 0.41.1 has no glyph-outline API; the
 * placement must come from CanvasKit because CanvasKit's paragraph is what draws
 * the fill, and THE FILL IS THE PICTURE'S AUTHORITY. Splitting them is what lets
 * each library answer the question it is actually the authority on, instead of
 * one of them answering both and being wrong about one.
 *
 * Before this existed, `textGlyphPathDs` placed fontkit's outlines by re-running
 * core/richtext.layoutRichText — a SECOND layout engine, over the injected ink
 * measure. render_gpu/skia/text_layout.js's `shapedGlyphs()` docblock carries the
 * three measured ways the two engines disagree (rounded paragraph heights,
 * lineSpacing leading distributed differently — 16 px at lineSpacing 1.5 — and
 * HarfBuzz shaping vs summed per-word advances). This seam is how the stroke
 * stops asking the wrong engine.
 *
 * NULL IS A REAL ANSWER, not a failure: bare-node doctests and any consumer that
 * has installed outlines without a render surface get it, and `textGlyphPathDs`
 * then falls back to the core layout and SAYS SO once. The fallback still draws
 * the right letters in the right order at the right size — it is the sub-pixel
 * baseline that is approximate — so refusing outright would be worse than
 * placing them the old way and reporting it.
 */
let _shaped = null;

/** The per-(font, bold, glyph) EM-unit outline memo. See the header. */
const _outlineCache = new Map();

/** Distinct glyph outlines held before the oldest is evicted. A deck's text uses
 * far fewer distinct glyphs than this across all its fonts (a full Latin set with
 * punctuation is well under 200 per face), so the bound exists to keep a long
 * session from growing without limit rather than to be hit while morphing. */
const OUTLINE_CACHE_LIMIT = 4096;

/**
 * Command (module-level state). Installs THE glyph-outline source every
 * `morphPaths` hook on a text widget will use. Called once by the render side
 * after its font files are available, alongside `setInkMeasure`.
 *
 * Passing null UNINSTALLS (back to the honest refusal) — that is what a teardown
 * does, and it is spelled explicitly rather than by omission. It also CLEARS the
 * cache, because a second install with different faces must not serve the first
 * one's letterforms.
 *
 * @param {?object} source - {glyphPaths(text, style) -> [{d, advance}], glyphPathById(id, style) -> string|null, unitsPerEm}
 * @returns {void}
 *
 * @example // at boot, once the TTF bytes are in hand:
 * @example // setGlyphOutlines(makeFontkitOutlines(loadFontBytes))
 * @example setGlyphOutlines(null) // uninstall — text stops offering to morph, loudly
 */
export function setGlyphOutlines(source) {
  if (source !== null && typeof source?.glyphPaths !== "function")
    throw new Error("setGlyphOutlines: expected a source with a glyphPaths(text, style) function, or null");
  _source = source;
  _outlineCache.clear();
  _byIdCache.clear();
}

/**
 * Command (module-level state). Installs THE SHAPED-PLACEMENT source — the query
 * that reports where the FILL put each glyph. See `_shaped`'s docblock for why
 * this is a second seam rather than a field on the outline source.
 *
 * Installed from the same two bootstraps, immediately after `setGlyphOutlines`,
 * so no consumer ever observes placement without outlines. Passing null
 * uninstalls, which is what a teardown does and what bare node leaves in place.
 *
 * @param {?function} shaped - (state) → [{glyphId, x, baselineY, size, font, bold}] | null
 * @returns {void}
 *
 * @example // setGlyphShapedPlacement((s) => getTextLayout(CK, fc, opFor(s)).shapedGlyphs())
 * @example setGlyphShapedPlacement(null) // uninstall — the stroke falls back to the core layout, loudly once
 */
export function setGlyphShapedPlacement(shaped) {
  if (shaped !== null && typeof shaped !== "function")
    throw new Error("setGlyphShapedPlacement: expected a shapedGlyphs(state) function, or null");
  _shaped = shaped;
}

/** The per-(font, bold, glyphId) EM-unit outline memo — the SHAPED path's twin of
 * `_outlineCache`, keyed by the id the paragraph reported rather than by the
 * character, because the shaped path never sees a character. Same size bound and
 * the same purely-performance status: clearing it changes no pixel. */
const _byIdCache = new Map();

/**
 * Query (reads module state). Is a REAL outline source installed? The one honest
 * way for a caller to know whether a text widget can morph at all — the
 * `hasInkMeasure` twin, and what plugins/plaintext.js `morphNotReady` asks.
 *
 * @returns {boolean}
 *
 * @example // setGlyphOutlines(null); glyphOutlinesReady() // false
 * @example // setGlyphOutlines(src); glyphOutlinesReady() // true
 */
export function glyphOutlinesReady() {
  return _source !== null;
}

/**
 * Query (reads the installed source; writes the memo). One run's glyph outlines
 * in EM units, cached per (font, bold, glyph).
 *
 * Returns [] with a report when nothing is installed. Callers that must not draw
 * an empty morph ask `glyphOutlinesReady()` FIRST — this function's empty answer
 * is for the caller that has already checked.
 *
 * @param {string} text - the run's characters
 * @param {object} style - {font, bold} (size is applied by the caller)
 * @returns {Array<{d: string, advance: number}>}
 *
 * @example // glyphOutlinesFor("hi", {font: "inter"}) // [{d: "M180 0L180 1490…", advance: 1129}, …]
 * @example glyphOutlinesFor("hi", {font: "inter"}).length // 0 (with no source installed)
 */
export function glyphOutlinesFor(text, style) {
  if (!_source) {
    reportOnce(
      "glyph-outlines-none",
      "PowerRP glyph_outlines: no glyph-outline source is installed (setGlyphOutlines was never called) — " +
      "TEXT WIDGETS CANNOT MORPH. They fall back to the discrete switch, which is the correct picture, not a broken one. " +
      "Install the seam from the render side if you expected text to morph here.",
    );
    return [];
  }
  const font = style.font ?? "system", bold = !!style.bold;
  const out = [];
  for (const ch of text) {
    const key = `${font}|${bold ? 1 : 0}|${ch}`;
    let hit = _outlineCache.get(key);
    if (hit === undefined) {
      // ONE character at a time, so the memo is per GLYPH and a run of "hello"
      // pays for four distinct letterforms rather than for the word. The source
      // is free to shape the whole string it is handed; here it is handed one.
      hit = _source.glyphPaths(ch, { font, bold })[0] ?? null;
      if (_outlineCache.size >= OUTLINE_CACHE_LIMIT) _outlineCache.delete(_outlineCache.keys().next().value);
      _outlineCache.set(key, hit);
    }
    if (hit) out.push(hit);
  }
  return out;
}

/**
 * Query (reads the installed outline source AND the installed ink measure).
 * A text state's laid-out letterforms as POSITIONED SVG PATH STRINGS in box-local
 * space — the raw geometry, before any consumer decides what to do with it.
 *
 * ── WHY THIS EXISTS SEPARATELY FROM textMorphPayload ─────────────────────────
 * It is the SHARED HALF of two features that want the same letterforms in two
 * different containers. `textMorphPayload` (below) wants them as a MorphPaths
 * payload — subpaths of cubic curves with re-derived windings — because the morph
 * engine interpolates control points. THE GLYPH STROKE wants them as plain `d`
 * strings, because the Skia painter builds an SkPath from an SVG string
 * (`Path.MakeFromSVGString`) and strokes it, and the SVG exporter writes the
 * string straight into a `<path>`. Converting a payload BACK into `d` strings to
 * stroke it would be a lossy round trip through a representation neither consumer
 * asked for.
 *
 * So the LAYOUT AND THE FRAME FLIP — the two things that are genuinely hard to get
 * right and catastrophic to get differently in two places — happen exactly ONCE,
 * here, and `textMorphPayload` is a thin wrapper over this. That is what makes it
 * structurally impossible for a stroked outline to sit anywhere other than
 * precisely on the morph's letterforms and on the drawn glyphs.
 *
 * ── THE PLACEMENT COMES FROM THE ENGINE THAT DREW THE FILL ───────────────────
 * (Workstream AN, 2026-08-02. This paragraph replaces one that claimed "the
 * layout is not re-derived" — it WAS re-derived, and that was the defect.)
 *
 * THE FILL IS THE PICTURE'S AUTHORITY, so the stroke moves to agree with it and
 * never the reverse. When the shaped-placement seam is installed (`_shaped`), the
 * glyph ids and their (x, baselineY) pairs come from THE VERY CanvasKit paragraph
 * that painted the fill, and each id is handed straight to the outline source.
 * There is then exactly ONE layout in the picture, so a stroke cannot drift from
 * its fill by construction rather than by the two engines happening to agree.
 *
 * Measured on the user-reported case ("Hi!", Inter): before, the stroke's
 * baseline came from core's exact `ascent + descent` while the fill's came from
 * `para.getHeight()`, which CanvasKit ROUNDS TO A WHOLE NUMBER — 116.156 vs
 * 116.000 at size 96, 43.559 vs 44.000 at size 36. Under `lineSpacing` the gap is
 * not sub-pixel at all: the two engines distribute the extra leading differently
 * and the baselines part by 16.5 px at lineSpacing 1.5, size 96.
 *
 * WITHOUT THE SEAM the old core-layout placement is used and REPORTED ONCE. That
 * path is what bare-node doctests and any outline-only consumer get; it draws the
 * right letters at the right size in the right order, and only the baseline is
 * approximate, so falling back beats refusing.
 *
 * ── THE FRAME FLIP, which is the one real conversion ─────────────────────────
 * A font's outlines are y-UP from the baseline (ink at POSITIVE y above it); the
 * engine's frame is y-DOWN box-local. So each glyph is baked through
 *
 *     scale(size/unitsPerEm, -size/unitsPerEm), translate to (penX, baselineY)
 *
 * — a NEGATIVE y scale, which is the flip, plus the run's own pen. Getting this
 * wrong renders every outline upside down, and it is easy to get wrong because
 * both conventions are "obviously" correct in their own world.
 *
 * Args:
 *   s (object): a text state bag ({text, size, font, bold, w, h, align, valign, opacity})
 *
 * Returns:
 *   {{ds: string[], baselineY: number}}: one `d` per glyph that HAS an outline (a
 *     space contributes none), in draw order, plus the FIRST line's baseline in
 *     box-local coordinates (diagnostics; no consumer needs it to place anything)
 *
 * @example // with the seam installed, two letters give two outlines:
 * @example // textGlyphPathDs({text: "hi", size: 36, w: 200, h: 60}).ds.length // 2
 * @example // a space has no ink, so "a b" still yields two:
 * @example // textGlyphPathDs({text: "a b", size: 36, w: 200, h: 60}).ds.length // 2
 * @example textGlyphPathDs({text: "hi", size: 36, w: 200, h: 60}).ds.length // 0 (with no source installed)
 */
export function textGlyphPathDs(s) {
  const shaped = _shaped?.(s) ?? null;
  if (shaped) return shapedGlyphPathDs(shaped);
  reportOnce(
    "glyph-outlines-unshaped",
    "PowerRP glyph_outlines: no SHAPED-PLACEMENT source is installed (setGlyphShapedPlacement was never called), so glyph " +
    "outlines are placed by core/richtext.layoutRichText instead of by the CanvasKit paragraph that draws the FILL. The " +
    "letters, their order and their size are right; their BASELINE is approximate, because the two engines round line " +
    "heights differently and distribute lineSpacing leading differently. A glyph STROKE placed this way can sit a fraction " +
    "of a pixel off its fill — visibly off under lineSpacing. Install the seam from the render side to place them exactly.",
  );
  return coreLayoutGlyphPathDs(s);
}

/**
 * Pure-ish (reads the installed outline source; writes the by-id memo). THE
 * SHAPED PATH: placements the fill's own engine reported → positioned `d`
 * strings.
 *
 * Each placement already carries the glyph's box-local pen (`x`) and its line's
 * baseline (`baselineY`) in the engine's y-DOWN frame, so the ONLY conversion
 * left is the y-UP → y-DOWN flip of the letterform itself — `scale(em, −em)`
 * about the pen. No advances are summed and no lines are measured here: doing
 * either would be re-deriving the layout, which is the thing this path exists
 * not to do.
 *
 * A glyph the requested face cannot supply (Skia fell back to another face for
 * it) yields no outline and is REPORTED, because stroking it from the wrong face
 * would draw a different letter than the fill shows.
 *
 * @param {Array<object>} placements - [{glyphId, x, baselineY, size, font, bold}]
 * @returns {{ds: string[], baselineY: number}}
 *
 * @example // shapedGlyphPathDs([{glyphId: 21, x: 0, baselineY: 93, size: 96, font: "inter", bold: false}]).ds.length // 1
 */
function shapedGlyphPathDs(placements) {
  const unitsPerEm = _source?.unitsPerEm ?? 1000;
  const ds = [];
  let missing = 0;
  for (const g of placements) {
    const d = glyphOutlineById(g.glyphId, { font: g.font, bold: g.bold });
    // AN EMPTY PATH IS A GLYPH WITH NO INK, NOT A MISSING ONE — and `!d` could not
    // tell them apart, which is why typing "Hello World" reported a glyph the font
    // could not draw. `render_gpu/fontkit_outlines.js glyphPathById` returns null
    // ONLY for an id the face does not have (the honest gap this counter exists
    // for) and "" for a real glyph whose outline is empty — a SPACE, in every
    // sentence anyone types. Conflating them made the loud "N shaped glyph(s) have
    // no outline in the run's OWN font" warning fire on ordinary text, which is the
    // worst thing a loud channel can do: cry wolf about the routine case until the
    // real one is not believed. (Measured against the committed TTFs: the sole
    // "missing" glyph in "Hello World" in Inter is the space.) Both still contribute
    // nothing to `ds`; only the null is COUNTED.
    if (d === null || d === undefined) { missing++; continue; }
    if (d === "") continue;
    const em = g.size / unitsPerEm;
    ds.push(transformPathD(d, matMul(
      { a: 1, b: 0, c: 0, d: 1, e: g.x, f: g.baselineY },
      { a: em, b: 0, c: 0, d: -em, e: 0, f: 0 },
    )));
  }
  if (missing > 0)
    reportOnce(
      "glyph-outlines-shaped-missing",
      `PowerRP glyph_outlines: ${missing} shaped glyph(s) have no outline in the run's OWN font — the renderer resolved ` +
      "them through a FALLBACK face, which the outline source cannot load. Those glyphs are FILLED but not outlined; " +
      "tracing them from the requested face would draw a different letter than the fill shows.",
    );
  return { ds, baselineY: placements[0]?.baselineY ?? 0 };
}

/**
 * Query (reads the installed source; writes the by-id memo). ONE glyph's EM-unit
 * outline BY ID, memoized per (font, bold, id). The shaped path's twin of
 * `glyphOutlinesFor`, which is by character.
 *
 * A source that predates the shaped path (no `glyphPathById`) answers null for
 * every id rather than throwing — the caller then reports a fully-unoutlined run
 * through the same missing-glyph line, which is the honest picture.
 *
 * @param {number} id - the glyph id the paragraph reported
 * @param {object} style - {font, bold}
 * @returns {?string} an SVG path in EM units, y-UP from the baseline, or null
 *
 * @example // glyphOutlineById(21, {font: "inter"}) // "M180 0L180 1490…"
 * @example glyphOutlineById(21, {font: "inter"}) // null (with no source installed)
 */
function glyphOutlineById(id, style) {
  if (typeof _source?.glyphPathById !== "function") return null;
  const font = style.font ?? "system", bold = !!style.bold;
  const key = `${font}|${bold ? 1 : 0}|${id}`;
  let hit = _byIdCache.get(key);
  if (hit === undefined) {
    hit = _source.glyphPathById(id, { font, bold }) ?? null;
    if (_byIdCache.size >= OUTLINE_CACHE_LIMIT) _byIdCache.delete(_byIdCache.keys().next().value);
    _byIdCache.set(key, hit);
  }
  return hit;
}

/**
 * Query (reads the installed source AND the ink measure). THE FALLBACK PATH:
 * outlines placed by core's own layout engine.
 *
 * This is what `textGlyphPathDs` did unconditionally before the shaped seam
 * existed, kept verbatim (and still exercised by every bare-node consumer) so a
 * host without a render surface still gets letterforms in the right places to
 * within the two engines' disagreement. `textGlyphPathDs` reports once before
 * calling it; see its docblock for what "within the disagreement" measures out to.
 *
 * @param {object} s - a text state bag
 * @returns {{ds: string[], baselineY: number}}
 *
 * @example // coreLayoutGlyphPathDs({text: "hi", size: 36, w: 200, h: 60}).ds.length // 2
 */
function coreLayoutGlyphPathDs(s) {
  const w = s.w ?? 0, h = s.h ?? 0;
  const unitsPerEm = _source?.unitsPerEm ?? 1000;
  const rich = {
    runs: [{
      text: String(s.text ?? ""),
      size: s.size ?? DEFAULT_MORPH_TEXT_SIZE,
      font: s.font ?? "system",
      bold: !!s.bold,
      color: s.fill ?? "#000000",
    }],
    // The PARAGRAPH style the state bag carries, so this path honours the same
    // lineSpacing/charSpacing/wordSpacing the shaped path does. It will still not
    // AGREE with the fill about them (the two engines distribute leading
    // differently — that is the disagreement above), but ignoring them outright
    // was strictly worse: it laid the run out at defaults the author had changed.
    paras: [{
      ...(s.lineSpacing !== undefined ? { lineSpacing: s.lineSpacing } : {}),
      ...(s.charSpacing !== undefined ? { charSpacing: s.charSpacing } : {}),
      ...(s.wordSpacing !== undefined ? { wordSpacing: s.wordSpacing } : {}),
    }],
  };
  // THE SAME box emit() lays out in — a 0/absent w means "no wrap" and a
  // 0/absent h means "no vertical box", mirrored from plugins/plaintext.js
  // rather than restated.
  const draws = richTextDraws(
    {
      rich, x: 0, y: 0,
      boxW: w > 0 ? w : Infinity,
      boxH: h > 0 ? h : Infinity,
      boxStyle: { align: s.align ?? "left", valign: s.valign ?? "top" },
      opacity: s.opacity ?? 1,
    },
    inkMeasure(),
  ).textDraws;
  const ds = [];
  for (const d of draws) {
    const glyphs = glyphOutlinesFor(d.text, { font: d.font, bold: d.bold });
    const em = d.size / unitsPerEm;
    let pen = d.x;
    for (const g of glyphs) {
      // y-UP EM units → y-DOWN box-local: scale (em, −em), then translate to the
      // pen and the shared line baseline.
      const m = matMul({ a: 1, b: 0, c: 0, d: 1, e: pen, f: d.baselineY }, { a: em, b: 0, c: 0, d: -em, e: 0, f: 0 });
      if (g.d) ds.push(transformPathD(g.d, m));
      pen += g.advance * em;
    }
  }
  return { ds, baselineY: draws[0]?.baselineY ?? 0 };
}

/**
 * Query (reads the installed outline source AND the installed ink measure).
 * THE TEXT MORPH PAYLOAD: a plaintext widget's state → its laid-out letterforms
 * as a MorphPaths payload in box-local space.
 *
 * A THIN WRAPPER over `textGlyphPathDs` — that function owns the layout and the
 * y-UP → y-DOWN frame flip (read its docblock for both); this one only decides
 * what CONTAINER the letterforms arrive in and what paint rides along. Sharing
 * the geometry is what guarantees a morph's letters and a stroked outline are the
 * same curves rather than two independent derivations that agree today.
 *
 * The flip `textGlyphPathDs` performs REVERSES every contour's winding, which is
 * correct and needs no correction here: core/morph_payload.js re-derives `winding`
 * from the baked coordinates with the same shoelace the engine re-derives with, so
 * the payload reports the winding its coordinates actually have.
 *
 * Args:
 *   s (object): a plaintext state bag ({text, size, font, bold, w, h, align, valign, fill, opacity})
 *
 * Returns:
 *   object: a MorphPaths payload, plus `baselineY` — the FIRST line's baseline in
 *     box-local coordinates, carried for tests and diagnostics rather than for
 *     the engine (which reads only space/subpaths/fillRule)
 *
 * @example // textMorphPayload({text: "hi", size: 36, w: 200, h: 60}).subpaths.length // 2
 * @example textMorphPayload({text: "hi", size: 36, w: 200, h: 60}).space // {w: 200, h: 60} (with a source installed)
 */
export function textMorphPayload(s) {
  const w = s.w ?? 0, h = s.h ?? 0;
  const { ds, baselineY } = textGlyphPathDs(s);
  // Glyphs are FILLED contours, never stroked: `strokeWidth: 0` here is about the
  // letterforms. The widget's own GLYPH STROKE (plugins/plaintext.js `glyphStroke`)
  // is a separate feature and is not carried into the morph — the stroked form
  // draws at the endpoints through emit(), so a morph interpolates the shapes and
  // the stroke re-appears when the tween lands.
  const paint = { fill: s.fill ?? "#000000", stroke: null, strokeWidth: 0, opacity: s.opacity ?? 1 };
  const payload = morphPayloadFromPaths(ds.map((d) => ({ d, paint })), { w, h }, "nonzero");
  // FONT-DERIVED OUTLINES ARE NONZERO-WOUND: a glyph's counters (the holes in
  // e/a/0/8) are wound opposite its outer contour, so nonzero leaves them as
  // holes — the same argument render_gpu/pdf_backend.js makes for filling these
  // glyphs with `f`.
  payload.baselineY = baselineY;
  return payload;
}

/** The size a text run morphs at when its state declares none — mirrors
 * render_gpu/skia/text_layout.js DEFAULT_TEXT_SIZE, restated here rather than
 * imported because that module is not DOM-free-importable from core/. */
const DEFAULT_MORPH_TEXT_SIZE = 36;
