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
  "latex-basic",            // Round 14.5: LaTeX equation as a rasterized-bitmap <image> data URI (bare + bordered/rounded + translucent) — the equation-raster region renders parity in the SVG backend
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
  // Round 14.5: the LaTeX equation is a rasterized-bitmap <image> data URI —
  // the same image-class parity as image-basic (measured 51.13): Chromium
  // rasterizes the embedded PNG data URI natively and both sides are the same
  // PNG bytes, so parity is tight; the bordered/rounded variant's rrect-clip
  // edge AA pulls it a bit below image-basic's 51. measured 43.00 dB (2026-07-15
  // live SVG parity run) — floor = measured − ~5, the SVG margin class (matching
  // shapes-overlap-z 45.54→40, richtext-outline-highlight 38.62→34). PENDING
  // USER RATIFICATION (the measured-minus-margin convention is flagged app-wide).
  "latex-basic": 38,
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
