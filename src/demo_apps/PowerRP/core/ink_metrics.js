/**
 * INK METRICS — the one injectable seam through which a DOM-free `localBounds`
 * hook may ask "how big is this text actually laid out?".
 *
 * ── THE PROBLEM IT SOLVES ─────────────────────────────────────────────────────
 * The BOUNDS protocol (core/view.js localBoundsOf) asks a plugin for the LOCAL
 * rect its INK occupies, and it asks from DOM-free core: culling, band select,
 * the copy/export capture rect and (now) hit testing all call it. A text widget's
 * ink is NOT its property box — type overflows the bottom of a too-short box, and
 * a single unbreakable word overflows its width. Until this seam existed,
 * plaintext declared no `localBounds` at all, so all four consumers used the
 * property box, and the user's report followed exactly from that:
 *
 *   "the text can go below the bottom of the text box and it's weird because
 *    then it gets culled … when I click the text, when the text is out of the
 *    box, it doesn't work."
 *
 * ── WHY A SEAM AND NOT A PURE FUNCTION ────────────────────────────────────────
 * The layout MATH is already pure and already shared: core/richtext.layoutRichText
 * wraps, aligns and stacks lines over an injected `measureRun(text, style) →
 * {width, ascent, descent}`. What is NOT pure is the MEASURE: a real glyph advance
 * needs a rasterized face, which lives in CanvasKit (browser + node) or canvas2D
 * (the PDF/SVG export seam, web/pdfFonts.measureText). Neither may be imported
 * from core/ — that is the DOM-free law, and CanvasKit additionally has to be
 * awaited before it can measure anything.
 *
 * So this module owns ONE module-level measure function and nothing else. The
 * render side installs the real one once its faces are loaded
 * (`setInkMeasure`); core asks for it synchronously per call. This is the same
 * shape as render_gpu/gpu/image_registry.js and video_registry.js — a
 * module-level registry that a DOM-free consumer reads and a browser-side owner
 * fills — chosen for the same reason: the consumer runs on a frame loop and
 * cannot await.
 *
 * ── THE FALLBACK IS LOUD, AND IT IS A REAL ANSWER, NOT A LIE ──────────────────
 * Before the real measure is installed (early boot; bare node with no CanvasKit;
 * a test), `inkMeasure()` returns core/richtext.monoMeasure — every glyph `size`
 * wide, ascent 0.8·size, descent 0.2·size — and reports ONCE that it did. That
 * matters: a fallback bound is APPROXIMATE, not correct, and something that is
 * approximate must say so. It is deliberately NOT the property box: the property
 * box is the exact wrong answer here (it is what produced the defect), whereas a
 * monospace estimate still grows when the text overflows, so culling and hit
 * testing behave qualitatively right while being quantitatively off. The report
 * names the seam so a reader knows which install site did not run.
 *
 * DOM-free. Imported by plugins (localBounds) and by core; the installer is
 * called from the browser/node render side.
 */

import { monoMeasure } from "./richtext.js";
import { reportOnce } from "./report.js";

/** The installed per-run measure, or null until a render side installs one.
 * (text, {size, bold, font, italic}) → {width, ascent, descent} in LOCAL units. */
let _measure = null;

/**
 * Command (module-level state). Installs THE per-run text measure every
 * `localBounds` hook will use. Called once by the render side after its faces are
 * loaded — render_gpu/skia/browser_canvaskit.js in the browser and
 * render_gpu/skia/node_render.js in bare node, so both the editor and the CLI
 * measure through the SAME faces they draw with.
 *
 * Passing null UNINSTALLS (back to the loud monospace fallback) — that is what a
 * teardown does, and it is spelled explicitly rather than by omission.
 *
 * @param {?function} measure - (text, {size, bold, font, italic}) → {width, ascent, descent}
 * @returns {void}
 *
 * @example // at boot, once CanvasKit's FontCollection is ready:
 * @example // setInkMeasure((str, st) => skiaRunMetrics(CanvasKit, fc, str, st))
 * @example setInkMeasure(null) // uninstall — subsequent bounds use monoMeasure and say so
 */
export function setInkMeasure(measure) {
  if (measure !== null && typeof measure !== "function")
    throw new Error(`setInkMeasure: expected a function or null, got ${typeof measure}`);
  _measure = measure;
}

/**
 * Query (reads module state; reports once on the fallback path). THE measure a
 * `localBounds` hook should lay text out with. Returns the installed measure, or
 * monoMeasure — having said so exactly once — when none is installed.
 *
 * @returns {function} (text, style) → {width, ascent, descent}
 *
 * @example // with a real measure installed, this IS that function:
 * @example // setInkMeasure(m); inkMeasure() === m // true
 * @example inkMeasure()("ab", { size: 10 }).width // 20 (the monospace fallback, when nothing is installed)
 */
export function inkMeasure() {
  if (_measure) return _measure;
  reportOnce(
    "ink-metrics-no-measure",
    "PowerRP ink_metrics: no text measure is installed (setInkMeasure was never called) — INK BOUNDS are falling back to a monospace ESTIMATE, so culling, hit testing and \"Set size to ink bounds\" will be approximate for text. Install the seam from the render side.",
  );
  return monoMeasure;
}

/**
 * Query. Is a REAL measure installed (as opposed to the monospace fallback)? The
 * one honest way for a caller to know whether an ink rect it just computed is
 * exact — used by the ghost overlay and the "Set size to ink bounds" command so
 * neither claims precision it does not have.
 *
 * @returns {boolean}
 *
 * @example // setInkMeasure(null); hasInkMeasure() // false
 * @example // setInkMeasure((t, s) => ({width: 0, ascent: 0, descent: 0})); hasInkMeasure() // true
 */
export function hasInkMeasure() {
  return _measure !== null;
}
