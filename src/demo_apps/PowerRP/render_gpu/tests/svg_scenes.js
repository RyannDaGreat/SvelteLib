/**
 * The SVG-export slice of the WIDGET RENDER PARITY scene matrix (manifest
 * cornerstone rule). The canonical scene list lives ONCE in pdf_scenes.js — the
 * PDF and SVG backends are one family (manifest RENDER MODES DECISION: vector =
 * SVG and PDF), share the IR, the hybrid rule, the vector lens, and the crop
 * clip, so they must be tested against the SAME scenes, not a divergent copy.
 * This module SELECTS a representative subset (the task's named coverage:
 * text / image / lens / blur / crop, plus video / donut / arrows so every
 * widget family the SVG backend serializes is exercised) and attaches a
 * per-scene `svgPsnrFloor` — the SVG rasterizer (Chromium) and the PDF
 * rasterizer (poppler) differ in antialiasing/hinting, so the floors are
 * measured independently (all PENDING USER RATIFICATION, the same convention as
 * every pdf_scenes floor).
 *
 * Why a subset, not all: the full matrix's exhaustive z-overlap / rotation /
 * alpha permutations are already gated by the PDF suite against the SAME IR the
 * SVG backend consumes; the SVG suite's job is to prove the SVG-SPECIFIC
 * serialization of each op family (real <text>, <image> data URIs, the
 * <clipPath>+<g transform> lens, the rounded-rect crop clip, the hybrid raster
 * <image> region) rasterizes to the GPU pixels. One scene per family covers that.
 */

import { scenes as allScenes } from "./pdf_scenes.js";

/**
 * The scene names the SVG parity suite covers (a subset of pdf_scenes). Each
 * name MUST exist in pdf_scenes.scenes() — a typo throws loudly at load (below).
 */
export const SVG_SCENE_NAMES = [
  "shapes-overlap-z",       // vector rect/ellipse fill+stroke, z-order
  "arrows-crossing",        // vector polyline strokes + polygon heads
  "rotated-items",          // similarity transforms (translate/rotate/scale groups)
  "text-over-shapes",       // SYSTEM-font real <text> (selectable), over shapes
  "font-families",          // COMMITTED fonts embedded as @font-face data URIs
  "font-bold-over-shapes",  // committed bold faces (the shared-face jump)
  "alpha-translucency",     // per-item + per-channel alpha
  "blur-under-content",     // HYBRID RULE: raster <image> region + vector above
  "magnifier-sharp-rim",    // VECTOR lens: <clipPath> circle + <g> magnify + rim
  "magnifier-box-rounded-bordered", // SHAPED LENS: rounded-rect <clipPath> + stroked border (box branch)
  "magnifier-circle-regression",    // shaped-lens circle byte-stability through the PLUGIN (migrated stroke props)
  "blur-plus-lens",         // raster base + vector lens over it (stacked effects)
  "image-basic",            // <image> data-URI quads (unrotated/rotated/alpha)
  "image-under-magnifier",  // image replays inside the vector lens
  "video-basic",            // video CURRENT-FRAME <image> embed
  "donut-basic",            // triangulated-polygon fill + stroke polylines
  "filmstrip-look",         // 14.1 faithful look: triangulated perforation bands + per-cell rounded-clip <image> frames
  "cropbox-basic",          // rounded-rect <clipPath> + re-emit (incl. 45° rotated)
  "elbow-curved-arrows",    // arbitrary-length polyline routes
  "richtext-outline-highlight", // Round 13.4: the FIRST rich-text SVG scene (the rich path was ported here) — per-run outline (stroke+paint-order) + highlight (<rect>)
  "latex-basic",            // Round 15.1: LaTeX equation as TRUE VECTOR glyph <path>s (latexVector op) — bare + bordered/rounded + translucent — vs the GPU raster bitmap
  "latex-counters",         // Round 15.1: glyph-counter FILL-RULE test (e/0/8/a holes) — nonzero-winding vector paths vs the correct MathJax raster; a wrong even-odd rule craters the PSNR
];

/**
 * The SVG-suite PSNR floors, keyed by scene name. Measured from the 2026-07-15
 * SVG parity run (Chromium rasterization vs the GPU render). Chromium's SVG
 * rasterizer antialiases edges and hints text differently from both the GPU
 * atlas and poppler, so these differ from the pdf_scenes floors and are set to
 * (measured − margin), matching the codebase's measured-minus-margin convention.
 * ALL PENDING USER RATIFICATION (the floor-setting convention is flagged
 * app-wide, not per-scene). See the suite report for the measured values.
 */
export const SVG_PSNR_FLOORS = {
  // Values are (2026-07-15 measured − ~5 dB margin), matching the codebase's
  // measured-minus-margin floor convention (the margin absorbs Chromium AA /
  // font-hinting run-to-run jitter). The measured dB is in the trailing comment.
  "shapes-overlap-z": 40,       // measured 45.54 — pure vector fill+stroke, AA-only
  "arrows-crossing": 41,        // measured 46.17 — vector strokes + polygon heads
  "rotated-items": 22,          // measured 27.27 — rotated text carries the font AA delta
  "text-over-shapes": 17,       // measured 22.80 — SYSTEM font: Chromium system-ui vs GPU atlas system-ui
  "font-families": 21,          // measured 26.09 — committed @font-face embedded, 4 dense rows
  "font-bold-over-shapes": 29,  // measured 34.37 — shared committed face over a shape
  "alpha-translucency": 45,     // measured 50.43 — group/channel alpha matches near-exactly
  "blur-under-content": 25,     // measured 30.84 — hybrid raster base + vector above
  "magnifier-sharp-rim": 26,    // measured 31.22 — vector lens clip+magnify replay
  "magnifier-box-rounded-bordered": 28, // measured 33.18 (2026-07-15 shaped-lens run) — rrect clip + border + magnify; clip-edge-AA class
  "magnifier-circle-regression": 25,    // measured 29.63 (2026-07-15 shaped-lens run) — in magnifier-sharp-rim's class (31.22): the byte-stability guard through the plugin path
  "blur-plus-lens": 21,         // measured 26.44 — raster base + vector lens over it
  "image-basic": 45,            // measured 51.13 — <image> data-URI quads match tightly
  "image-under-magnifier": 46,  // measured 51.78 — image replays inside the vector lens
  "video-basic": 27,            // measured 32.06 — current-frame <image> embed
  "donut-basic": 32,            // measured 37.03 — triangulated polygon fill + stroke
  // 14.1 filmstrip faithful look: triangulated perforation bands (donut class,
  // 37.03) + per-cell rounded <clipPath> <image> frames (cropbox class, 23.50).
  // The rounded-clip image cells dominate the delta, so it lands near the
  // cropbox class. measured 31.07 dB (2026-07-15 live SVG parity run) — floor =
  // measured − ~5, the SVG margin class (shapes 45.54→40, richtext 38.62→34).
  // PENDING USER RATIFICATION (the measured-minus-margin convention is flagged
  // app-wide, not per-scene).
  "filmstrip-look": 26,         // measured 31.07 — perforation-band polygons + per-cell rounded <clipPath> <image> frames
  "cropbox-basic": 18,          // measured 23.50 — rounded <clipPath> re-emit incl. 45° rotation
  "elbow-curved-arrows": 38,    // measured 43.23 — arbitrary-length polyline routes
  // Round 13.4: FIRST rich-text SVG scene (the rich path was newly ported). SVG
  // outline = -webkit-text-stroke-equivalent paint-order="stroke"; the committed
  // Inter face carries the same synth-oblique/AA deltas as font-families (21).
  // measured 38.62 dB (2026-07-15 live run) — floor = measured − ~4.6, the
  // shaped-lens margin class (magnifier-box 33.18→28, magnifier-circle
  // 29.63→25). SVG text is vector-exact (both sides rasterize real glyph
  // outlines), hence far above the PDF twin's 23.20. PENDING RATIFICATION.
  "richtext-outline-highlight": 34,
  // Round 15.1: the LaTeX equation is now TRUE VECTOR — inline glyph <path>s
  // (the latexVector op), NOT a raster <image> data URI. So this is now a
  // VECTOR-vs-RASTER comparison: Chromium rasterizes the crisp SVG glyph paths
  // while the GPU-EXPECTED side draws the SOFT MathJax raster bitmap (the live
  // GPU view stays the raster quad — out of scope to vectorize per the task
  // brief). The floor therefore DROPPED from 38 (the old raster-vs-raster, same
  // PNG both sides, 43 dB) to the vector-vs-raster class: measured 21.18 dB
  // (2026-07-15 live SVG vector-parity run), IDENTICAL to the PDF twin's 21.17 —
  // both backends now emit the same true-vector glyphs, diverging from the raster
  // the same way (the PSNR is bounded by the raster's AA softness, not the
  // vector's crispness). floor 18 = measured − ~3, matching the PDF latex-basic
  // floor. PENDING USER RATIFICATION (the measured-minus-margin convention is
  // flagged app-wide). The vector's win is CRISPNESS AT ANY ZOOM in exports, not
  // a higher PSNR against the bitmap it replaces.
  "latex-basic": 18,
  // Round 15.1: glyph-counter FILL-RULE test (e/0/8/a). measured 30.55 dB
  // (2026-07-15 live SVG vector-parity run) — HIGHER than latex-basic's 21.18
  // because the equation is large/simple (fewer fine strokes → tighter crisp-
  // vector-vs-soft-raster agreement), matching the PDF twin's 30.25. floor 27 =
  // measured − ~3. A WRONG even-odd fill would fill the e/0/8/a counters solid
  // and sink this FAR below 27 — that divergence IS the fill-rule gate. PENDING
  // USER RATIFICATION.
  "latex-counters": 27,
};

/**
 * Query (reads the pdf_scenes matrix). The SVG parity scene list: the selected
 * subset of pdf_scenes, each with its `svgPsnrFloor` attached. Loud if a named
 * scene is missing from pdf_scenes (a rename drift — never a silent skip).
 *
 * @example svgScenes().length === SVG_SCENE_NAMES.length // true
 * @example svgScenes().every((s) => typeof s.svgPsnrFloor === "number") // true
 */
export function svgScenes() {
  const byName = new Map(allScenes().map((s) => [s.name, s]));
  return SVG_SCENE_NAMES.map((name) => {
    const scene = byName.get(name);
    if (!scene) throw new Error(`svg_scenes: "${name}" is not in pdf_scenes.scenes() — a scene rename drifted; fix SVG_SCENE_NAMES`);
    const svgPsnrFloor = SVG_PSNR_FLOORS[name];
    if (typeof svgPsnrFloor !== "number") throw new Error(`svg_scenes: no SVG_PSNR_FLOORS entry for "${name}"`);
    return { ...scene, svgPsnrFloor };
  });
}
