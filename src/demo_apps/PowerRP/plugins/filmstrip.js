/**
 * Filmstrip widget — a strip of frames from a VIDEO asset, laid out inside the
 * widget's bbox with the FAITHFUL film-strip LOOK of the original Figures
 * implementation (refs/Figures/film_strip/film_strip.py). The Python function's six
 * visual elements are reproduced here:
 *
 *   1. each frame gets ROUNDED CORNERS (a per-cell rounded-rect clip),
 *   2. each frame gets a GRAY OUTLINE hugging its rounded shape,
 *   3. transparent PADDING above/below the frames leaves two film BANDS,
 *   4. the frames sit on a colored strip (filmColor, default black),
 *   5. PERFORATION holes punched THROUGH each band so the canvas behind shows
 *      through (film sprocket holes), and
 *   6. the whole strip has ROUNDED CORNERS.
 *
 * ── WHERE THE FRAMES COME FROM: THE SCRUB PATH, ONE FRAME PER ELEMENT ─────────
 * Each frame is a `videoV5Frame` op — the SAME display-list op, and therefore the
 * same off-main-thread paused-decoder scrub path (render_gpu/skia/video_v5.js), that
 * the video SCRUBBER widget emits. This widget does NOT nest scrubber widgets and
 * does not import their plugin (the plugin fence); it reuses the CODE PATH by
 * emitting the same op N times at N different times, so N cells decode through one
 * shared registry, one LRU, and one seek mutex per source. Two cells at the SAME
 * time share ONE decoded frame for free (the media map keys frames by ref+time+wrap
 * — render_gpu/ir.videoV5FrameKey).
 *
 * THIS REPLACED A SERVER DEPENDENCY. Frames used to be pre-extracted stills fetched
 * from `GET /api/frames/<project>/<video>/<N>` and cached under assets/frames/, with
 * the URLs stored in a `frameUrls` state key an app-side effect filled. That is gone:
 * no backend round-trip, no on-disk cache to invalidate, no in-flight/processing or
 * fetch-error widget states, and — the point — the frames are now ORDINARY DOCUMENT
 * STATE, so they animate. A frame's time is a keyframable, equation-bindable leaf
 * like any other, so keyframing the times across slides makes the little frames scrub
 * as the slide tweens. There is deliberately NO autoplay clock: time is document
 * state (the core invariant), never a wall clock.
 *
 * ── THE FRAME LIST + ITS DEFAULT EQUATIONS ────────────────────────────────────
 * `frames` is a LIST property (core/lists.js, declared in core/properties.js PROPS
 * .frames): a SEQUENCE of TUPLE elements whose one field is `time` in seconds, with
 * the universal per-element `active` companion (`framesActive`) giving hide-vs-purge.
 * So the frame COUNT is the list's length — no second source of truth — and every
 * frame is individually keyframable, hideable and equation-bindable.
 *
 * Element i of a fresh N-frame strip defaults to the EQUATION
 *
 *     self.video_start + i/N * (self.video_end - self.video_start)
 *
 * (frameTimeEquation below), so ONE edit — `videoEnd` — spreads the whole strip
 * across a clip, and any single frame can still be overridden by typing over its own
 * equation. That is the list foundation's per-element-equation feature, used as a
 * DECLARATION rather than as special-case code.
 *
 * WHY i/N AND NOT i/(N-1) (i.e. frame 0 sits AT the start, and no frame sits exactly
 * at the end):
 *   - it reproduces what this widget already documented and did ("N frames sampled
 *     evenly, first→last"): the first cell shows the clip's opening frame, which is
 *     what a contact sheet is for;
 *   - i/(N-1) would ask for EXACTLY `videoEnd`, and seeking exactly to a clip's
 *     duration is undefined (past the last frame) — the reason the scrub path carries
 *     a SCRUB_END_EPSILON at all. i/N never requests the endpoint;
 *   - i/(N-1) divides by zero at N = 1, while i/N degenerates cleanly to a
 *     one-frame strip showing `videoStart`.
 * The span is therefore divided into N equal slots and each cell samples the START of
 * its slot.
 *
 * THE EQUATIONS BAKE i AND N, and that is deliberate. Re-deriving them from the live
 * list length would mean adding one frame silently RE-TIMES every existing frame,
 * which is exactly the override-ability the equations exist to provide. Insert/purge
 * therefore leave the other frames' times alone (an inserted element copies its
 * neighbour's equation — core/lists.insertedElement's documented behaviour for a
 * non-numeric field), and the `filmstrip-respace-frames` command rewrites every
 * element's equation for the CURRENT length in ONE undo unit when you do want them
 * evened out again.
 *
 * ── HOLE RENDERING (the WHY, per backend) ─────────────────────────────────────
 * The perforation holes must read as TRANSPARENT windows in all three backends
 * (GPU + PDF + SVG). NONE of the three has a native even-odd / mask / knockout
 * primitive (verified — see plugins/donut.js and core/outline.js: the raster crop
 * clip is a single rounded-rect SDF, the PDF backend only emits nonzero-winding
 * "W n"/"f", and the SVG backend emits a single-path <clipPath> with no fill-rule
 * hole). So — the same principle the DONUT widget uses for the identical "colored
 * shape with a transparent circular hole" — each film band is emitted as `polygon`
 * (triangle) ops that go AROUND the holes: the band is sliced into one column per
 * hole, and each column (rect minus one circle) is tessellated into quads between
 * the circle arc and the rect edges (perforatedBandPolygons/cellWithHole below — a
 * robust 4-sector split that avoids ear-clipper degeneracies). Because both raster
 * and vector backends consume the SAME `polygon` op vertex-for-vertex, they render
 * the SAME triangles — parity by construction, no shader/backend change, holes are
 * transparent because no triangle covers them.
 *
 * ── PER-FRAME ANCHORS (so an arrow can point at one cell) ─────────────────────
 * Beyond the widget's own bbox 9, EVERY visible frame exposes its own 9 anchors,
 * named `f{storedIndex}` + a standard bbox suffix (`f0tl`, `f2bm`, `f3cm`, …) — the
 * BENTO scheme (plugins/bento.js names grid cells `c{r}x{c}` + suffix) applied to a
 * one-dimensional strip, including its underscore-free constraint: the equation ref
 * grammar splits `<itemSlug>_<anchorId>` on the LAST "_", so an "_" inside an anchor
 * id would be mis-split and become unreferenceable.
 *
 * THE INDEX-REBINDING TRAP, and what is done about it. An anchor id is a STORED
 * reference (an arrow keeps `@strip_f2cm.x`), so an id keyed on a POSITION rebinds
 * the moment positions shift. Two decisions contain it:
 *   - the id uses the STORED index, never the visible position, so HIDING a frame
 *     rebinds NOTHING — which is precisely why hide exists (core/lists.js: "HIDE
 *     NEVER RENUMBERS"), and makes hide the safe way to take a frame out of a strip
 *     that has arrows attached;
 *   - a HIDDEN frame exposes no anchors at all, mirroring bento's rule that a cell
 *     absorbed by a span exposes none.
 * INSERT and PURGE do renumber, and this scheme inherits EXACTLY the exposure the
 * list foundation already documents for per-element equation paths (`frames.3.time`
 * means a different frame after a purge): one hazard, one pair of pure remaps
 * (core/lists.indexAfterPurge / indexAfterInsert), and the document-wide equation
 * rewrite that consumes them is the same single follow-up for both. A second,
 * anchor-specific identity scheme was rejected for that reason — and a generated
 * per-element id cannot live in a TUPLE element anyway (core/lists.js's identity
 * note), which is the storage form the tween rules force here.
 *
 * ── FILM GAUGE GEOMETRY (real millimetres, one data table) ────────────────────
 * The perforations are drawn to PUBLISHED SPECIFICATION dimensions, in millimetres,
 * from ONE data table — core/film.js PERF_FAMILIES — selected by the `perfFamily`
 * property. The strip's CROSS dimension IS the film's width, so every millimetre
 * becomes a fraction of it: hole size, corner radius and the band thickness all scale
 * together, which is why a 16 mm strip reads as visibly coarser than a 35 mm one at the
 * same on-screen size. A KS release-print perforation is a true rounded rectangle
 * (0.510 mm radius, published); a BH camera-negative perforation has straight long sides
 * and curved ends; and when a row asks for along == across == 2*radius the SAME function
 * draws a CIRCLE. ONE shape function serves them all (roundedRectBoundaryPoint), so no
 * format needs its own renderer and adding a format is DATA.
 *
 * THE HOLES ARE LOCKED TO THE PICTURES. Real film's frame pitch is an exact INTEGER
 * number of perforation pitches — 4 to a 35 mm frame, 3 or 2 under the shorter
 * pulldowns, 1 to a 16 mm frame — and the published millimetres agree (4 x 4.740 =
 * 18.96 mm, the 35 mm frame pitch). The widget's frame CELL is whatever size the bbox
 * and frame count give it, so holding the pitch at its published millimetres put a
 * non-integer 6.6 holes against every picture and the two rows drifted past each other.
 * The drawn pitch therefore divides the FRAME STEP by the format's perforations-per-frame
 * (perforationPitch), and the phase is measured from the first frame cell, so the holes
 * line up with the cells at every bbox and carry through the leader. The one format that
 * does NOT lock is the stylised DOTS row, whose dots were typeset at an absolute size and
 * never belonged to the pictures — core/film.js PITCH_BASES states which basis each row
 * uses, per row, with nothing to fall back to.
 *
 * THE AXES ARE FORMAT, NOT BRAND, and core/film.js records why: perforation families are
 * shared across manufacturers (Fuji's own print perforation is labelled "KS — Kodak
 * Standard"), base colour varies by film TYPE (orange-masked negative / grey B&W /
 * clear print), and the real manufacturer tell is EDGE-PRINT TEXT, which this widget
 * does not draw. So the `presets` below are FORMAT presets and no brand presets ship.
 * They vary the axes that are visible — PULLDOWN (4/3/2/1 perforations per picture),
 * SIDES (both edges vs one), GAUGE and hole SHAPE — because a preset set built on the
 * perforation family alone renders look-alikes: BH and KS pitch differ by 0.010 mm.
 * Every value is tagged PUBLISHED, MEASURED or ESTIMATE in the table; nothing is
 * presented as spec that is not.
 *
 * The remaining proportions — how the frames are laid out INSIDE the film base, and how
 * the base is rounded — are the drawing's own, not the film's, and live in STRIP_LOOK
 * (the original Python film_strip.py constants, normalized, labelled as such).
 *
 * ── LEADER AND TAIL (the strip must not end on a picture) ─────────────────────
 * A length of film has BLANK BASE before the first frame and after the last one, and
 * the perforated bands run right through it — that unphotographed run is what makes a
 * strip read as a piece of film rather than as a row of thumbnails. `leader` is that
 * run at BOTH ends, measured in INTER-FRAME GAPS (so 1 = "the same spacing as between
 * two frames", the default; 0 = flush, the old behaviour; larger = a longer head and
 * tail). It is a MULTIPLE of the gap rather than an absolute length so it survives
 * resizing: the gap is itself a fraction of a cell, so the whole layout stays similar
 * to itself as the strip grows. Only the FRAME layout insets — the film base and both
 * perforated bands still span the full strip, which is the entire point.
 *
 * ── PRESERVE ASPECT (default ON) ──────────────────────────────────────────────
 * A cell's shape is set by the STRIP's shape (cell height is the content band, cell
 * width is the strip's length divided among the frames), so scaling the widget used
 * to squash the pictures. `preserveAspect` (default true, the latex/svg/mermaid/cursor
 * spelling and default) letterboxes each frame UNIFORMLY inside its cell instead. It
 * rides on the `videoV5Frame` op (render_gpu/ir.js) and is honoured by the painter's
 * ONE shared quad body (render_gpu/skia/paint_skia.js drawSampledQuad), because THE
 * PLUGIN CANNOT DO IT: fitting needs the decoded frame's intrinsic pixel size, and
 * emit() is deliberately media-free and view-free (plugins/latex.js says so in as many
 * words). This is the latexVector/mermaidVector precedent — the op DECLARES
 * preserveAspect and whichever backend has the content's real size performs the fit.
 * The op's flag defaults to FALSE so the plain image/video/scrubber quads keep their
 * exact box→box stretch; only this widget opts in.
 *
 * ── OFFLINE / NO-SOURCE BEHAVIOR (the no-silent-fallback rule) ─────────────────
 * With no `src` the widget is a GHOST (the dashed-outline placeholder). With a src but
 * an EMPTY SPAN (videoEnd <= videoStart — the clip length has not been supplied, so
 * every default frame time collapses onto videoStart) it draws the real strip and
 * REPORTS once through core/report.js, the same channel every other widget's
 * degenerate-geometry notice uses (plugins/donut.js, plugins/fancy_arrow.js). It does
 * NOT paint a notice on the canvas: the widget is artwork, and an editor-time warning
 * scrawled across artwork ships in the export. The affordance the report points at is
 * the Inspector's own "Video end (s)" row, whose help text already explains it
 * (core/properties.js PROPS.videoEnd). A frame whose decode has not landed draws
 * nothing for that cell (the scrub path's async contract) and repaints when it does.
 *
 * ── CAPABILITIES ──────────────────────────────────────────────────────────────
 * bbox + transform + resizable + opacity, backdrop:false — like the image widget,
 * so it composites under magnifiers/blur and culls for free.
 */

import { standardBBoxAnchors } from "../core/derive.js";
import { closestPointOnRectBorder } from "../core/geometry.js";
import { PERF_FAMILIES, FILM_BASE_COLORS, DEFAULT_PERF_FAMILY, PITCH_BASES } from "../core/film.js";
import { visibleIndices } from "../core/lists.js";
import { bundle, bundleNestedDefaults, defaults, props } from "../core/properties.js";
import { reportOnce } from "../core/report.js";
import * as T from "../core/transform.js";
import { triangulated } from "../core/outline.js";
import { polygon, rect, videoV5Frame } from "../render_gpu/ir.js";
import { decorateStrokedBox } from "../render_gpu/decorate.js";
import { applyEffects, effectsCullMargin } from "../render_gpu/effects.js";

/** How many frames a freshly placed strip starts with. Six reads as a filmstrip at
 *  the default 480×90 bbox (each cell ≈ 77×62, near the 4:3 of a frame) while staying
 *  cheap to decode; every count after that is the user's, via the list's own
 *  insert/purge affordances. */
export const DEFAULT_FRAME_COUNT = 6;

/** Leader and tail length on a fresh strip, in INTER-FRAME GAPS — the user's
 *  "the same spacing between them by default". 1 gap at each end, and the property is
 *  free above that ("perhaps even more if we set it to be that way"). */
export const DEFAULT_LEADER_GAPS = 1;

/**
 * THE STOCK PRESETS — `{name, description, props}`, applied in ONE undo unit by the
 * Presets pane (web/ToolsPane.svelte → app.applyPreset; the crt/sky/lens-flare preset
 * precedent). ADDING A STOCK IS ONE DATA ENTRY: a name, a perforation family, and a
 * base colour. There is no code path per stock, and no preset writes any other key —
 * every other difference belongs in core/film.js's table, where the format lives.
 *
 * WHY THIS SET LOOKS DIFFERENT FROM THE ONE IT REPLACES. The previous five presets
 * varied ONE nearly-invariant axis (the perforation family) and rendered look-alikes:
 * three of them named "BH" and produced BYTE-IDENTICAL perforation geometry, and the
 * fourth ("KS") differed from them by 0.025 canvas units of pitch on the default 480x90
 * strip — a fifth of a pixel. The axes that actually vary are PULLDOWN (4 vs 3 vs 2 vs 1
 * perforations per picture), SIDES (both edges vs one), GAUGE and hole SHAPE, and this
 * set spans all four. Every pair below differs in the perforation family, in the base
 * colour, or in both; none differ only in wording.
 *
 * WHY THERE ARE STILL NO BRAND PRESETS. The two things this widget draws — perforation
 * geometry and base colour — do not vary by manufacturer: the perforation families are
 * shared (Fuji's own print perforation is "KS — Kodak Standard") and no maker publishes
 * a base colour, so a "Kodak vs Fuji" pair would be either identical or invented. What
 * genuinely distinguishes them is EDGE-PRINT TEXT (negative stock carries a keycode +
 * barcode; release print 2383 carries neither; print-stock edge print is set in RED so
 * it stays transparent to a red-illuminated soundtrack reader), and this widget draws no
 * edge text yet — so brand presets wait for that feature rather than shipping as
 * look-alikes.
 *
 * @example filmstripPlugin.presets.length // 9
 * @example filmstripPlugin.presets[0].props.perfFamily // "BH"
 */
const PRESETS = [
  {
    name: "Colour negative — 35 mm, 4-perf",
    description: "The standard camera negative: BH/\"N\" perforations (straight sides, curved ends), FOUR to a picture, on an orange-masked base.",
    props: { perfFamily: "BH", filmColor: FILM_BASE_COLORS.colorNegative },
  },
  {
    name: "B&W negative — 35 mm, 4-perf",
    description: "Black-and-white camera negative: the same four-per-picture BH/\"N\" perforations on a GREY acetate base (Double-X 5222, ORWO UN54).",
    props: { perfFamily: "BH", filmColor: FILM_BASE_COLORS.bwNegative },
  },
  {
    name: "3-perf 35 mm negative",
    description: "The 3-perf pulldown: a quarter shorter frame, so THREE perforations line up with each picture instead of four. Orange-masked base.",
    props: { perfFamily: "BH3", filmColor: FILM_BASE_COLORS.colorNegative },
  },
  {
    name: "Techniscope — 2-perf 35 mm",
    description: "The 2-perf/Techniscope pulldown: half-height frames and only TWO perforations per picture, so the holes read as widely spaced.",
    props: { perfFamily: "BH2", filmColor: FILM_BASE_COLORS.colorNegative },
  },
  {
    name: "Release print — 35 mm, 4-perf",
    description: "KS/\"P\" perforations — true rounded rectangles, 0.510 mm corner radius — on a clear base whose rebate reads near-black.",
    props: { perfFamily: "KS", filmColor: FILM_BASE_COLORS.print },
  },
  {
    name: "Intermediate — 35 mm, 4-perf",
    description: "Intermediate/dupe stock: BH/\"N\" perforations on the salmon-pink 2242 base, lighter between the frames than a release print's dense rebate.",
    props: { perfFamily: "KS", filmColor: FILM_BASE_COLORS.intermediate },
  },
  {
    name: "16 mm double-perf (2R)",
    description: "16 mm negative perforated on BOTH edges: one hole per picture, and the narrower gauge makes each hole proportionally far larger and further apart.",
    props: { perfFamily: "R16", filmColor: FILM_BASE_COLORS.colorNegative },
  },
  {
    name: "16 mm single-perf (1R)",
    description: "16 mm perforated on ONE edge only — the other edge is blank film, which is the most distinctive silhouette of any stock here.",
    props: { perfFamily: "R16S", filmColor: FILM_BASE_COLORS.bwNegative },
  },
  {
    name: "Dots — the stylised figure look",
    description: "Not a gauge: small ROUND holes at a fine absolute pitch on thin bands, measured off the original figure drawing this widget reproduces.",
    props: { perfFamily: "DOTS", filmColor: FILM_BASE_COLORS.print },
  },
];

/**
 * THE STRIP'S OWN look proportions — the parts of the drawing that are NOT film
 * dimensions: how the frames are laid out inside the film base, and how the base itself
 * is rounded. Fractions of the strip's SHORT (cross-axis) dimension, so they hold at any
 * bbox size. These are the original Python film_strip.py constants divided by its ~480px
 * reference cell — a faithful reproduction of THAT drawing, and labelled as such.
 *
 * @example STRIP_LOOK.frameGapFrac // 0.04
 * @example STRIP_LOOK.perfSegments // 8
 */
export const STRIP_LOOK = {
  /** Per-FRAME corner radius. 20/480. */
  frameRadiusFrac: 20 / 480,
  /** Whole-STRIP corner radius. 20/480. */
  stripRadiusFrac: 20 / 480,
  /** Gap between adjacent frames, as a fraction of a cell's LONG dimension. */
  frameGapFrac: 0.04,
  /** Boundary samples per perforation hole. A perforation is a ROUNDED RECTANGLE, so
   *  only its four corners are curved and only they need samples — 8 gives two per
   *  corner, which at a real hole's on-screen size (a few canvas units) is already past
   *  the point of visible faceting. It is also a per-paint TRIANGLE budget: every hole
   *  costs ~2x this many triangles in each of the three backends, and a 35 mm strip
   *  carries a hole every 4.75 mm of film. */
  perfSegments: 8,
  /** Per-frame outline colour + its width as a fraction of the frame corner radius. */
  frameOutline: "#808080",
  frameOutlineFrac: 0.1,
};

/**
 * THE PERFORATION FLOOR, in pixels — the size below which one perforation cannot
 * clear a single pixel, so drawing the perforated tessellation and drawing a solid
 * band produce THE SAME PICTURE. One pixel, and it is DERIVED, not chosen:
 *
 * THE UNIT. The document's own 1:1 output resolution is ONE PIXEL PER WORLD UNIT.
 * web/app.svelte.js exportPng renders THE camera at `Math.round(rect.w)` x
 * `Math.round(rect.h)` pixels, and exportPdf documents the same mapping ("the camera
 * rect IS the page (pt = world px)"). So a length of L LOCAL units on an item drawn at
 * world scale S measures L*S pixels when this document is output at 1:1.
 *
 * THE FLOOR. A perforation's SMALLEST dimension is min(alongMm, acrossMm) millimetres
 * and the mm → local scale is cross/filmWidthMm (the strip's CROSS dimension IS the
 * film's width), so the hole measures
 *
 *     min(alongMm, acrossMm) * (cross / filmWidthMm) * S   pixels.
 *
 * Requiring that to be at least one pixel gives the bound on the strip itself:
 *
 *     cross * S  >=  filmWidthMm / min(alongMm, acrossMm)
 *
 *         BH    35 / 1.854 = 18.9 units
 *         KS    35 / 1.981 = 17.7 units
 *         R16   16 / 1.270 = 12.6 units
 *
 * WHY THERE HAS TO BE A FLOOR AT ALL. The hole COUNT is (long/cross) * (filmWidthMm /
 * pitchMm) — a pure ASPECT-RATIO quantity, and physically right: a 35 mm strip ten
 * times longer than it is wide really does carry ~74 perforations. But it DIVERGES as
 * cross → 0, and the divergence is unbounded, not large: measured on a 400-unit strip,
 * cross 90 emits 1084 display-list ops, cross 2 emits 47296, and cross 0.5 emits ~190k
 * polygons and THROWS RangeError. Every one of those holes is far below one pixel, so
 * the cost buys no ink whatsoever. Refusing them is not a cap on the drawing; it is
 * declining to compute a picture that is identical to a cheaper one.
 *
 * WHY THE DOCUMENT'S RESOLUTION AND NOT THE VIEWPORT'S. The core invariant is
 * RenderTree = pure(document, [[slide, alpha]]). A floor read off the live zoom would
 * make the display list a function of the camera, so the editor and a headless render
 * would disagree about the same document. emit() is deliberately view-free (every
 * plugin's is), and this floor keeps it that way — it is a property of the DOCUMENT.
 * The consequence is honest and stated: zooming into a strip below the floor magnifies
 * SOLID bands, which is exactly what exporting that document would give you.
 */
export const PERF_FLOOR_PIXELS = 1;

/**
 * Command (mutates `target`). Appends every element of `items` to `target` and returns
 * `target`. NOT `target.push(...items)`: a spread becomes one ARGUMENT PER ELEMENT, and
 * this widget's band tessellation can produce six figures of them — measured, a 400x0.5
 * strip built ~190k polygon ops and `push(...)` threw RangeError: Maximum call stack
 * size exceeded, which is the crash the perforation floor now prevents upstream. The
 * floor makes that list small, but the append must not be the thing that decides how
 * large a display list this widget is allowed to build.
 *
 * @example appendAll([1], [2, 3]) // [1, 2, 3]
 * @example appendAll([], []) // []
 */
function appendAll(target, items) {
  for (const item of items) target.push(item);
  return target;
}

/**
 * Pure function. The default `time` EQUATION for element `i` of an `n`-frame strip:
 * the point i/n of the way across the `videoStart` → `videoEnd` span. See the module
 * header for why i/n (frame 0 at the start; no frame at the exact end; total at
 * n = 1). Display (snake_case) property spellings, which is what the equation grammar
 * reads (core/expressions.js pathToStored maps them to videoStart/videoEnd).
 *
 * @example frameTimeEquation(0, 6) // "self.video_start"
 * @example frameTimeEquation(1, 4) // "self.video_start + 1 / 4 * (self.video_end - self.video_start)"
 * @example frameTimeEquation(0, 1) // "self.video_start"
 */
export function frameTimeEquation(i, n) {
  if (i === 0) return "self.video_start";
  return `self.video_start + ${i} / ${n} * (self.video_end - self.video_start)`;
}

/**
 * Pure function. The DEFAULT frame list for an `n`-frame strip: one TUPLE element
 * per frame holding that frame's default time EQUATION. This is the value the plugin
 * default carries and the value `filmstrip-respace-frames` rewrites.
 *
 * @example defaultFrameList(1) // [["self.video_start"]]
 * @example defaultFrameList(2) // [["self.video_start"], ["self.video_start + 1 / 2 * (self.video_end - self.video_start)"]]
 * @example defaultFrameList(6).length // 6
 */
export function defaultFrameList(n) {
  const count = Math.max(1, Math.round(n));
  return Array.from({ length: count }, (_, i) => [frameTimeEquation(i, count)]);
}

/**
 * Pure function. The VISIBLE frames of a filmstrip state, as {index, time} pairs —
 * `index` the STORED element index (what an anchor id is keyed on, so hiding never
 * rebinds), `time` the evaluated seconds (equations are already numbers by the time
 * emit/anchors see state; a non-number reads as 0 rather than throwing, since a
 * half-typed equation must not crash the paint).
 *
 * Hidden elements are simply ABSENT — core/lists.js's "acts like it's not there"
 * rule, read through visibleIndices so this widget holds no second copy of the
 * absent-means-visible convention.
 *
 * @example visibleFrames({frames: [[0], [1.5]]}) // [{index: 0, time: 0}, {index: 1, time: 1.5}]
 * @example visibleFrames({frames: [[0], [1], [2]], framesActive: [true, false, true]}) // [{index: 0, time: 0}, {index: 2, time: 2}]
 * @example visibleFrames({frames: [["self.video_start"]]}) // [{index: 0, time: 0}] (an unevaluated equation reads as 0)
 * @example visibleFrames({}) // []
 */
export function visibleFrames(state) {
  const list = Array.isArray(state.frames) ? state.frames : [];
  return visibleIndices({ list, active: state.framesActive }).map((index) => {
    const time = list[index]?.[0];
    return { index, time: Number.isFinite(time) ? time : 0 };
  });
}

/**
 * Pure function. Left-to-right cell layout for `n` frames across width `w`, height
 * `h`, with frameGapFrac-of-a-cell gaps between them and a LEADER/TAIL of `leaderGaps`
 * such gaps at each end (see the header's LEADER AND TAIL section). Returns one
 * {x, w, h} rect per frame (y is 0).
 *
 * ONE closed form, no special case for n = 1: n frames leave n-1 inner gaps and 2
 * end runs, so the whole length is
 *
 *     w = n*cell + (n-1)*gap + 2*leaderGaps*gap,   gap = frameGapFrac*cell
 *
 * which solves for `cell` directly and degenerates correctly at n = 1 (no inner gaps,
 * both leaders still there) and at leaderGaps = 0 (the flush layout this replaced).
 *
 * @example filmstripLayout(3, 100, 40, 0).length
 * 3
 * @example filmstripLayout(1, 100, 40, 0)[0]
 * { x: 0, w: 100, h: 40 }
 * @example filmstripLayout(2, 104, 40, 0).map(c => Math.round(c.x))
 * [ 0, 53 ]
 * @example // one gap of leader at each end pulls the first frame in off the strip's edge:
 * @example filmstripLayout(1, 100, 40, 1).map(c => Math.round(c.x))
 * [ 4 ]
 */
export function filmstripLayout(n, w, h, leaderGaps) {
  const g = STRIP_LOOK.frameGapFrac;
  const lead = Math.max(0, leaderGaps ?? 0);
  const cell = w / (n + (n - 1) * g + 2 * lead * g);
  const step = cell * (1 + g);
  const x0 = lead * g * cell;
  return Array.from({ length: n }, (_, i) => ({ x: x0 + i * step, w: cell, h }));
}

/**
 * Pure function. The boundary point of an axis-aligned ROUNDED RECTANGLE centred at the
 * origin, along the ray at `angle`. Half-extents `hx`/`hy`, corner radius `r` (clamped
 * to at most the smaller half-extent, so r = min(hx, hy) is a stadium and r = hx = hy is
 * a circle). THE one shape function every perforation family needs: a KS print
 * perforation is a rounded rectangle with a published 0.510 mm radius, a BH negative
 * perforation is one with semicircular ends (r = half its short side), and a circle is
 * the fully-degenerate case — so no family needs its own renderer.
 *
 * EXACT, not iterated: the ray either crosses a straight side (then the crossing is a
 * plain division) or the corner arc (then it is the positive root of |t*d - c| = r).
 *
 * @example roundedRectBoundaryPoint(10, 10, 10, 0) // [10, 0] (a circle: radius along +x)
 * @example roundedRectBoundaryPoint(10, 4, 0, 0) // [10, 0] (a plain rect: the right side)
 * @example roundedRectBoundaryPoint(10, 4, 0, Math.PI / 2) // [0, 4] (a plain rect: the top side)
 * @example roundedRectBoundaryPoint(10, 4, 2, Math.PI).map(Math.round) // [-10, 0] (the left side, mid-height)
 */
export function roundedRectBoundaryPoint(hx, hy, r, angle) {
  const dx = Math.cos(angle), dy = Math.sin(angle);
  const ax = Math.abs(dx), ay = Math.abs(dy);
  const radius = Math.max(0, Math.min(r, hx, hy));
  const bx = hx - radius, by = hy - radius; // the inner box the corner discs sweep
  // A straight side, if the ray leaves through one: the crossing's OTHER coordinate must
  // still be inside the inner box, else the ray is heading for a corner arc.
  if (ax > 0) {
    const t = hx / ax;
    if (t * ay <= by) return [t * dx, t * dy];
  }
  if (ay > 0) {
    const t = hy / ay;
    if (t * ax <= bx) return [t * dx, t * dy];
  }
  // The corner arc: the disc centre is the inner box's corner on this ray's side.
  const cx = Math.sign(dx) * bx, cy = Math.sign(dy) * by;
  const dot = dx * cx + dy * cy;
  const t = dot + Math.sqrt(Math.max(0, dot * dot - (cx * cx + cy * cy - radius * radius)));
  return [t * dx, t * dy];
}

/**
 * Pure function. A rectangle [x0,y0]..[x0+w,y0+h] with a ROW of rounded-rectangle holes
 * punched out, returned as a triangle list (each triangle a 3-point polygon) so the
 * region can be drawn with the convex-only IR `polygon` op — the SAME "colored shape
 * with transparent holes" technique the donut uses (core/outline.donutOutline),
 * generalized from one circle to a row of perforations.
 *
 * Each hole gets its OWN cell rectangle (the band sliced into one column per hole), and
 * each column is tessellated as quads between the hole's boundary and the column's rect
 * edges (cellWithHole). Slicing per hole keeps every sub-region simple, and no triangle
 * covers a hole, so the canvas behind shows through in all three backends.
 *
 * Holes are centered across the band and spaced by `pitch`, the FIRST one `phase` in
 * from the band's start. Phase is what lets the row line up with the FRAMES rather than
 * with the strip's edge: filmstripGeom hands it the first frame cell's own offset plus a
 * half pitch, so a leader/tail carries the perforations along with the pictures instead
 * of leaving them behind. A band too thin for a whole hole returns one solid rect
 * (2 triangles) rather than a clipped perforation.
 *
 * Args:
 *   band ({x, y, w, h}): the band rectangle (local space, top-left origin)
 *   hole ({along, across, radius}): the hole's FULL size along the band (`along`) and
 *     across it (`across`), plus its corner radius — all in canvas units
 *   pitch (number): center-to-center spacing between holes along the band
 *   phase (number): the FIRST hole's center, as a distance in from the band's start
 *
 * Returns:
 *   number[][][]: array of triangles, each [[x,y],[x,y],[x,y]]
 *
 * @example perforatedBandPolygons({x: 0, y: 0, w: 100, h: 10}, {along: 0, across: 0, radius: 0}, 20, 10).length
 * 2
 * @example perforatedBandPolygons({x: 0, y: 0, w: 40, h: 10}, {along: 4, across: 6, radius: 1}, 20, 10).length > 2
 * true
 */
export function perforatedBandPolygons(band, hole, pitch, phase) {
  const { x, y, w, h } = band;
  if (w <= 0 || h <= 0) return [];
  const solidBand = () => triangulated([[x, y], [x + w, y], [x + w, y + h], [x, y + h]]);
  const halfAlong = (hole.along ?? 0) / 2, halfAcross = (hole.across ?? 0) / 2;
  // No room for a WHOLE hole → one solid rectangle (still parity-safe: 2 triangles).
  // A clipped perforation would be a different shape than the one declared, so the
  // honest degenerate is an unperforated band.
  if (halfAlong <= 0 || halfAcross <= 0 || pitch <= 0 || 2 * halfAcross >= h) return solidBand();
  const cy = y + h / 2;
  // Hole centers: the first at `phase`, stepping by pitch, keeping the whole hole inside.
  // The phase is wound back to the first WHOLE pitch inside the band so a phase larger
  // than one pitch (a long leader) still perforates the film ahead of the first frame —
  // real film's perforations do not begin where its pictures do.
  const centers = [];
  const first = phase - Math.floor(phase / pitch) * pitch;
  for (let cx = x + first; cx <= x + w - halfAlong; cx += pitch) {
    if (cx - halfAlong >= x) centers.push(cx);
  }
  if (centers.length === 0) return solidBand();
  // One column per hole; the column spans from the previous column boundary to the
  // midpoint to the next hole (so columns tile the band with no gaps/overlap).
  const tris = [];
  const bounds = centers.map((cx, i) => {
    const left = i === 0 ? x : (centers[i - 1] + cx) / 2;
    const right = i === centers.length - 1 ? x + w : (cx + centers[i + 1]) / 2;
    return { left, right, cx };
  });
  for (const { left, right, cx } of bounds) {
    tris.push(...cellWithHole(left, y, right - left, h, cx, cy, halfAlong, halfAcross, hole.radius ?? 0));
  }
  return tris;
}

/**
 * Pure function. One rectangle cell [rx,ry,rw,rh] with a single ROUNDED-RECTANGLE hole
 * removed (centre cx,cy, half-extents hx/hy, corner radius r), as a triangle list.
 * Instead of ear-clipping a rect-with-a-hole polygon (whose straight edges + duplicated
 * bridge vertex stall the strict ear-clipper), the annular region is split into FOUR
 * SECTORS by the rays from the hole centre to the four rect corners. Each sector's outer
 * boundary is exactly ONE flat rect edge (no corner between its two bounding rays), so
 * quads between the hole's boundary and that edge tile the sector with no corner-cutting.
 * The hole's boundary stays ANGLE-monotone and convex (roundedRectBoundaryPoint), which
 * is what makes the sector pairing valid for a rounded rect exactly as it was for a
 * circle. A hole that doesn't fit degenerates to the solid rect (2 triangles). Not
 * exported — internal to perforatedBandPolygons.
 *
 * @example cellWithHole(0, 0, 20, 10, 10, 5, 0, 0, 0).length
 * 2
 * @example cellWithHole(0, 0, 20, 10, 10, 5, 3, 2, 1).length > 8
 * true
 */
function cellWithHole(rx, ry, rw, rh, cx, cy, hx, hy, r) {
  const solid = () => triangulated([[rx, ry], [rx + rw, ry], [rx + rw, ry + rh], [rx, ry + rh]]);
  if (hx <= 0 || hy <= 0 || cx - hx < rx || cx + hx > rx + rw || cy - hy < ry || cy + hy > ry + rh) return solid();
  const corners = [
    [rx + rw, ry], [rx + rw, ry + rh], [rx, ry + rh], [rx, ry], // TR, BR, BL, TL
  ];
  const ang = corners.map((c) => Math.atan2(c[1] - cy, c[0] - cx));
  const onHole = (a) => {
    const [px, py] = roundedRectBoundaryPoint(hx, hy, r, a);
    return [cx + px, cy + py];
  };
  const tris = [];
  for (let e = 0; e < 4; e++) {
    let a0 = ang[e], a1 = ang[(e + 1) % 4];
    while (a1 <= a0) a1 += 2 * Math.PI; // increasing arc (CCW on a y-down screen)
    const c0 = corners[e], c1 = corners[(e + 1) % 4];
    const steps = Math.max(2, Math.round((STRIP_LOOK.perfSegments * (a1 - a0)) / (2 * Math.PI)));
    for (let i = 0; i < steps; i++) {
      const t0 = i / steps, t1 = (i + 1) / steps;
      const in0 = onHole(a0 + (a1 - a0) * t0);
      const in1 = onHole(a0 + (a1 - a0) * t1);
      const out0 = [c0[0] + (c1[0] - c0[0]) * t0, c0[1] + (c1[1] - c0[1]) * t0];
      const out1 = [c0[0] + (c1[0] - c0[0]) * t1, c0[1] + (c1[1] - c0[1]) * t1];
      tris.push([in0, in1, out1], [in0, out1, out0]);
    }
  }
  return tris;
}

/**
 * Pure function. The drawn centre-to-centre perforation spacing for one film format, in
 * canvas units. TWO BASES and no third — core/film.js PITCH_BASES, stated per row so
 * there is nothing to fall back to:
 *
 *   "frame" — REAL PERFORATIONS, locked to the pictures: the drawn frame step divided by
 *     the format's published perforations-per-frame. This is the relationship the
 *     complaint "the holes don't respect the positions of the actual film images" names.
 *   "film" — A DECORATIVE PATTERN: the film's own published pitch, already scaled to
 *     canvas units by the caller, ignoring the frames. Only the stylised DOTS row.
 *
 * An unknown basis THROWS rather than picking one: a format row with no basis is a data
 * bug in core/film.js, and guessing would silently draw the wrong film.
 *
 * @example perforationPitch({pitchBasis: "frame", perfsPerFrame: 4}, 80, 12.19) // 20 (four holes per picture)
 * @example perforationPitch({pitchBasis: "frame", perfsPerFrame: 1}, 80, 12.19) // 80 (one hole per picture — 16 mm)
 * @example perforationPitch({pitchBasis: "film", perfsPerFrame: 19}, 80, 6.43) // 6.43 (the frames are ignored)
 */
export function perforationPitch(fam, frameStep, filmPitch) {
  if (fam.pitchBasis === "film") return filmPitch;
  if (fam.pitchBasis !== "frame")
    throw new Error(`filmstrip: film format "${fam.title}" has pitchBasis ${JSON.stringify(fam.pitchBasis)}; core/film.js PITCH_BASES are ${PITCH_BASES.join(" / ")}`);
  if (!(fam.perfsPerFrame >= 1))
    throw new Error(`filmstrip: a "frame"-basis film format needs perfsPerFrame >= 1, "${fam.title}" has ${JSON.stringify(fam.perfsPerFrame)}`);
  return frameStep / fam.perfsPerFrame;
}

/**
 * Pure function. The filmstrip's LAID-OUT geometry in local (bbox) space,
 * accounting for orientation. The two film BANDS (with sprocket holes) run along
 * the two LONG edges; frames tile along the long axis between them:
 *   HORIZONTAL — bands at TOP and BOTTOM (full width, bandThick tall), frames
 *     tile left→right in the middle row. Band thickness scales with HEIGHT.
 *   VERTICAL — bands at LEFT and RIGHT (full height, bandThick wide), frames
 *     tile top→bottom in the center column (the Python original's rotate/compose/
 *     rotate, expressed directly). Band thickness scales with WIDTH.
 * ONE geometry decision, not scattered through emit().
 *
 * `frameCount` is passed EXPLICITLY (not read off `state.frames`, which is now the
 * frame LIST rather than a count) so the caller decides whether it is laying out the
 * VISIBLE frames or all of them — the strip closes over a hidden frame, so those are
 * different numbers and the choice must be the caller's, in one place.
 *
 * Returns { frames:[{x,y,w,h}], bandA, bandB, contentRect, perf:{r,pitch,axis},
 *   frameRadius, radius } — all rects {x,y,w,h} in local space; the two bands are
 *   `bandA`/`bandB`; `contentRect` is where the frames sit; `perf.axis` is the
 *   axis holes run along ("x" horizontal band, "y" vertical band).
 *
 * @example filmstripGeom({w: 480, h: 90, vertical: false}, 3).frames.length
 * 3
 * @example filmstripGeom({w: 90, h: 480, vertical: true}, 3).frames.length
 * 3
 * @example filmstripGeom({w: 90, h: 480, vertical: true}, 3).perf.axis
 * 'y'
 * @example // the leader/tail pulls the first cell in off the strip's own edge:
 * @example filmstripGeom({w: 480, h: 90, leader: 1}, 3).frames[0].x > 0
 * true
 */
export function filmstripGeom(s, frameCount) {
  const w = s.w ?? 0, h = s.h ?? 0;
  const n = Math.max(1, Math.round(frameCount ?? 1));
  const vertical = !!s.vertical;
  // CROSS dimension = the axis the FILM WIDTH maps onto (h for horizontal, w for
  // vertical). LONG dimension = the axis frames tile along, i.e. film TRAVEL.
  const long = vertical ? h : w;
  const cross = vertical ? w : h;
  // THE mm → canvas-unit scale: the strip's CROSS dimension IS the film's width, so
  // every published millimetre becomes a fraction of it. This is what makes the
  // perforation size, pitch and corner radius REAL rather than chosen, and what makes a
  // 16 mm strip read as coarser than a 35 mm one at the same on-screen size.
  const fam = PERF_FAMILIES[s.perfFamily] ?? PERF_FAMILIES[DEFAULT_PERF_FAMILY];
  const perMm = cross / fam.filmWidthMm;
  const perfAcross = fam.acrossMm * perMm;
  const perfAlong = fam.alongMm * perMm;
  const perfRadius = fam.cornerRadiusMm * perMm;
  const filmPitch = fam.pitchMm * perMm;
  // The band carries the perforation row plus its inset from the film edge; whatever is
  // left across the middle is the image area.
  const bandThick = fam.edgeInsetMm * perMm + perfAcross;
  const radius = cross * STRIP_LOOK.stripRadiusFrac;
  // LEADER/TAIL insets the FRAME run only — the film base and both perforated bands
  // still span the whole strip, which is what makes the ends read as blank film.
  const leader = s.leader ?? DEFAULT_LEADER_GAPS;
  // THE PERFORATIONS ARE LOCKED TO THE PICTURES (core/film.js PITCH_BASES "frame").
  // On real film the frame pitch IS an exact integer number of perforation pitches — 4
  // to a 35 mm frame, 3 or 2 under the shorter pulldowns, 1 to a 16 mm frame — and the
  // published millimetres agree (4 x 4.740 = 18.96 mm, the 35 mm frame pitch). The
  // widget's frame CELL, though, is whatever size the user's bbox and frame count give
  // it, so the film is effectively stretched along its length; holding the pitch at its
  // published millimetres while the frames stretch is what made the holes drift past
  // every frame boundary at a non-integer 6.6 per picture. Dividing the CELL STEP
  // instead restores the integer exactly, at every bbox.
  //
  // The long-axis run is recomputed here rather than read out of the branches below,
  // which need the cross dimension the pitch does not: filmstripLayout's x/w depend only
  // on (n, long, leader), so this is the same pure call with the same arguments, not a
  // second copy of the layout rule.
  const run = filmstripLayout(n, long, cross, leader);
  const step = run.length > 1 ? run[1].x - run[0].x : run[0].w;
  const perfPitch = perforationPitch(fam, step, filmPitch);
  // THE PHASE: half a pitch into the FIRST FRAME CELL, so a leader/tail carries the
  // perforation row along with the pictures instead of leaving it pinned to the strip's
  // edge. perforatedBandPolygons winds it back into the first whole pitch, so the film
  // ahead of the first frame is perforated too.
  const perf = {
    along: perfAlong, across: perfAcross, radius: perfRadius,
    pitch: perfPitch, phase: run[0].x + perfPitch / 2,
    filmPitch, sides: fam.perfSides,
  };
  if (vertical) {
    const contentW = Math.max(0, w - 2 * bandThick);
    // Frames tile top→bottom in the center column (long axis = h).
    const cells = filmstripLayout(n, h, contentW, leader).map((c) => ({ x: bandThick, y: c.x, w: contentW, h: c.w }));
    return {
      frames: cells,
      bandA: { x: 0, y: 0, w: bandThick, h },          // left band
      bandB: { x: w - bandThick, y: 0, w: bandThick, h }, // right band
      contentRect: { x: bandThick, y: 0, w: contentW, h },
      perf: { ...perf, axis: "y" },                      // holes run vertically
      frameRadius: contentW * STRIP_LOOK.frameRadiusFrac,
      radius,
    };
  }
  const contentH = Math.max(0, h - 2 * bandThick);
  // Frames tile left→right in the middle row (long axis = w).
  const cells = filmstripLayout(n, w, contentH, leader).map((c) => ({ x: c.x, y: bandThick, w: c.w, h: contentH }));
  return {
    frames: cells,
    bandA: { x: 0, y: 0, w, h: bandThick },          // top band
    bandB: { x: 0, y: h - bandThick, w, h: bandThick }, // bottom band
    contentRect: { x: 0, y: bandThick, w, h: contentH },
    perf: { ...perf, axis: "x" },                      // holes run horizontally
    frameRadius: contentH * STRIP_LOOK.frameRadiusFrac,
    radius,
  };
}

/**
 * Pure function. One perforation's SMALLEST dimension in PIXELS at the document's own
 * 1:1 output resolution — the quantity PERF_FLOOR_PIXELS is compared against (see its
 * derivation). `perf` is a filmstripGeom perf record (LOCAL units); `scale` is the
 * item's world scale, which is what turns a local length into a document pixel.
 *
 * @example perforationPixels({along: 4.77, across: 7.19}, 1) // 4.77
 * @example perforationPixels({along: 4.77, across: 7.19}, 0.25) // 1.1925 (a quarter-scale strip)
 * @example perforationPixels({along: 0.106, across: 0.16}, 1) // 0.106 (a 400x2 strip: far below the floor)
 */
export function perforationPixels(perf, scale) {
  return Math.min(perf.along, perf.across) * (scale ?? 1);
}

/**
 * Pure function. Are this strip's perforations big enough to be worth punching — i.e.
 * does one hole cover at least PERF_FLOOR_PIXELS at the document's 1:1 output size?
 * Below the floor the perforated band and a solid band are the SAME PICTURE, and the
 * hole count diverges, so the honest answer is the solid band (emit() reports it).
 *
 * @example perforationsResolve(filmstripGeom({w: 400, h: 90, perfFamily: "BH"}, 6).perf, 1) // true
 * @example perforationsResolve(filmstripGeom({w: 400, h: 2, perfFamily: "BH"}, 6).perf, 1) // false
 * @example // scaling the whole strip up brings them back — the floor is about PIXELS, not units:
 * @example perforationsResolve(filmstripGeom({w: 400, h: 2, perfFamily: "BH"}, 6).perf, 20) // true
 */
export function perforationsResolve(perf, scale) {
  return perforationPixels(perf, scale) >= PERF_FLOOR_PIXELS;
}

/**
 * Pure function. The smallest CROSS dimension (in local units, at world scale `scale`)
 * at which family `famId`'s perforations still clear PERF_FLOOR_PIXELS — the number the
 * sub-pixel report tells the user to reach. Inverts perforationPixels: the hole's
 * smallest side is min(alongMm, acrossMm) * cross/filmWidthMm * scale.
 *
 * @example Math.round(minPerforatedCross("BH", 1) * 10) / 10 // 18.9
 * @example Math.round(minPerforatedCross("KS", 1) * 10) / 10 // 17.7
 * @example Math.round(minPerforatedCross("R16", 1) * 10) / 10 // 12.6
 * @example Math.round(minPerforatedCross("BH", 2) * 10) / 10 // 9.4 (a 2x-scaled strip needs half the box)
 */
export function minPerforatedCross(famId, scale) {
  const fam = PERF_FAMILIES[famId] ?? PERF_FAMILIES[DEFAULT_PERF_FAMILY];
  return (PERF_FLOOR_PIXELS * fam.filmWidthMm) / (Math.min(fam.alongMm, fam.acrossMm) * (scale ?? 1));
}

/**
 * Pure function. Emits the filmColor strip's two bands (top+bottom) as triangulated
 * polygon ops. For a VERTICAL strip the bands run along the left/right edges and the
 * perforation row runs vertically; a per-axis swap of (x↔y, w↔h) reuses the same
 * horizontal band generator. Returns [] when the bands are degenerate.
 *
 * `perforate` false draws the bands SOLID (2 triangles each). The caller decides —
 * emit() does, from perforationsResolve, and REPORTS when it says no — so this stays
 * pure and both answers stay testable.
 *
 * SINGLE-PERF STOCK (`perf.sides` 1 — 16 mm 1R) punches bandA only and leaves bandB
 * blank film. That is not a special case in the tessellator: the second band simply is
 * not asked for holes, exactly as the below-the-floor case is not.
 *
 * @example filmBandOps(filmstripGeom({w: 480, h: 90, vertical: false}, 3), "#000000", 1, true).length > 0
 * true
 * @example filmBandOps(filmstripGeom({w: 480, h: 90, vertical: false}, 3), "#000000", 1, false).length
 * 4
 * @example // 16 mm 1R: one band of holes, one band of two solid triangles
 * @example filmBandOps(filmstripGeom({w: 480, h: 90, perfFamily: "R16S"}, 3), "#000000", 1, true).length > 2
 * true
 */
export function filmBandOps(geom, filmColor, opacity, perforate) {
  const { bandA, bandB, perf } = geom;
  const bandFor = (band, holed) => {
    // BELOW THE FLOOR, or the blank edge of a SINGLE-PERF stock: no holes at all.
    // Handing perforatedBandPolygons a zero-size hole is its own documented degenerate
    // (one solid rect), so this needs no second code path — it just declines to ask.
    if (!perforate || !holed) return perforatedBandPolygons(band, { along: 0, across: 0, radius: 0 }, 0, 0);
    if (perf.axis === "y") {
      // Vertical strip: TRANSPOSE the band (x↔y, w↔h) so the shared along-the-band
      // generator runs holes down the Y axis, then transpose the triangles back — one
      // generator serves both orientations. The hole record needs no swap: `along` and
      // `across` are named RELATIVE to the band, not to x/y. The PHASE needs none
      // either: it is measured along the band, which is the axis being transposed onto.
      const t = { x: band.y, y: band.x, w: band.h, h: band.w };
      return perforatedBandPolygons(t, perf, perf.pitch, perf.phase).map((tri) => tri.map(([px, py]) => [py, px]));
    }
    return perforatedBandPolygons(band, perf, perf.pitch, perf.phase);
  };
  const tris = [...bandFor(bandA, true), ...bandFor(bandB, perf.sides === 2)];
  return tris.map((tri) => polygon({ points: tri, fill: filmColor, opacity }));
}

/**
 * Pure function. The strip's PER-FRAME anchor set in local space: every VISIBLE
 * frame's 9 bbox anchors, id-prefixed `f{storedIndex}` (see the module header's
 * PER-FRAME ANCHORS section for why the STORED index and why no underscore).
 * Excludes the widget's own bbox 9 (standardBBoxAnchors adds those) so this can
 * also feed snapFeatures without double-counting them — the bento split exactly.
 *
 * @example filmstripFrameAnchors({w: 480, h: 90, frames: [[0], [1]]}).length // 18
 * @example filmstripFrameAnchors({w: 480, h: 90, frames: [[0], [1]]}).some((a) => a.id === "f1cm") // true
 * @example filmstripFrameAnchors({w: 480, h: 90, frames: [[0], [1], [2]], framesActive: [true, false, true]}).map((a) => a.id.slice(0, 2)).includes("f1") // false
 * @example filmstripFrameAnchors({w: 480, h: 90, frames: [[0], [1], [2]], framesActive: [true, false, true]}).some((a) => a.id === "f2tm") // true
 */
export function filmstripFrameAnchors(state) {
  const frames = visibleFrames(state);
  const cells = filmstripGeom(state, frames.length).frames;
  const out = [];
  for (let k = 0; k < frames.length && k < cells.length; k++) {
    const cell = cells[k];
    // The id carries the STORED index, the POSITION comes from the visible layout:
    // hiding a frame moves the others but rebinds none of their anchors.
    const prefix = `f${frames[k].index}`;
    for (const a of standardBBoxAnchors({ w: cell.w, h: cell.h }))
      out.push({ id: `${prefix}${a.id}`, x: cell.x + a.x, y: cell.y + a.y });
  }
  return out;
}

/**
 * Pure function. The strip's FULL local anchor set: the widget bbox 9
 * (standardBBoxAnchors) followed by every visible frame's 9. This is the plugin
 * `anchors(state)` capability — core/derive.nodeAnchors world-transforms these; they
 * feed hit-tests, the anchor hover-copy chips, arrow bindings, and `=` equations.
 *
 * @example filmstripAnchors({w: 480, h: 90, frames: [[0]]}).length // 18
 * @example filmstripAnchors({w: 480, h: 90, frames: [[0]]})[0].id // "tl"
 */
export function filmstripAnchors(state) {
  return [...standardBBoxAnchors(state), ...filmstripFrameAnchors(state)];
}

/**
 * Pure function. Is the sampled span EMPTY — i.e. has the clip length not been
 * supplied? Then every default frame time collapses onto `videoStart` and the strip
 * shows N copies of one frame, which emit() REPORTS rather than letting pass silently
 * (the no-silent-fallback rule; the real duration is not derivable from pure state).
 *
 * @example spanIsEmpty({videoStart: 0, videoEnd: 0}) // true
 * @example spanIsEmpty({videoStart: 0, videoEnd: 3}) // false
 * @example spanIsEmpty({videoStart: 5, videoEnd: 2}) // true (an inverted span samples nothing)
 * @example spanIsEmpty({}) // true
 */
export function spanIsEmpty(state) {
  return !((state.videoEnd ?? 0) > (state.videoStart ?? 0));
}

export const filmstripPlugin = {
  type: "filmstrip",
  title: "Filmstrip",
  capabilities: { bbox: true, transform: true, resizable: true, backdrop: false },
  // CREATION GESTURE (web/widget_handlers.js, phase "create"): drag a box, then
  // prompt for the video — a filmstrip with no source has nothing to draw, so asking
  // is part of placing it.
  placement: "bbox_then_asset",
  // DOUBLE-CLICK ACTIVATION (web/widget_handlers.js, phase "activate"): re-open the
  // asset picker, like every other media widget. `primaryAsset` names WHICH property
  // the picker fills.
  activate: "asset_picker",
  primaryAsset: "src",
  // THE LOAD-BOUNDARY MIGRATION SEAM. A document authored before `frames` became a
  // list stores it as a COUNT, and core/document.js's repair pipeline rewrites it to a
  // list of that same length. The default-equation TEXT is this widget's declaration,
  // not core's, so the repair reaches it through the registry (withFilmstripFramesMigrated
  // takes the builder as an argument) instead of core/ importing a plugin.
  defaultFrameList,
  /**
   * Pure function. Is this filmstrip a GHOST (the dashed-outline placeholder)? Only
   * when it has NO SOURCE — with a source there is always a real strip to draw (film
   * bands + frame windows), and any remaining problem is stated IN the widget (the
   * empty-span hint) rather than hidden behind a ghost outline. The former
   * frames-not-yet-fetched and fetch-failed ghost cases are gone with the server
   * round-trip that produced them.
   *
   * @example filmstripPlugin.isGhost({ src: "" })
   * true
   * @example filmstripPlugin.isGhost({})
   * true
   * @example filmstripPlugin.isGhost({ src: "clip.mp4" })
   * false
   */
  isGhost(state) {
    return typeof state.src !== "string" || state.src.length === 0;
  },
  defaults: {
    type: "filmstrip", x: 100, y: 100, w: 480, h: 90, z: 0, rotation: 0, scale: 1,
    // Rotation pivots about this WORLD point; default = own center (an equation).
    rotationAnchor: { x: "self.anchors.center.x", y: "self.anchors.center.y" },
    // `src` = the video ASSET URL (the served /asset/<project>/<file> path every
    // other media widget stores — the former bare-FILENAME storage existed only so a
    // server endpoint could resolve it). EMPTY until picked, which is both what makes
    // a fresh strip a ghost and what the two-step creation gesture's empty-source
    // guard reads (web/widget_handlers.js bbox_then_asset).
    src: "",
    // THE FRAME LIST + its visibility companion. Each element's default time is an
    // EQUATION across videoStart→videoEnd (see the header), so ONE edit re-times the
    // whole strip. The companion is absent (absent means visible — core/lists.js), so
    // a fresh strip mints no state nobody asked for.
    frames: defaultFrameList(DEFAULT_FRAME_COUNT),
    // The sampled window into the clip. videoEnd 0 = "the clip length has not been
    // supplied" (it is only knowable at decode time), which the widget SAYS.
    ...defaults("videoStart", "videoEnd"),
    // Past-the-end behavior for a frame whose time runs past the clip, shared with
    // the scrubbers ("clamp" holds the last frame, "loop" wraps modulo the duration).
    ...defaults("scrubWrap"),
    // Orientation, the perforation family (the film gauge + sprocket geometry, whose
    // published millimetre dimensions live in core/film.js PERF_FAMILIES), and the film
    // base colour.
    ...defaults("vertical", "filmColor"),
    perfFamily: DEFAULT_PERF_FAMILY,
    // Blank film before the first frame and after the last, in INTER-FRAME GAPS, so a
    // strip does not end flush on a picture (header: LEADER AND TAIL).
    leader: DEFAULT_LEADER_GAPS,
    // Letterbox each frame in its cell instead of squashing it to the cell's shape
    // (header: PRESERVE ASPECT). ON by default, the latex/svg/mermaid/cursor default.
    preserveAspect: true,
    // stroke COLOR default matches every stroked shape; paints only once
    // strokeWidth > 0 (0 by default). The border/rounding here frames the WHOLE
    // strip (all cells) — per-frame rounding/outline is intrinsic to the look.
    stroke: "#808080",
    ...defaults("strokeWidth", "cornerRadius", "opacity"),
    ...bundleNestedDefaults("effects"), // shadow/bloom/blendMode, all EFFECT-OFF
  },
  inspector: [
    ...bundle("positioning"),
    // The video asset — VIDEO assets, stored as the served URL (same picker/drop as
    // the player and the scrubbers).
    ...props("src", { src: { label: "Video", assetKinds: ["video"] } }),
    // THE sampled window, then THE frame list (the window first: it is what the
    // list's default equations read, so the reading order matches the causal one).
    ...props("videoStart", "videoEnd", "frames", "scrubWrap"),
    ...props("vertical", "perfFamily", "filmColor"),
    // The two plugin-LOCAL formatting rows, declared inline (the donut `inner`
    // precedent: a property only this widget has does not belong in the shared
    // registry). `min: 0` also gives `leader` range-scaled scrub sensitivity for free.
    { key: "leader", label: "Leader / tail", kind: "number", min: 0, category: "formatting", help: "Blank film before the first frame and after the last one, measured in gaps between frames — 1 (the default) leaves the same run at each end as there is between two frames, 0 ends flush on a picture, larger gives a longer head and tail. The sprocket-hole bands run right through it, which is what makes the ends read as film." },
    { key: "preserveAspect", label: "Preserve aspect", kind: "boolean", category: "formatting", help: "Fit each frame inside its cell without distorting it (centered, letterboxed against the film base). Turn off to stretch every frame to its cell's exact shape, which squashes them when you resize the strip." },
    // The stroked-BORDER bundle frames the WHOLE strip (all cells together).
    ...bundle("strokedBorder"),
    ...props("opacity"),
    ...bundle("effects"),
  ],
  /**
   * Near-pure function (console.errors ONCE per unique message via core/report.js
   * reportOnce — the plugins/donut.js and plugins/fancy_arrow.js contract; otherwise
   * pure). State → display-list commands in local space: the film bands with their
   * perforation holes, the filmColor content strip behind the frames, and ONE
   * `videoV5Frame` op per VISIBLE frame at that frame's time — each wrapped in its own
   * rounded corners + gray outline — then the whole-strip border/rounding + effects.
   *
   * TWO CONDITIONS ARE REPORTED AND NOTHING IS PAINTED TO SAY SO. An EMPTY SPAN means
   * every frame is the same frame; SUB-PIXEL PERFORATIONS mean the bands are drawn
   * solid (see PERF_FLOOR_PIXELS for why that is the same picture, and why refusing is
   * not an invented cap). Both go to the console channel and to the Inspector rows that
   * fix them, never onto the artwork — a warning scrawled across the widget ships in
   * the export.
   *
   * A frame whose decode has not landed simply draws nothing for that cell (the scrub
   * path's async contract, which HOLDS the last decoded frame rather than blanking —
   * render_gpu/skia/video_v5.js), so there is no in-flight widget state to model here.
   */
  emit(s, _targetWorldIR, world) {
    // NO SOURCE → draw NOTHING. This is the GHOST case (isGhost above), and the
    // ghost-emits-nothing symmetry is load-bearing: a ghost's dashed placeholder is
    // the only thing that should show, so emitting film bands underneath it would
    // both double-draw and make the placeholder unreadable (tests/ghost_test.js).
    if (typeof s.src !== "string" || s.src.length === 0) return [];
    const opacity = s.opacity ?? 1;
    const filmColor = s.filmColor ?? "#000000";
    const frames = visibleFrames(s);
    const geom = filmstripGeom(s, frames.length);
    const style = { w: s.w ?? 0, h: s.h ?? 0, stroke: s.stroke, strokeWidth: s.strokeWidth ?? 0, cornerRadius: Math.max(s.cornerRadius ?? 0, geom.radius) };
    const content = [];
    // THE PERFORATION FLOOR (PERF_FLOOR_PIXELS): below one document pixel per hole the
    // perforated band and a solid band are the same picture, and the hole count
    // diverges as the strip's cross dimension shrinks. Decline, and SAY SO — the key
    // omits the live size so a resize drag reports once, not once per frame.
    const scale = world?.scale ?? 1;
    const perforate = perforationsResolve(geom.perf, scale);
    if (!perforate) {
      const famId = PERF_FAMILIES[s.perfFamily] ? s.perfFamily : DEFAULT_PERF_FAMILY;
      const axis = s.vertical ? "width" : "height";
      const long = (s.vertical ? s.h : s.w) ?? 0;
      const declined = geom.perf.pitch > 0 ? Math.round(long / geom.perf.pitch) : 0;
      reportOnce(
        `PowerRP filmstrip: ${famId} perforations are below the ${PERF_FLOOR_PIXELS}-pixel floor`,
        `PowerRP filmstrip: one ${famId} perforation measures ${perforationPixels(geom.perf, scale).toFixed(3)} px at this size, below the ` +
        `${PERF_FLOOR_PIXELS}-pixel floor, so the sprocket bands are drawn UNPERFORATED — ${declined} holes per band were declined because ` +
        "not one of them could clear a single pixel, which makes the perforated band and a solid band the same picture. " +
        `Give the strip a ${axis} of at least ${minPerforatedCross(famId, scale).toFixed(1)} units, or scale it up, to get them back.`,
      );
    }
    // The film bands (with perforation holes) sit UNDER the frames so the frames
    // never overlap a hole.
    appendAll(content, filmBandOps(geom, filmColor, opacity, perforate));
    // Fill the content strip behind the frames with filmColor too (the frames'
    // rounded corners reveal it — the film shows between/around them).
    const cr = geom.contentRect;
    if (cr.w > 0 && cr.h > 0) content.push(rect({ x: cr.x, y: cr.y, w: cr.w, h: cr.h, fill: filmColor, opacity }));
    // Each frame: the scrub op at its own time, inside its own rounded corners + gray
    // outline (a per-cell decorateStrokedBox).
    //
    // THE CELL CONTENT CARRIES THE STRIP'S OWN `world`, and that is the fix for "the
    // pics in the film strip don't move with the film strip": decorateStrokedBox
    // wraps its content in pushTransform(world) because a cropSubtree's `content` is
    // flattened INDEPENDENTLY from identity by every backend (render_gpu/decorate.js's
    // absolute-world contract). Passing IDENTITY here — as this did — left every frame
    // op at world (0,0) while the bands and the frame borders (which ride the OUTER
    // wrap) moved with the strip, so dragging the widget left its pictures behind at
    // the canvas origin. Proven and re-proven by tests/filmstrip_test.js.
    for (let k = 0; k < frames.length && k < geom.frames.length; k++) {
      const c = geom.frames[k];
      if (c.w <= 0 || c.h <= 0) continue;
      const cellStyle = {
        x: c.x, y: c.y, w: c.w, h: c.h,
        cornerRadius: geom.frameRadius,
        stroke: STRIP_LOOK.frameOutline,
        strokeWidth: Math.max(1, geom.frameRadius * STRIP_LOOK.frameOutlineFrac),
      };
      // preserveAspect rides the OP because only the painter knows the decoded frame's
      // intrinsic size (header: PRESERVE ASPECT). Default ON, so a fresh strip and any
      // document authored before the property existed both letterbox.
      const cell = videoV5Frame({
        ref: s.src, x: c.x, y: c.y, w: c.w, h: c.h, opacity,
        seekTime: frames[k].time, wrap: s.scrubWrap ?? "clamp",
        preserveAspect: s.preserveAspect !== false,
      });
      appendAll(content, decorateStrokedBox([cell], cellStyle, world));
    }
    // EMPTY SPAN: report it (the Inspector's "Video end (s)" row is the affordance);
    // do NOT paint a notice onto the artwork.
    if (spanIsEmpty(s)) {
      reportOnce(
        "PowerRP filmstrip: the sampled span is empty (Video end is not set)",
        `PowerRP filmstrip: "Video end (s)" is ${s.videoEnd ?? 0} and "Video start (s)" is ${s.videoStart ?? 0}, so the sampled span is ` +
        "EMPTY and every frame's default equation collapses onto the start — the strip is showing one frame N times. " +
        "Set Video end (s) to the clip's length (it is only knowable once the video decodes, so it is a value you supply).",
      );
    }
    return applyEffects(decorateStrokedBox(content, style, world), s, world, { x: 0, y: 0, w: style.w, h: style.h });
  },
  // Effects halo (shadow/bloom spill) extends the cull AABB (core/view.js hook).
  cullMargin: effectsCullMargin,
  anchors: filmstripAnchors,
  /**
   * Pure function. Snap POINTS for every visible frame's anchors, so a dragged widget
   * snaps to a film cell. The strip's own bbox points + edge lines are auto-added by
   * core/derive.nodeFeatures, so they are NOT repeated here — the bento split.
   */
  snapFeatures(s) {
    return filmstripFrameAnchors(s).map((a) => ({ kind: "point", x: a.x, y: a.y, id: a.id }));
  },
  closestAnchor(state, wx, wy, world) {
    const local = T.apply(T.invert(world), wx, wy);
    return closestPointOnRectBorder({ x: 0, y: 0, w: state.w, h: state.h }, local.x, local.y);
  },
  // THE FILM STOCK PRESETS (core/film.js data → one props map each), applied in ONE undo
  // unit by the Presets pane. Adding a stock is one entry in PRESETS above.
  presets: PRESETS,
  commands: [
    // CROSSHAIR PLACEMENT (like every Add button): arm placement; the finished
    // gesture runs this widget's declared `placement` handler above, which creates
    // it and opens the video picker.
    { id: "add-filmstrip", title: "Add Filmstrip", icon: "mdi:filmstrip", run: (app) => app.armCrosshairPlacement(filmstripPlugin) },
    // RESPACE: rewrite every frame's time equation for the CURRENT frame count, in
    // ONE undo unit. The default equations bake i and N deliberately (see the header),
    // so this is the explicit "even them out again" gesture after inserting or purging
    // — an action, never an invisible re-derivation.
    { id: "filmstrip-respace-frames", title: "Respace Filmstrip Frames", icon: "mdi:arrow-expand-horizontal", run: respaceFrames },
  ],
};

/**
 * Command (commits ONE undo unit per selected filmstrip; reports when there is
 * nothing to do). Rewrites each selected strip's `frames` list so every element holds
 * the DEFAULT time equation for its position in the CURRENT list length — the
 * "even them out again" gesture after inserting or purging frames.
 *
 * Preview-then-commit through the app's own seam (app.setPreview → app.commitPreview),
 * which is how every other list write reaches the document (web/ListField.svelte
 * commitMoved), so this needs no bespoke undo handling. Element VISIBILITY is
 * untouched: respacing is about times, and the companion list is aligned by index,
 * which respacing does not change.
 */
function respaceFrames(app) {
  const strips = app.selectedIds().filter((id) => app.state().items?.[id]?.type === "filmstrip");
  if (strips.length === 0) {
    console.error("PowerRP filmstrip: Respace Filmstrip Frames needs a filmstrip selected — nothing was changed.");
    return;
  }
  const pairs = [];
  for (const id of strips) {
    const list = app.state().items[id].frames;
    if (!Array.isArray(list) || list.length === 0) {
      console.error(`PowerRP filmstrip: item "${id}" has no frame list to respace (frames is ${JSON.stringify(list)}).`);
      continue;
    }
    pairs.push([["items", id, "frames"], defaultFrameList(list.length)]);
  }
  if (pairs.length === 0) return;
  app.setPreview(pairs);
  app.commitPreview();
}
