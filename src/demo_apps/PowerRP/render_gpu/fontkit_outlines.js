/**
 * THE FONTKIT GLYPH-OUTLINE SOURCE — the render side's answer to core's
 * `setGlyphOutlines` seam, so a TEXT widget can morph.
 *
 * core/glyph_outlines.js declares the seam and argues for its shape; read that
 * header first. This module is the ONE implementation of it, shared by both
 * bootstraps (render_gpu/skia/browser_canvaskit.js and
 * render_gpu/skia/node_render.js) exactly as `makeSkiaRunMeasure` is shared for
 * the ink-metrics seam — same two install sites, same reason.
 *
 * ── WHY FONTKIT AND NOT CANVASKIT ────────────────────────────────────────────
 * Because CanvasKit cannot do it, measured against the pinned build. A
 * `CanvasKit.Font` in canvaskit-wasm 0.41.1 exposes getGlyphBounds, getGlyphIDs,
 * getGlyphIntercepts, getGlyphWidths and getMetrics — bounds and advances, no
 * outlines — and there is no `MakePathFromText`. 0.41.1 is also the LATEST
 * published version, so this is not a wait-for-an-upgrade situation. The full
 * measurement and the corroborating comment already in
 * render_gpu/skia/text_layout.js are recorded in core/glyph_outlines.js's header.
 *
 * `@pdf-lib/fontkit` is ALREADY a dependency of this app and already parses these
 * very files: render_gpu/pdf_backend.js registers it so pdf-lib can embed
 * subsetted TTFs. So this adds no dependency, no bundle weight the PDF path did
 * not already carry, and — the part that matters for correctness — it reads THE
 * SAME TTFs the renderer draws with (render_gpu/fonts.js fontFileFor). Same
 * files, same glyph ids, same outlines: a morph's first frame is the ink it
 * replaces.
 *
 * ── THE BYTES COME FROM THE CALLER ───────────────────────────────────────────
 * Loading is the one thing the two environments genuinely do differently (the
 * browser fetches a bundled URL, node reads a path), so this module takes a
 * `loadFontBytes(fontId, bold) -> Uint8Array|null` and owns everything after it.
 * That is the same injection shape render_gpu/pdf_backend.js already uses for
 * font bytes, for the same reason.
 *
 * ── UNITS ────────────────────────────────────────────────────────────────────
 * Outlines come back in FONT UNITS, y-UP from the baseline, which is a font
 * file's own convention and what fontkit reports. core/glyph_outlines.js owns the
 * conversion into the engine's y-DOWN box-local frame — deliberately, so two
 * installers cannot disagree about the flip. This module reports `unitsPerEm` and
 * otherwise does not think about frames.
 *
 * Different faces have different unitsPerEm (Inter is 2048, many are 1000), so
 * every glyph is normalized to a SINGLE reported em here rather than each caller
 * tracking per-face units. The normalization is one multiply on parse, memoized
 * with the outline.
 */

import { fontFileFor } from "./fonts.js";

/** The em size every outline this module returns is normalized to. 1000 is the
 * PostScript convention and the commonest real value, so the majority of faces
 * need no scaling at all; Inter's 2048 units are divided by 2.048 once per glyph
 * and then cached. The number itself is arbitrary — what matters is that ONE is
 * reported, so core/glyph_outlines.js can apply size/unitsPerEm as a single
 * multiply without asking which face a run resolved to. */
export const OUTLINE_UNITS_PER_EM = 1000;

/**
 * Query→build (parses font files on demand through the injected loader; memoizes
 * the parsed faces). Builds the glyph-outline SOURCE object
 * `core/glyph_outlines.setGlyphOutlines` takes.
 *
 * A FACE THAT WILL NOT LOAD YIELDS NO OUTLINES, and the caller's widget then
 * reports "not ready" rather than morphing — which is the honest answer and the
 * one core/glyph_outlines.js argues for at length: there is no approximate
 * letterform, so the alternatives to a real outline all render as a different
 * bug. The failure is reported once per face rather than per glyph, because a
 * missing face would otherwise print for every character of every run on every
 * frame of a scrub.
 *
 * `system` HAS NO FILE (fonts.js hasEmbeddableFile is false for it — the PDF
 * backend falls back to standard-14 there), so text in the default font cannot
 * morph. That is a real bound and it is stated in the report rather than hidden:
 * the fix an author has is to pick one of the committed families, which is a
 * one-click change on the row right above the interp select.
 *
 * Args:
 *   loadFontBytes (function): (fontId, bold) → Uint8Array|ArrayBuffer|null
 *   fontkit (object): the @pdf-lib/fontkit module (injected, because the browser
 *     imports it dynamically for code splitting and node requires it directly)
 *   report (function): (message) → void, for the once-per-face failure line
 *
 * Returns:
 *   {glyphPaths(text, style) -> [{d, advance}], unitsPerEm}
 *
 * @example // node: makeFontkitOutlines((id, bold) => fs.readFileSync(path.join(FONTS_DIR, fontFileFor(id, bold))), fontkit, console.warn)
 * @example makeFontkitOutlines(() => null, {create: () => null}, () => {}).unitsPerEm // 1000
 */
export function makeFontkitOutlines(loadFontBytes, fontkit, report = console.warn) {
  /** fontId|bold → a parsed fontkit font, or null when it could not be loaded.
   * `null` is CACHED as an answer so a missing face is attempted once. */
  const faces = new Map();

  const faceFor = (fontId, bold) => {
    const key = `${fontId}|${bold ? 1 : 0}`;
    if (faces.has(key)) return faces.get(key);
    let face = null;
    const file = fontFileFor(fontId, bold);
    if (!file) {
      report(
        `PowerRP glyph outlines: the font "${fontId}" has no committed TTF (fonts.js hasEmbeddableFile is false — ` +
        `"system" resolves to whatever the host provides), so TEXT IN IT CANNOT MORPH. It switches at the start of a ` +
        `transition instead. Pick a committed family on the widget's Font row to morph its type.`,
      );
    } else {
      const bytes = loadFontBytes(fontId, bold);
      if (!bytes) {
        report(`PowerRP glyph outlines: could not load "${file}" for font "${fontId}" — text in it cannot morph.`);
      } else {
        // A CORRUPT or unparseable face is a LOUD failure, not a silent skip: the
        // renderer is drawing with this same file, so a face that will not parse
        // here while drawing fine there is a real inconsistency worth seeing.
        face = fontkit.create(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
      }
    }
    faces.set(key, face);
    return face;
  };

  return {
    unitsPerEm: OUTLINE_UNITS_PER_EM,
    glyphPaths(text, style) {
      const face = faceFor(style.font ?? "system", !!style.bold);
      if (!face) return [];
      // fontkit's own SHAPING (layout) rather than a naive codepoint→glyph map:
      // it applies the face's substitutions, which is what makes a ligature or a
      // composed mark come out as the glyph the renderer actually draws. The
      // caller hands one character at a time (see core/glyph_outlines.js's
      // per-glyph memo), so in practice this is a one-glyph run.
      const k = OUTLINE_UNITS_PER_EM / face.unitsPerEm;
      const run = face.layout(text);
      return run.glyphs.map((g, i) => ({
        d: k === 1 ? g.path.toSVG() : g.path.scale(k, k).toSVG(),
        advance: run.positions[i].xAdvance * k,
      }));
    },
  };
}
