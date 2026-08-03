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
 * @param {?object} source - {glyphPaths(text, style) -> [{d, advance}], unitsPerEm}
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
}

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
 * ── THE LAYOUT IS NOT RE-DERIVED ─────────────────────────────────────────────
 * The pen positions come from `richTextDraws` — the SAME pure layout the two
 * render backends already flatten through, over the SAME injected measure
 * (core/ink_metrics.js) that produced the widget's own ink bounds. So the outlines
 * sit exactly where the widget draws them: same wrap, same alignment, same valign
 * offset, same baselines.
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
    paras: [{}],
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
