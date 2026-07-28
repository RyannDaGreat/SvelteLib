/**
 * The WIDGET RENDER PARITY scene matrix (manifest cornerstone rule): every
 * scene renders through BOTH the GPU compositor and the PDF backend, and the
 * rasterized PDF must match the GPU pixels (papers are PDFs — no corners
 * cut). EVERY NEW WIDGET ADDS A SCENE HERE — the parity suite
 * (tests/pdf_parity_test.js) is the enforcement mechanism.
 *
 * Scenes are DOM-free IR builders (bare-node importable): overlapping z
 * orders, text over shapes, arrows crossing shapes, translucent fills,
 * rotated items, magnifier lenses (both supersample states, rims incl. 0),
 * blur under content, blur + lens stacked.
 *
 * `psnrFloor` per scene: the minimum acceptable PSNR (dB) of rasterized-PDF
 * vs GPU pixels, chosen FROM MEASUREMENT (values in the 2026-07 parity run —
 * see the suite's report; PENDING USER RATIFICATION). Antialiasing and font
 * rasterization differ legitimately between renderers, so pixel-perfect is
 * impossible; the floors catch real geometry/color/placement flaws.
 */

import { rect, ellipse, polyline, polygon, text, image, video, latexVector, pushTransform, popTransform, blurBackdrop, magnifyBackdrop } from "../ir.js";
import { normalizeRichText } from "../../core/richtext.js";
import { CHECKER_PNG_DATA_URI } from "../../tests/fixtures/checker_png.js";
import { STILL_VIDEO_MP4_DATA_URI, STILL_VIDEO_FRAME_DATA_URI } from "../../tests/fixtures/still_video.js";
import { LATEX_EQUATION_PNG_DATA_URI, LATEX_EQUATION_W, LATEX_EQUATION_H } from "../../tests/fixtures/latex_equation_png.js";
import { LATEX_EQUATION_GLYPHS, LATEX_EQUATION_VIEWBOX } from "../../tests/fixtures/latex_equation_vector.js";
import { LATEX_COUNTER_GLYPHS, LATEX_COUNTER_VIEWBOX, LATEX_COUNTER_W, LATEX_COUNTER_H, LATEX_COUNTER_PNG_DATA_URI } from "../../tests/fixtures/latex_counter_vector.js";
import { filmstripLayout, filmstripPlugin } from "../../plugins/filmstrip.js";
import { rectPlugin } from "../../plugins/rect.js";
import { circlePlugin } from "../../plugins/circle.js";
import { donutPlugin } from "../../plugins/donut.js";
import { cropboxPlugin } from "../../plugins/cropbox.js";
import { magnifierPlugin } from "../../plugins/magnifier.js";
import { imagePlugin } from "../../plugins/image.js";
import { videoPlugin } from "../../plugins/video.js";
import { arrowPlugin } from "../../plugins/arrow.js";
import { elbowArrowPlugin } from "../../plugins/elbow_arrow.js";
import { curvedArrowPlugin } from "../../plugins/curved_arrow.js";
import { codeblockPlugin } from "../../plugins/codeblock.js";
import { fancyArrowPlugin } from "../../plugins/fancy_arrow.js";

/** Standard parity canvas: small enough for fast suites, big enough for detail. */
export const SCENE_W = 400;
export const SCENE_H = 300;

/** Pure function. The identity page view every scene uses (world = page pt).
 * @example sceneView().zoom // 1
 */
export function sceneView() {
  return { zoom: 1, panX: 0, panY: 0 };
}

const BG = "#f4f4f0";
const INK = "#101018";

/** The synthetic image-registry ref the latex-basic scene's latexVector ops use
 * (Round 15.1). The GPU-expected side of the parity comparison draws the raster
 * equation bitmap; the parity harness registers LATEX_EQUATION_PNG_DATA_URI's
 * bitmap under THIS ref before rendering (a latexVector `ref` is a synthetic key,
 * not a decodable data URI — see the scene's `latexRef`/`latexRaster` meta). */
export const LATEX_PARITY_REF = "latex-parity:quadratic";

/** The ref for the latex-counters scene's equation raster (Round 15.1) — glyphs
 * with prominent COUNTERS (e/0/8/a holes) that prove the nonzero fill rule. */
export const LATEX_COUNTER_REF = "latex-parity:counters";

/** Shared content block: shapes + arrow + text the effect scenes sit on. */
function baseContent() {
  return [
    rect({ x: 30, y: 40, w: 140, h: 90, cornerRadius: 10, fill: "#7aa2f7", stroke: INK, strokeWidth: 3 }),
    ellipse({ cx: 210, cy: 120, rx: 70, ry: 45, fill: "#f7768e", stroke: INK, strokeWidth: 2 }),
    polyline({ points: [[40, 220], [200, 180], [360, 240]], width: 4, color: INK }),
    polygon({ points: [[360, 240], [340, 225], [345, 248]], fill: INK }),
    text({ text: "Parity 123", x: 40, y: 150, size: 28, color: INK }),
  ];
}

/**
 * Pure function. The parity scene list. Every entry:
 * {name, width, height, view, background, commands, psnrFloor,
 *  hasText (IR contains text ops), vectorText (text ops reach the VECTOR
 *  layer — false when all text sits below a blur, i.e. inside the raster
 *  region)}
 *
 * @example scenes().length >= 9 // true
 * @example scenes().every((s) => typeof s.psnrFloor === "number") // true
 */
export function scenes() {
  const s = (name, commands, psnrFloor, extra = {}) => {
    const hasText = commands.some((c) => c.op === "text");
    return {
      name, width: SCENE_W, height: SCENE_H, view: sceneView(), background: BG,
      commands, psnrFloor, hasText, vectorText: hasText, ...extra,
    };
  };

  return [
    s("shapes-overlap-z", [
      rect({ x: 40, y: 40, w: 160, h: 110, fill: "#7aa2f7" }),
      ellipse({ cx: 160, cy: 130, rx: 90, ry: 60, fill: "#9ece6a", stroke: INK, strokeWidth: 4 }),
      rect({ x: 130, y: 90, w: 180, h: 120, cornerRadius: 18, fill: "#e0af68", stroke: "#7a3a3a", strokeWidth: 2 }),
      ellipse({ cx: 300, cy: 100, rx: 50, ry: 50, fill: "#bb9af7" }),
    ], 40), // measured 45.45 dB (2026-07 run) — pure vector, AA-only differences

    s("text-over-shapes", [
      rect({ x: 20, y: 30, w: 360, h: 100, fill: "#7aa2f7" }),
      text({ text: "Over the rect", x: 40, y: 55, size: 36, color: "#ffffff" }),
      text({ text: "Bold below", x: 40, y: 160, size: 30, color: INK, bold: true }),
      ellipse({ cx: 300, cy: 220, rx: 80, ry: 50, fill: "#9ece6a" }),
      text({ text: "on ellipse", x: 245, y: 205, size: 22, color: INK }),
    ], 16), // measured 19.67 dB — this scene uses the SYSTEM font (no committed file), so it stays the standard-14-Helvetica-vs-atlas-system-ui baseline. The fonts task's "shared TTF" jump is demonstrated by the committed-font scenes (font-bold-over-shapes ~28.8 dB) — system text legitimately can't share a face.

    s("arrows-crossing", [
      rect({ x: 60, y: 60, w: 120, h: 90, fill: "#7aa2f7" }),
      ellipse({ cx: 280, cy: 200, rx: 60, ry: 40, fill: "#f7768e" }),
      polyline({ points: [[40, 40], [340, 250]], width: 5, color: INK }),
      polygon({ points: [[350, 257], [325, 250], [335, 237]], fill: INK }),
      polyline({ points: [[360, 50], [60, 240]], width: 3, color: "#7a3a3a" }),
      polygon({ points: [[52, 245], [72, 232], [78, 250]], fill: "#7a3a3a" }),
    ], 37), // measured 41.32 dB — pure vector strokes + heads

    s("alpha-translucency", [
      rect({ x: 30, y: 30, w: 180, h: 140, fill: "#7aa2f780" }), // 50% alpha in the color
      ellipse({ cx: 190, cy: 140, rx: 100, ry: 70, fill: "#f7768e", opacity: 0.5 }), // 50% via opacity
      rect({ x: 150, y: 90, w: 200, h: 130, fill: "#9ece6a66", stroke: "#10101880", strokeWidth: 6 }),
    ], 44), // measured 48.13 dB — ExtGState alpha compositing matches near-exactly

    s("rotated-items", [
      pushTransform({ x: 120, y: 100, rotation: 0.4 }),
      rect({ x: -60, y: -35, w: 120, h: 70, cornerRadius: 8, fill: "#7aa2f7", stroke: INK, strokeWidth: 2 }),
      popTransform(),
      pushTransform({ x: 280, y: 120, rotation: -0.8, scale: 1.4 }),
      ellipse({ cx: 0, cy: 0, rx: 45, ry: 28, fill: "#e0af68" }),
      popTransform(),
      pushTransform({ x: 90, y: 230, rotation: 0.25 }),
      text({ text: "tilted text", x: 0, y: -14, size: 26, color: INK }),
      popTransform(),
    ], 23), // measured 27.28 dB — rotated text carries the font delta

    s("magnifier-sharp-rim", [
      ...baseContent(),
      magnifyBackdrop({ cx: 200, cy: 150, r: 70, magnification: 2.2, rimColor: INK, rimWidth: 5, supersample: true }),
    ], 20), // measured 23.46 dB — lens replay geometry aligns; text under the lens carries the font delta

    // supersample:false — the GPU samples its rasterized backdrop (soft); PDF
    // has no backdrop to sample, so the lens is a vector replay either way
    // (strictly sharper than the GPU — a KNOWN semantic divergence, so this
    // scene's floor is lower; the lens interior legitimately differs).
    s("magnifier-soft-rimless", [
      ...baseContent(),
      magnifyBackdrop({ cx: 180, cy: 140, r: 60, magnification: 3, rimColor: null, rimWidth: 0, supersample: false }),
    ], 20), // measured 23.94 dB (divergence documented above)

    // BOX MAGNIFIER (this task's cornerstone parity — manifest "BOX-SHAPED
    // MAGNIFIERS"): a rounded, bordered rectangular lens magnifying the base
    // content. Built through the REAL magnifierPlugin.emit() (like the cropbox/
    // image scenes) so it exercises the actual widget glue → shaped-lens op →
    // both backends: the GPU crop pipeline (rrect SDF + border + magnification)
    // and the PDF emitLens box branch (rectPath clip + magnify cm + stroked
    // border). The box lens is the same shaped-lens family as a crop box, but
    // at magnification > 1 sourcing the z-prefix. Proves "box magnifier
    // magnifies through its rounded bordered rect in GPU AND PDF".
    (() => {
      const world = { x: 40, y: 30, rotation: 0, scale: 1 };
      const state = { ...magnifierPlugin.defaults, shape: "box", x: 0, y: 0, w: 240, h: 150, cornerRadius: 24, magnification: 2.2, stroke: INK, strokeWidth: 5, supersample: true };
      return s("magnifier-box-rounded-bordered", [
        ...baseContent(),
        ...[pushTransform(world), ...magnifierPlugin.emit(state, null, world), popTransform()],
      ], 20); // floor 20 = the same clip-edge-AA divergence class as the circle lens (measured 23.46) and the crop box (measured 23.38 — the box lens reuses that rrect-clip machinery). Measured + measured-minus-margin land in the next live parity run. PENDING USER RATIFICATION.
    })(),

    // CIRCLE-LENS REGRESSION through the PLUGIN (this task's byte-stability
    // proof): a plain circular magnifier built via magnifierPlugin.emit() with
    // the MIGRATED stroke/strokeWidth props (was rimColor/rimWidth) and the
    // default origin (self center). Its rendered output must stay identical to
    // the pre-shape circle lens — the parity floor matches magnifier-sharp-rim.
    // This guards the "keep every existing behavior byte-identical for circle
    // lenses" requirement at the plugin boundary (the raw-IR magnifier-sharp-rim
    // scene above guards it at the IR boundary).
    (() => {
      const world = { x: 60, y: 40, rotation: 0, scale: 1 };
      const state = { ...magnifierPlugin.defaults, shape: "circle", x: 0, y: 0, w: 140, h: 140, magnification: 2.2, stroke: INK, strokeWidth: 5, supersample: true };
      return s("magnifier-circle-regression", [
        ...baseContent(),
        ...[pushTransform(world), ...magnifierPlugin.emit(state, null, world), popTransform()],
      ], 20); // measured class = magnifier-sharp-rim (23.46 dB); same lens replay geometry, now through the plugin path. PENDING USER RATIFICATION.
    })(),

    s("blur-under-content", [
      ...baseContent(),
      blurBackdrop({ radius: 6 }),
      rect({ x: 240, y: 40, w: 130, h: 80, cornerRadius: 6, fill: "#9ece6a", stroke: INK, strokeWidth: 2 }),
      text({ text: "above blur", x: 250, y: 60, size: 20, color: INK }),
    ], 26), // measured 30.52 dB — hybrid raster base compares near-exactly; vector text above carries the font delta

    // All text sits BELOW the blur → it lives inside the raster region; no
    // vector text operators reach the page (vectorText: false).
    s("blur-plus-lens", [
      ...baseContent(),
      blurBackdrop({ radius: 5 }),
      magnifyBackdrop({ cx: 210, cy: 150, r: 75, magnification: 2, rimColor: "#7a3a3a", rimWidth: 4, supersample: true }),
    ], 23, { vectorText: false }), // measured 26.51 dB — raster base + vector lens replay of the raster

    // ── IMAGE widget parity (Opus8) ──────────────────────────────────────────
    // The image is a data-URI PNG fixture (checker_png.js): the GPU uploads it
    // as a sampled-texture quad, the PDF embeds it as an image XObject. The
    // fixture is a four-quadrant + white-diagonal pattern so any flip, rotation,
    // or channel swap crushes the PSNR (it can't hide in a flat color).

    // Image alone: an unrotated quad + a rotated one + a translucent overlap,
    // to exercise the cm placement (y-flip), rotation cm, and opacity ExtGState.
    s("image-basic", [
      image({ ref: CHECKER_PNG_DATA_URI, x: 30, y: 40, w: 160, h: 120 }),
      pushTransform({ x: 300, y: 90, rotation: 0.35 }),
      image({ ref: CHECKER_PNG_DATA_URI, x: -60, y: -45, w: 120, h: 90 }),
      popTransform(),
      image({ ref: CHECKER_PNG_DATA_URI, x: 150, y: 120, w: 170, h: 130, opacity: 0.5 }),
    ], 25), // measured 28.83 dB — geometry/color/rotation/opacity match exactly (VLM-verified); the gap is edge AA: the GPU bilinear-upsamples the 64x48 fixture, poppler steps it. floor PENDING USER RATIFICATION

    // Image UNDER a backdrop blur → the image is inside the hybrid raster region
    // (backdrop:false, so it composites into the scene the blur then reads); a
    // vector rect sits above the blur. Proves image + hybrid-rule compositing.
    s("image-under-blur", [
      rect({ x: 0, y: 0, w: SCENE_W, h: SCENE_H, fill: "#ffffff" }),
      image({ ref: CHECKER_PNG_DATA_URI, x: 40, y: 40, w: 220, h: 165 }),
      blurBackdrop({ radius: 5 }),
      rect({ x: 250, y: 40, w: 120, h: 80, cornerRadius: 6, fill: "#9ece6a", stroke: INK, strokeWidth: 2 }),
    ], 40), // measured 45.50 dB — hybrid raster base compares near-exactly (image is inside the embedded region). floor PENDING USER RATIFICATION

    // Image UNDER a magnifier → the lens re-emits the image (a re-interpretable
    // display-list command) at magnification, clipped to the lens circle. Proves
    // the image participates in the vector lens replay, not just flat compositing.
    s("image-under-magnifier", [
      rect({ x: 0, y: 0, w: SCENE_W, h: SCENE_H, fill: "#ffffff" }),
      image({ ref: CHECKER_PNG_DATA_URI, x: 60, y: 40, w: 260, h: 200 }),
      magnifyBackdrop({ cx: 200, cy: 150, r: 70, magnification: 2.2, rimColor: INK, rimWidth: 5, supersample: true }),
    ], 22), // measured 26.07 dB — vector lens (Form-XObject clip + magnify) replays the image XObject; edge-AA divergence class as the other lens scenes. floor PENDING USER RATIFICATION

    // ── COMMITTED-FONT text parity (fonts task, W2f) ─────────────────────────
    // These use the COMMITTED fonts (fonts.js ids), so the glyph atlas and the
    // PDF backend rasterize/embed the SAME TTF — the whole point of the fonts
    // task. Floors JUMP well above the `system`/text-over-shapes scenes above
    // (which still compare the atlas's system-ui against standard-14 Helvetica),
    // because the two renderers now share a face; the residual is only AA and
    // hinting differences between canvas2D and poppler. The parity harness
    // passes loadFontBytes + registerFontkit + per-font textAscent for these.
    // Floors are MEASURED (see the annotations); PENDING USER RATIFICATION.
    s("font-families", [
      rect({ x: 0, y: 0, w: SCENE_W, h: SCENE_H, fill: "#ffffff" }),
      text({ text: "Inter sans 123", x: 24, y: 30, size: 30, color: INK, font: "inter" }),
      text({ text: "Source Serif", x: 24, y: 90, size: 30, color: INK, font: "source-serif" }),
      text({ text: "JetBrains Mono", x: 24, y: 150, size: 28, color: INK, font: "jetbrains-mono" }),
      text({ text: "Lora serif face", x: 24, y: 210, size: 30, color: INK, font: "lora" }),
    ], 20, { font: true }), // measured 23.99 dB — shared committed face; residual is canvas2D-vs-poppler AA/hinting on 4 dense text rows. floor = measured − ~4 dB. PENDING USER RATIFICATION

    // Bold committed faces + a committed font OVER a shape (the text-over-shapes
    // analog, but with an embedded shared face) — this is the scene whose floor
    // should visibly beat the system-font `text-over-shapes` (16 dB) once the
    // faces match.
    s("font-bold-over-shapes", [
      rect({ x: 20, y: 30, w: 360, h: 100, fill: "#7aa2f7" }),
      text({ text: "Inter Bold", x: 40, y: 55, size: 36, color: "#ffffff", font: "inter", bold: true }),
      text({ text: "Serif Bold below", x: 40, y: 160, size: 30, color: INK, font: "source-serif", bold: true }),
      ellipse({ cx: 300, cy: 220, rx: 80, ry: 50, fill: "#9ece6a" }),
      text({ text: "mono on it", x: 240, y: 205, size: 20, color: INK, font: "jetbrains-mono" }),
    ], 24, { font: true }), // measured 28.78 dB — the system-font analog (text-over-shapes) sits at 19.67 dB; embedding the SHARED committed face lifts it ~9 dB (the font-substitution delta is gone). floor = measured − ~4.8 dB. PENDING USER RATIFICATION

    // ── VIDEO PLAYER widget parity (Opus15/W2b) ──────────────────────────────
    // A STILL (constant-frame) mp4 fixture (still_video.js): the GPU imports the
    // <video> element's CURRENT frame as an external texture; the PDF embeds that
    // same current frame as an image XObject (manifest: video → current-frame
    // raster embed). Because the clip is STILL, the "current frame" is
    // deterministic (== STILL_VIDEO_FRAME_DATA_URI), so parity is stable. The
    // four-quadrant + white-diagonal pattern crushes PSNR on any flip/swap.
    //
    // Scenes carry `video: {ref, frameSrc}` so the parity harness knows to
    // ensureVideo(ref) before the GPU render AND to supply the frame resolver
    // (ref → frameSrc bytes) to the PDF backend. Same structure as the image
    // scenes (backdrop:false → video composites into the scene the effects read).
    s("video-basic", [
      video({ ref: STILL_VIDEO_MP4_DATA_URI, x: 30, y: 40, w: 160, h: 120 }),
      pushTransform({ x: 300, y: 90, rotation: 0.35 }),
      video({ ref: STILL_VIDEO_MP4_DATA_URI, x: -60, y: -45, w: 120, h: 90 }),
      popTransform(),
      video({ ref: STILL_VIDEO_MP4_DATA_URI, x: 150, y: 120, w: 170, h: 130, opacity: 0.5 }),
    ], 22, { video: { ref: STILL_VIDEO_MP4_DATA_URI, frameSrc: STILL_VIDEO_FRAME_DATA_URI } }), // measured 27.04 dB — geometry/rotation/opacity match; the gap is edge AA (GPU bilinear-upsamples the frame, poppler steps it) + the codec's YUV→RGB rounding vs the still-frame PNG. floor PENDING USER RATIFICATION

    // Video UNDER a backdrop blur → the current frame is inside the hybrid raster
    // region (backdrop:false, composites into the scene the blur reads); a vector
    // rect sits above. Proves video + hybrid-rule compositing (like image-under-blur).
    s("video-under-blur", [
      rect({ x: 0, y: 0, w: SCENE_W, h: SCENE_H, fill: "#ffffff" }),
      video({ ref: STILL_VIDEO_MP4_DATA_URI, x: 40, y: 40, w: 220, h: 165 }),
      blurBackdrop({ radius: 5 }),
      rect({ x: 250, y: 40, w: 120, h: 80, cornerRadius: 6, fill: "#9ece6a", stroke: INK, strokeWidth: 2 }),
    ], 30, { video: { ref: STILL_VIDEO_MP4_DATA_URI, frameSrc: STILL_VIDEO_FRAME_DATA_URI } }), // measured 45.70 dB — hybrid raster base compares near-exactly (the frame is inside the embedded region). floor PENDING USER RATIFICATION

    // Video UNDER a magnifier → the lens re-emits the video op at magnification,
    // clipped to the lens circle (the video's current-frame XObject replays in
    // the vector lens, like image-under-magnifier). Proves the video participates
    // in the vector lens replay, not just flat compositing.
    s("video-under-magnifier", [
      rect({ x: 0, y: 0, w: SCENE_W, h: SCENE_H, fill: "#ffffff" }),
      video({ ref: STILL_VIDEO_MP4_DATA_URI, x: 60, y: 40, w: 260, h: 200 }),
      magnifyBackdrop({ cx: 200, cy: 150, r: 70, magnification: 2.2, rimColor: INK, rimWidth: 5, supersample: true }),
    ], 20, { video: { ref: STILL_VIDEO_MP4_DATA_URI, frameSrc: STILL_VIDEO_FRAME_DATA_URI } }), // measured 24.83 dB — vector lens (Form-XObject clip + magnify) replays the video's current-frame XObject; edge-AA divergence class as the other lens scenes. floor PENDING USER RATIFICATION

    // FILMSTRIP: N frames laid left-to-right within the widget bbox (the exact
    // plugins/filmstrip.js emit() geometry — filmstripLayout, thin gaps). The
    // frames come from the server in the app, but for OFFLINE parity each
    // "frame" is the committed checker fixture (data URI) — the widget's
    // frameUrls contract admits data URIs, so this is the true emit path with a
    // deterministic source. Proves the strip's image ops render identically
    // through the GPU compositor and the PDF backend (the cornerstone rule).
    // Placed with a bbox offset (pushTransform) exactly as sceneIR wraps the
    // node's world transform.
    s("filmstrip", (() => {
      const N = 5, W = 340, H = 90;
      const cells = filmstripLayout(N, W, H);
      return [
        rect({ x: 0, y: 0, w: SCENE_W, h: SCENE_H, fill: "#ffffff" }),
        pushTransform({ x: 30, y: 100 }),
        ...cells.map((c) => image({ ref: CHECKER_PNG_DATA_URI, x: c.x, y: 0, w: c.w, h: c.h })),
        popTransform(),
      ];
    })(), 25), // image-class parity: same edge-AA divergence as image-basic (GPU bilinear vs poppler step). floor PENDING USER RATIFICATION

    // ── FILMSTRIP FAITHFUL LOOK parity (manifest 14.1) ─────────────────────────
    // The REAL filmstripPlugin.emit() — perforation bands (triangulated polygon
    // ops around round holes, the donut technique), a filmColor content strip,
    // and per-frame rounded corners + gray outlines (per-cell decorateStrokedBox
    // → cropSubtree). Built exactly like donut-basic/cropbox-basic (real emit(),
    // not hand IR) so it exercises the actual widget glue through BOTH backends.
    // emit() takes (state, null, world) — filmColor is a NON-BLACK gray here so
    // the perforation holes read as WHITE page (transparent) against it, exactly
    // the demo's "dots visible over a non-black background" check. The bands' many
    // polygon tris are the same parity class as donut-basic (triangulated fill).
    s("filmstrip-look", (() => {
      const W = 320, H = 96;
      const world = { x: 40, y: 100, rotation: 0, scale: 1 };
      // The frames are `videoV5Frame` SCRUB ops now (the widget's frames are decoded
      // live from `src` at four times across the videoStart→videoEnd span, replacing
      // the server-fetched stills the `frameUrls` state key used to hold). Those ops
      // are in NEITHER backend's vector set, so each takes the general RASTER fallback
      // (pdf_backend.emitRasterOp / svg_backend.emitRasterOpSVG) through the shared
      // rasterize seam — which is exactly the hybrid-rule behaviour this scene should
      // pin for a scrub op. The BANDS + the whole-strip and per-cell rounded clips are
      // still the vector geometry under test, and `videoEnd` is set so the widget's
      // empty-span hint (a text op) stays out of the comparison.
      const state = {
        ...filmstripPlugin.defaults, w: W, h: H,
        src: STILL_VIDEO_MP4_DATA_URI, videoStart: 0, videoEnd: 4, frames: [[0], [1], [2], [3]],
        filmColor: "#303038", stroke: "#808080", strokeWidth: 0, opacity: 1,
      };
      return [
        rect({ x: 0, y: 0, w: SCENE_W, h: SCENE_H, fill: "#ffffff" }),
        pushTransform(world),
        ...filmstripPlugin.emit(state, null, world),
        popTransform(),
      ];
    })(), 28, { video: { ref: STILL_VIDEO_MP4_DATA_URI, frameSrc: STILL_VIDEO_FRAME_DATA_URI } }), // floor carried over from the 32.43 dB measured on the pre-scrub (server-stills) form of this scene — the vector geometry is unchanged and the cells' raster path is the same class. RE-MEASURE PENDING (the frames now rasterize through the hybrid seam).

    // ── DONUT widget parity (SA1 — modifier-point substrate's first consumer) ─
    // Neither backend has a native ring/even-odd primitive (see
    // core/outline.js's DONUT_SEGMENTS comment), so donutPlugin.emit() ear-
    // clips the annulus into convex triangles (core/outline.js donutOutline +
    // triangulated) — the SAME polygon op fancy_arrow.js already proves
    // through both backends. Because both backends consume the IDENTICAL
    // triangle list from ONE emit() call, this scene tests real widget glue
    // (defaults, inner proportions, stroke, rotation, overlap), not
    // hand-written IR — the same rigor as calling filmstripLayout() above.
    // Three donuts: default proportions, a thin ring (inner near 1 — the
    // modifier point's near-degenerate extreme) at a rotation (proves the
    // ring's pushTransform wrap + stroke polylines survive rotation), and a
    // thick ring (inner near 0, close to a filled disk) overlapping a
    // rect so the polygon fill's edges are visually checkable against a
    // straight-edged neighbor.
    s("donut-basic", [
      rect({ x: 0, y: 0, w: SCENE_W, h: SCENE_H, fill: "#ffffff" }),
      pushTransform({ x: 40, y: 40 }),
      ...donutPlugin.emit({ ...donutPlugin.defaults, w: 120, h: 120, inner: 0.5, fill: "#bb9af7", stroke: INK, strokeWidth: 3 }),
      popTransform(),
      pushTransform({ x: 230, y: 60, rotation: 0.5 }),
      ...donutPlugin.emit({ ...donutPlugin.defaults, w: 100, h: 100, inner: 0.85, fill: "#9ece6a", stroke: INK, strokeWidth: 2 }),
      popTransform(),
      rect({ x: 190, y: 190, w: 140, h: 90, fill: "#7aa2f7" }),
      pushTransform({ x: 260, y: 235 }),
      ...donutPlugin.emit({ ...donutPlugin.defaults, w: 110, h: 110, inner: 0.15, fill: "#f7768e", opacity: 0.85 }),
      popTransform(),
    ], 32), // measured 37.42 dB (2026-07 run) — pure vector triangulated-polygon fill + stroke polylines, same class as arrows-crossing (37 floor, 41.32 measured); floor = measured − ~5.4 dB (the arrows-crossing scene's own measured-to-floor margin) for AA/rotation/translucency headroom. PENDING USER RATIFICATION (same convention as every other scene's floor in this file).

    // ── CROP BOX parity (SA2 — manifest ARCHITECTURE PLAN #3) ─────────────────
    // Built the SAME way as donut-basic above: real cropboxPlugin.emit() calls
    // (not hand-written cropSubtree IR), so this exercises actual widget glue.
    // `content` (emit()'s second arg) carries the target's ABSOLUTE world
    // transform (see ports.sceneIR's doc comment) — a SEPARATE, independent
    // pushTransform per crop box's `box()` wrap below, never nested inside
    // it. This scene's rotated box (#2) is what caught a real PDF backend
    // bug (fixed in pdf_backend.js's emitCrop): content re-emitted while the
    // crop box's OWN cmSimilarity(world) was still on the CTM, double-
    // applying its rotation — the fix resets the CTM to the page base frame
    // (cmSimilarity(T.invert(world))) right after the clip, before content.
    s("cropbox-basic", (() => {
      const content = (wx, wy, rotation = 0) => [
        pushTransform({ x: wx, y: wy, rotation }),
        rect({ x: -55, y: -35, w: 90, h: 70, fill: "#7aa2f7", stroke: INK, strokeWidth: 2 }),
        ellipse({ cx: 15, cy: 20, rx: 40, ry: 40, fill: "#f7768e", stroke: INK, strokeWidth: 2 }),
        popTransform(),
      ];
      // A crop box's emit() returns LOCAL-space commands (x:0,y:0-relative —
      // like every plugin), so EACH box still needs sceneIR's own
      // pushTransform(node.world) wrap around it for ITS x/y/rotation to take
      // effect. `content`, passed as emit()'s second arg, stays OUTSIDE that
      // wrap (it is not nested — see above) and carries its own independent
      // ABSOLUTE pushTransform, matching real sceneIR usage exactly.
      const box = (state, contentAbs) => [pushTransform(state), ...cropboxPlugin.emit(state, contentAbs), popTransform()];
      return [
        rect({ x: 0, y: 0, w: SCENE_W, h: SCENE_H, fill: "#ffffff" }),
        // 1. Axis-aligned rounded crop over a rect+circle pair straddling the
        //    region boundary (proves the clip edge is exactly the rounded
        //    rect, both backends' rounded-rect path — SHAPE_WGSL/CROP_WGSL's
        //    shared sdRoundBox vs pdf_backend rectPath — must agree).
        ...box({ ...cropboxPlugin.defaults, x: 20, y: 30, w: 100, h: 100, cornerRadius: 24, fill: "#eef1f8", stroke: INK, strokeWidth: 3 }, content(70, 80)),
        // 2. The SAME crop rotated 45° (manifest verification requirement:
        //    "crop clips at 45° rotation too") — the clip region rotates as
        //    a rigid unit; its target's content is INDEPENDENTLY placed at
        //    the box's rotated world center with the SAME rotation, so it
        //    reads as "the same content, seen through a rotated window"
        //    (exactly what a real target's suppressed-and-reattached render
        //    looks like — the target itself doesn't move, but here there is
        //    no shared document state, so this scene fakes a target that
        //    happens to be centered and co-rotated with its crop box).
        ...box({ ...cropboxPlugin.defaults, x: 210, y: 40, w: 90, h: 90, rotation: Math.PI / 4, cornerRadius: 18, fill: "#eef1f8", stroke: "#7a3a3a", strokeWidth: 3 }, content(255, 85, Math.PI / 4)),
        // 3. Dangling target (content: []) — fill+border only.
        ...box({ ...cropboxPlugin.defaults, x: 60, y: 190, w: 110, h: 80, cornerRadius: 12, fill: "#f4e9d8", stroke: INK, strokeWidth: 2 }, null),
      ];
    })(), 20), // measured 23.38 dB (2026-07-15 live parity run, after the emitCrop rotation-double-apply fix above) — floor = measured − ~3.4 dB, matching the codebase's measured-minus-margin convention. PENDING USER RATIFICATION (the floor-setting convention itself is flagged app-wide, not specific to this scene). Same clip-edge-AA divergence class as the magnifier-lens scenes (floor 20, measured 23.46-23.94) — expected, since crop box reuses that machinery.

    // ── ARROW VARIANTS parity (SB1 — manifest ARCHITECTURE PLAN #6) ───────────
    // Built the SAME way as donut-basic/cropbox-basic above: real
    // elbowArrowPlugin.emit()/curvedArrowPlugin.emit() calls (not hand-written
    // IR), so this exercises actual widget glue — the route/bezier generators
    // (core/outline.js elbowRoute/curvedArrowPolyline), the shared head
    // geometry (core/endpoints.js headTriangle/shaftPullback), and the
    // stroke/strokeWidth naming migration's post-migration property names, all
    // through the exact same emit() the editor and CLI renderer call. Both new
    // routes reduce to the render_gpu polyline op (any point count >= 2), so
    // no backend changes were needed for either shape — this scene is what
    // PROVES that (verified: pdf_backend.js's polyline case already handles
    // an arbitrary-length cmd.points array via pointsPath).
    s("elbow-curved-arrows", [
      rect({ x: 0, y: 0, w: SCENE_W, h: SCENE_H, fill: "#ffffff" }),
      rect({ x: 30, y: 20, w: 90, h: 60, fill: "#7aa2f7" }),
      ellipse({ cx: 330, cy: 240, rx: 50, ry: 35, fill: "#f7768e" }),
      // Elbow arrow: H-V-H route, elbow at a non-0.5 proportion (proves the
      // route generator's `t` parameter actually shapes the corner, not just
      // its default) — headMode "end" (legacy default).
      ...elbowArrowPlugin.emit({ ...elbowArrowPlugin.defaults, from: { x: 40, y: 90 }, to: { x: 200, y: 200 }, elbow: 0.7, stroke: INK, strokeWidth: 4 }),
      // Curved arrow: positive bend (proves the sampled-polyline shaft
      // actually bows off the straight line, not just connects the endpoints).
      ...curvedArrowPlugin.emit({ ...curvedArrowPlugin.defaults, from: { x: 60, y: 260 }, to: { x: 260, y: 260 }, bend: 0.35, stroke: "#7a3a3a", strokeWidth: 4 }),
      // Curved arrow: negative bend, crossing the first — proves the sign
      // convention actually reverses which side the arc bows toward.
      ...curvedArrowPlugin.emit({ ...curvedArrowPlugin.defaults, from: { x: 220, y: 40 }, to: { x: 380, y: 140 }, bend: -0.3, stroke: "#3a5a3a", strokeWidth: 3 }),
    ], 38), // measured 43.82 dB (2026-07-15 live parity run) — floor = measured − ~5.4 dB, matching the codebase's measured-minus-margin convention (same margin as donut-basic/arrows-crossing). PENDING USER RATIFICATION (the floor-setting convention itself is flagged app-wide, not specific to this scene).

    // headMode "both": basic arrow with a mirrored head at BOTH ends (manifest
    // ARCHITECTURE PLAN #6: "Head options on ALL arrows... both"). Uses the
    // BASIC arrow plugin (not a new variant) since headMode applies uniformly
    // across straight/elbow/curved — this scene's job is proving the shared
    // headEnds/headTriangle mirroring math, which elbow-curved-arrows above
    // doesn't exercise (both its arrows use the legacy "end"-only default).
    s("arrow-head-both", [
      rect({ x: 0, y: 0, w: SCENE_W, h: SCENE_H, fill: "#ffffff" }),
      ...arrowPlugin.emit({ ...arrowPlugin.defaults, from: { x: 40, y: 80 }, to: { x: 360, y: 80 }, headMode: "both", stroke: INK, strokeWidth: 4 }),
      // A steeper diagonal double-header at a different scale — proves the
      // mirrored start-head triangle math is axis-covariant, not just correct
      // for the horizontal case above.
      ...arrowPlugin.emit({ ...arrowPlugin.defaults, from: { x: 60, y: 150 }, to: { x: 300, y: 260 }, headMode: "both", headLength: 22, headWidth: 18, stroke: "#7a3a3a", strokeWidth: 5 }),
    ], 40), // measured 45.69 dB (2026-07-15 live parity run) — floor = measured − ~5.4 dB, matching the codebase's measured-minus-margin convention (same margin as donut-basic/arrows-crossing). PENDING USER RATIFICATION (the floor-setting convention itself is flagged app-wide, not specific to this scene).

    // ── CODE BLOCK widget parity (Opus33 — manifest Round 12D) ────────────────
    // Real codeblockPlugin.emit() (not hand-written IR), so this exercises the
    // actual widget glue: the offline highlighter (core/codeHighlight.js) → per-
    // token colored single-run text ops in the committed JetBrains Mono face laid
    // on the mono grid, plus the box (fill/border/rounding) and the line-number
    // gutter. `font: true` makes the parity harness embed the SHARED committed
    // JetBrains Mono TTF (same face the GPU atlas uses), so colored mono text
    // renders indistinguishably in the PDF — the PDF per-run color already works.
    // Highlights js (keyword/string/comment/function/number colors), the gutter,
    // and a rounded bordered box over a plain background.
    s("code-block", [
      rect({ x: 0, y: 0, w: SCENE_W, h: SCENE_H, fill: "#ffffff" }),
      pushTransform({ x: 24, y: 24 }),
      ...codeblockPlugin.emit({
        ...codeblockPlugin.defaults,
        w: 352, h: 252, fontSize: 15, lineNumbers: true, language: "javascript", theme: "dark",
        code: "// factorial\nfunction fact(n) {\n  if (n <= 1) return 1;\n  return n * fact(n - 1);\n}\nconst answer = fact(5);",
      }),
      popTransform(),
    ], 20, { font: true }), // floor 20 dB is the committed-font baseline (matches font-families' 20 dB start) — colored mono over a dark box; measured value + a measured-minus-margin floor land in the next live parity run. PENDING USER RATIFICATION.

    // ── BORDERED + ROUNDED MEDIA parity (Opus22 — manifest "SHARED STYLE
    //    BUNDLES: images and videos inherit stroke/rounding at once") ──────────
    // Built the SAME way as cropbox-basic/donut-basic: REAL imagePlugin.emit()/
    // videoPlugin.emit() calls (not hand-written IR), so this exercises the
    // actual widget glue — the stroked-box decoration (render_gpu/decorate.js)
    // wrapping the media quad in a cropSubtree (rounded-corner clip + border
    // ring, reusing the crop-box machinery), the world-carrying content contract
    // (emit's 3rd arg), and the edge-crop source-rect math. Each media call is
    // wrapped in pushTransform(world)/popTransform() exactly as ports.sceneIR
    // wraps a node's emitted commands (so the box region maps through the world;
    // the cropSubtree content carries its own absolute world inside). Because a
    // decorated image emits a cropSubtree (the SAME op the cropbox-basic scene
    // already parity-tests), parity holds by construction — the border+clip is
    // the crop machinery, and undecorated media (the image-basic scene above)
    // still emits a bare image op unchanged.
    (() => {
      // sceneIR-style wrap: a node's emit output under its absolute world.
      const node = (plugin, state) => {
        const world = { x: state.x, y: state.y, rotation: state.rotation ?? 0, scale: state.scale ?? 1 };
        // emit works in LOCAL space (x:0,y:0-relative); world lives on the wrap +
        // (for the cropSubtree content) is passed as emit's 3rd arg. Zero out
        // x/y so the local emit is origin-relative, matching sceneIR.
        const local = { ...state, x: 0, y: 0 };
        return [pushTransform(world), ...plugin.emit(local, null, world), popTransform()];
      };
      return s("bordered-rounded-image", [
        rect({ x: 0, y: 0, w: SCENE_W, h: SCENE_H, fill: "#ffffff" }),
        // 1. A rounded + bordered image (the user's motivating case: "rounded
        //    options on the image"). cornerRadius clips the checker to rounded
        //    corners; the stroke ring frames it.
        ...node(imagePlugin, { ...imagePlugin.defaults, src: CHECKER_PNG_DATA_URI, x: 24, y: 30, w: 150, h: 110, cornerRadius: 22, stroke: INK, strokeWidth: 4 }),
        // 2. The SAME rotated 45° — the rounded clip + border rotate as a rigid
        //    unit with the content (the crop-machinery rotation path, the exact
        //    case that caught the PDF double-rotation bug in cropbox-basic).
        ...node(imagePlugin, { ...imagePlugin.defaults, src: CHECKER_PNG_DATA_URI, x: 250, y: 40, w: 110, h: 90, rotation: Math.PI / 4, cornerRadius: 16, stroke: "#7a3a3a", strokeWidth: 3 }),
        // 3. Border only (no rounding) at reduced opacity — the CONTENT fades
        //    (the opacity rides on the image op; the border stays opaque — the
        //    parity-safe opacity contract, decorate.js).
        ...node(imagePlugin, { ...imagePlugin.defaults, src: CHECKER_PNG_DATA_URI, x: 60, y: 180, w: 130, h: 90, cornerRadius: 0, stroke: INK, strokeWidth: 5, opacity: 0.6 }),
      ], 18, {}); // measured 21.32 dB (2026-07-15 live run) — floor = measured − ~3.4 (the cropbox-basic 20→23.38 margin). This scene combines the tiny-checker upsample edge-AA (image-basic 25→28.83) with the rounded-clip edge-AA (cropbox-basic), so its residual is the SUM of those two AA classes — the sibling bordered-rounded-VIDEO measures 28.90 (a full-res frame has gentler edges than the 64×48 checker). PENDING USER RATIFICATION (the measured-minus-margin convention is flagged app-wide).
    })(),

    // Bordered + rounded VIDEO (the still-frame fixture), same decoration as the
    // image scene — proves the SHARED bundle reaches video identically. Carries
    // `video:` so the parity harness ensures the <video> frame + supplies the
    // PDF frame resolver (like the other video scenes).
    (() => {
      const node = (plugin, state) => {
        const world = { x: state.x, y: state.y, rotation: state.rotation ?? 0, scale: state.scale ?? 1 };
        const local = { ...state, x: 0, y: 0 };
        return [pushTransform(world), ...plugin.emit(local, null, world), popTransform()];
      };
      return s("bordered-rounded-video", [
        rect({ x: 0, y: 0, w: SCENE_W, h: SCENE_H, fill: "#ffffff" }),
        ...node(videoPlugin, { ...videoPlugin.defaults, src: STILL_VIDEO_MP4_DATA_URI, x: 40, y: 40, w: 180, h: 130, cornerRadius: 24, stroke: INK, strokeWidth: 4 }),
        ...node(videoPlugin, { ...videoPlugin.defaults, src: STILL_VIDEO_MP4_DATA_URI, x: 250, y: 150, w: 120, h: 100, cornerRadius: 12, stroke: "#7a3a3a", strokeWidth: 3, opacity: 0.7 }),
      ], 20, { video: { ref: STILL_VIDEO_MP4_DATA_URI, frameSrc: STILL_VIDEO_FRAME_DATA_URI } }); // floor 20 matches video-basic's clip-edge-AA class; measured + margin land next live run. PENDING USER RATIFICATION.
    })(),

    // EDGE-CROP INSETS parity (Opus22 — manifest "Edge-crop insets"): nonzero
    // per-edge insets on an image. The GPU crops the source via the quad's UV
    // rect; the PDF via a clip-to-dest + scaled-up image matrix (imagePlacementOps)
    // — the SAME source-rect crop, so the visible sub-region matches. Includes an
    // undecorated cropped image (bare cropped op) AND a cropped + bordered one
    // (the crop feeds decorateStrokedBox, which frames the CROPPED rect).
    (() => {
      const node = (plugin, state) => {
        const world = { x: state.x, y: state.y, rotation: state.rotation ?? 0, scale: state.scale ?? 1 };
        const local = { ...state, x: 0, y: 0 };
        return [pushTransform(world), ...plugin.emit(local, null, world), popTransform()];
      };
      return s("image-crop-insets", [
        rect({ x: 0, y: 0, w: SCENE_W, h: SCENE_H, fill: "#ffffff" }),
        // 1. Cropped only (no border): 25% trimmed off left+top of the checker,
        //    12% off right+bottom — the surviving sub-region keeps its scale.
        ...node(imagePlugin, { ...imagePlugin.defaults, src: CHECKER_PNG_DATA_URI, x: 24, y: 30, w: 160, h: 120, cropLeft: 40, cropTop: 30, cropRight: 20, cropBottom: 14 }),
        // 2. Cropped + rounded + bordered: the crop shrinks the quad, then the
        //    border/rounding frames the CROPPED rect (frame hugs the visible
        //    pixels). Exercises crop-then-decorate composition.
        ...node(imagePlugin, { ...imagePlugin.defaults, src: CHECKER_PNG_DATA_URI, x: 230, y: 60, w: 140, h: 140, cropLeft: 24, cropTop: 24, cropRight: 24, cropBottom: 24, cornerRadius: 14, stroke: INK, strokeWidth: 3 }),
      ], 22, {}); // floor 22 matches the image-basic clip/crop edge-AA class; measured + margin land next live run. PENDING USER RATIFICATION.
    })(),

    // ── RICH TEXT parity (Opus21 — manifest "RICH TEXT") ────────────────────
    // Both backends run the SAME shared layout (core/richtext.layoutRichText)
    // with their OWN canvas2D measure seam, so wrapped multi-run text lands at
    // the SAME positions in GPU pixels and PDF vector operators — the parity
    // lever. These scenes use the COMMITTED fonts (font:true → the harness feeds
    // loadFontBytes/fontkit/measureText), so raster and vector share the face.
    // Covered: BOLD, ITALIC (GPU: canvas synth-oblique; PDF: text-matrix shear
    // — a documented delta on faces WITH a real italic; Inter/Lora have italics
    // so this scene carries that residual), UNDERLINE, STRIKETHROUGH, mixed
    // SIZES, mixed FONTS, a hard newline, and box-constrained WORD WRAP.
    s("richtext-wrapped", [
      rect({ x: 0, y: 0, w: SCENE_W, h: SCENE_H, fill: "#ffffff" }),
      text({
        // Non-empty plain-text fallback (first run) so the single-run degrade
        // path — taken when no measureText seam is present, e.g. the node
        // structural test — still emits a Tj; the parity test injects
        // measureText and takes the RICH path.
        text: "Bold ", x: 24, y: 24, size: 28, color: INK,
        rich: normalizeRichText({
          runs: [
            { text: "Bold ", bold: true, font: "inter", size: 28, color: INK },
            { text: "italic ", italic: true, font: "inter", size: 28, color: "#7a1030" },
            { text: "under", underline: true, font: "inter", size: 28, color: "#106a30" },
            { text: "strike ", strike: true, font: "inter", size: 28, color: "#104a7a" },
            { text: "then a longer serif paragraph that must wrap across the box width",
              font: "lora", size: 20, color: INK },
          ],
          paras: [{ align: "left" }],
        }, {}),
        boxW: SCENE_W - 48, boxH: SCENE_H - 48,
        boxStyle: { align: "left", lineSpacing: 1.15, charSpacing: 0, wordSpacing: 0 },
      }),
    ], 20, { font: true }), // committed-face shared layout; floor 20 = the committed-font baseline (font-families class). Italic faces carry the synth-oblique-vs-shear delta; measured + margin land next live run. PENDING USER RATIFICATION.

    // Alignment variants (left / center / right / justify) of the SAME wrapping
    // text, stacked — proves the per-paragraph alignment + justify inter-word
    // stretch match between backends.
    s("richtext-align", [
      rect({ x: 0, y: 0, w: SCENE_W, h: SCENE_H, fill: "#ffffff" }),
      ...["left", "center", "right", "justify"].map((align, i) =>
        text({
          // Non-empty plain fallback (see richtext-wrapped) — keeps the
          // node structural test's hasText/vectorText invariant on the degrade.
          text: "The quick brown fox", x: 20, y: 20 + i * 70, size: 16, color: INK,
          rich: normalizeRichText({
            runs: [{ text: "The quick brown fox jumps over the lazy dog again", font: "source-serif", size: 16, color: INK }],
            paras: [{ align }],
          }, {}),
          boxW: SCENE_W - 40, boxH: 64,
          boxStyle: { align, lineSpacing: 1.1, charSpacing: 0, wordSpacing: 0 },
        })),
    ], 20, { font: true }), // per-paragraph alignment + justify parity; floor 20 committed-font baseline; measured + margin next live run. PENDING USER RATIFICATION.

    // Round 15.6: VERTICAL alignment (valign) parity — three tall boxes, each
    // shorter-than-box multi-paragraph text placed top / middle / bottom, with
    // MIXED per-paragraph horizontal aligns inside (left + right). Proves the
    // core valign offset (layoutRichText shifts the whole line stack) lands at
    // the SAME pixels/operators in BOTH backends (they consume richTextDraws, so
    // the vertical offset is inherited with zero backend code) AND that valign is
    // orthogonal to the per-paragraph horizontal align.
    s("richtext-valign", [
      rect({ x: 0, y: 0, w: SCENE_W, h: SCENE_H, fill: "#ffffff" }),
      ...["top", "middle", "bottom"].map((valign, i) =>
        text({
          text: "V-align", x: 8 + i * 130, y: 10, size: 14, color: INK,
          rich: normalizeRichText({
            runs: [{ text: "Top line\nbottom line", font: "inter", size: 14, color: INK }],
            // mixed per-paragraph align: para 0 left, para 1 right — tests the
            // orthogonality of vertical (box) and horizontal (paragraph) axes.
            paras: [{ align: "left" }, { align: "right" }],
          }, {}),
          boxW: 120, boxH: SCENE_H - 20, // tall box ⇒ real vertical slack
          boxStyle: { align: "left", lineSpacing: 1.2, charSpacing: 0, wordSpacing: 0, valign },
        })),
    ], 20, { font: true }), // valign parity; the same committed-font text-AA class as its richtext siblings (floor 20 = the committed-font baseline; richtext-wrapped/align run ~3 dB above 20). Measured + measured-minus-margin land in the next live parity run. PENDING USER RATIFICATION.

    // Round 13.4: per-run OUTLINE (glyph stroke) + HIGHLIGHT (background) parity.
    // GPU: atlas strokeText cell + rect-SDF background; PDF: Tr 2 stroke + re/f
    // rect; SVG: paint-order="stroke" + background <rect>. One run of each so the
    // three backends' outline/highlight render match.
    s("richtext-outline-highlight", [
      rect({ x: 0, y: 0, w: SCENE_W, h: SCENE_H, fill: "#ffffff" }),
      text({
        text: "Outline ", x: 24, y: 40, size: 30, color: INK,
        rich: normalizeRichText({
          runs: [
            { text: "Outline ", font: "inter", size: 30, color: "#ffffff", outlineColor: "#104a7a", outlineWidth: 2 },
            { text: "Highlight ", font: "inter", size: 30, color: "#1a1a2e", highlight: "#ffe14d" },
            { text: "both", font: "inter", size: 30, color: "#ffffff", outlineColor: "#7a1030", outlineWidth: 1.5, highlight: "#c8e0ff" },
          ],
          paras: [{ align: "left" }],
        }, {}),
        boxW: SCENE_W - 48, boxH: SCENE_H - 48,
        boxStyle: { align: "left", lineSpacing: 1.2, charSpacing: 0, wordSpacing: 0 },
      }),
    ], 20, { font: true }), // outline+highlight parity; measured 23.20 dB (2026-07-15 live run) — floor 20 matches its richtext siblings' convention exactly (richtext-wrapped 22.91→20, richtext-align 22.34→20: the text-AA class runs ~3 under measured). Outline stroke = the atlas-strokeText vs PDF-Tr-stroke class. PENDING USER RATIFICATION (the measured-minus-margin convention is flagged app-wide).

    // ══ EFFECTS SUBSTRATE parity (manifest Round 12D — shadow/bloom/blend;
    // render_gpu/effects.js). Every scene builds through the real plugin
    // emit() (the node() sceneIR-wrap idiom), so the effect-wrapping path is
    // the production one. Floors are measured − margin, PENDING RATIFICATION
    // (values locked from the live parity run). ══

    // DROP SHADOW: raster shadow PNG under VECTOR content (the hybrid rule's
    // verbatim "compositing a shadow png under a vector thingy"). Includes a
    // ROTATED shadowed rounded rect — the offset stays canvas-space (does not
    // rotate with the widget, the Figma/PPT convention).
    (() => {
      const node = (plugin, state) => {
        const world = { x: state.x, y: state.y, rotation: state.rotation ?? 0, scale: state.scale ?? 1 };
        const local = { ...state, x: 0, y: 0 };
        return [pushTransform(world), ...plugin.emit(local, null, world), popTransform()];
      };
      return s("effects-shadow-rect", [
        rect({ x: 0, y: 0, w: SCENE_W, h: SCENE_H, fill: "#ffffff" }),
        ...node(rectPlugin, { ...rectPlugin.defaults, x: 50, y: 45, w: 150, h: 95, shadow: { dx: 8, dy: 8, blur: 6, color: "#000000", opacity: 0.6 } }),
        ...node(rectPlugin, { ...rectPlugin.defaults, x: 240, y: 130, w: 110, h: 85, rotation: Math.PI / 6, cornerRadius: 14, fill: "#9ece6a", shadow: { dx: 6, dy: 6, blur: 4, color: "#7a3a3a", opacity: 0.5 } }),
      ], 37, {}); // Round 17.5: RESTORED to 37 (measured 40.35 dB, GPU-separable vs PDF-raster) after useAnalyticShadow was toggled OFF. (OpusN's 15.5 re-pin to 27 was for the analytic path @31.27 dB; with analytic off these rects — rectPlugin.defaults carries strokeWidth:2, so stroked → fallback anyway — render through the separable blur again.) PENDING RATIFICATION.
    })(),

    // BLOOM: the widget's own blurred copy ADD-composited on top; the widget
    // becomes a hybrid raster region in the PDF (GPU-rendered pixels, so the
    // residual is resample-only + the documented halo-alpha divergence).
    (() => {
      const node = (plugin, state) => {
        const world = { x: state.x, y: state.y, rotation: state.rotation ?? 0, scale: state.scale ?? 1 };
        const local = { ...state, x: 0, y: 0 };
        return [pushTransform(world), ...plugin.emit(local, null, world), popTransform()];
      };
      return s("effects-bloom-circle", [
        rect({ x: 0, y: 0, w: SCENE_W, h: SCENE_H, fill: "#1a1a2e" }), // dark bg: bloom reads as glow
        ...node(circlePlugin, { ...circlePlugin.defaults, x: 80, y: 60, w: 130, h: 130, fill: "#e0af68", strokeWidth: 0, bloom: { radius: 12, strength: 1 } }),
        ...node(circlePlugin, { ...circlePlugin.defaults, x: 250, y: 140, w: 90, h: 90, fill: "#7aa2f7", strokeWidth: 0, bloom: { radius: 6, strength: 0.6 } }),
      ], 25, {}); // measured 28.27 dB (2026-07-15 live run) — GPU-rendered raster region + the documented bloom halo-alpha divergence; floor = measured − ~3.3. PENDING USER RATIFICATION.
    })(),

    // BLEND MODE multiply: an image multiplied against the page — GPU
    // fixed-function (dst, one-minus-src-alpha) vs the PDF's exact
    // /BM Multiply ExtGState on the raster region; the backdrop stays vector.
    (() => {
      const node = (plugin, state) => {
        const world = { x: state.x, y: state.y, rotation: state.rotation ?? 0, scale: state.scale ?? 1 };
        const local = { ...state, x: 0, y: 0 };
        return [pushTransform(world), ...plugin.emit(local, null, world), popTransform()];
      };
      return s("effects-multiply-image", [
        rect({ x: 0, y: 0, w: SCENE_W, h: SCENE_H, fill: "#ffffff" }),
        rect({ x: 0, y: 0, w: SCENE_W / 2, h: SCENE_H, fill: "#9ece6a" }),   // left half green
        rect({ x: SCENE_W / 2, y: 0, w: SCENE_W / 2, h: SCENE_H, fill: "#e0af68" }), // right half amber
        ...node(imagePlugin, { ...imagePlugin.defaults, src: CHECKER_PNG_DATA_URI, x: 100, y: 70, w: 200, h: 150, blendMode: "multiply" }),
      ], 34, {}); // measured 37.38 dB (2026-07-15 live run) — /BM Multiply is an exact PDF equivalent (resample-only residual); floor = measured − ~3.4. PENDING USER RATIFICATION.
    })(),

    // BLEND MODE add: true additive compositing needs the backdrop pixels —
    // PDF has no /Add, so the whole below-region rasters (the blur split
    // precedent; emitRegion's extended split detection). GPU renders the
    // identical add, so the residual is resample-only.
    (() => {
      const node = (plugin, state) => {
        const world = { x: state.x, y: state.y, rotation: state.rotation ?? 0, scale: state.scale ?? 1 };
        const local = { ...state, x: 0, y: 0 };
        return [pushTransform(world), ...plugin.emit(local, null, world), popTransform()];
      };
      return s("effects-add-blend", [
        rect({ x: 0, y: 0, w: SCENE_W, h: SCENE_H, fill: "#1a1a2e" }),
        rect({ x: 40, y: 40, w: 180, h: 140, fill: "#7a3a3a" }),
        ...node(circlePlugin, { ...circlePlugin.defaults, x: 120, y: 80, w: 140, h: 140, fill: "#33557f", strokeWidth: 0, blendMode: "add" }),
        // a vector shape ABOVE the split proves the region above stays vector
        ellipse({ cx: 330, cy: 60, rx: 40, ry: 30, fill: "#9ece6a", stroke: INK, strokeWidth: 2 }),
      ], 38, {}); // measured 41.67 dB (2026-07-15 live run) — everything-below raster (blur-split class, exact GPU add); floor = measured − ~3.7. PENDING USER RATIFICATION.
    })(),

    // ── LATEX EQUATION widget — TRUE VECTOR parity (Round 15.1, OpusL) ─────────
    // The equation is now REAL VECTOR (manifest 15.1 "do latex properly"): the
    // latex widget emits a `latexVector` op carrying flattened MathJax glyph
    // <path>s (the SVG/PDF backends embed true vector geometry) AND a raster
    // `ref` (the GPU + the HYBRID RULE fallback draw the tinted bitmap). This
    // scene drives the REAL latexVector op with the DETERMINISTIC, OFFLINE vector
    // fixture (tests/latex_equation_vector.js — the flattened quadratic-formula
    // glyphs captured from the runtime resolveLatexGlyphs path) for the glyph
    // geometry, and the matching PNG fixture (latex_equation_png.js) for the
    // raster `ref`, which the parity harness registers under LATEX_PARITY_REF
    // before the GPU render. So the parity comparison is TRUE-VECTOR (PDF/SVG
    // path glyphs) vs the GPU's rasterized equation bitmap — the floors RISE vs
    // the old raster-vs-raster because both sides now carry the same equation but
    // the vector is crisp. Three placements exercise the op: bare, bordered+
    // rounded (the SHARED STROKED-BOX bundle), and translucent. The widget's own
    // emit→MathJax→flatten path is covered end-to-end by tests/latex_probe.js
    // (a real browser); THIS scene proves the latexVector op renders in parity.
    (() => {
      // Build a latexVector op directly (the vector fixture is bare-node; the
      // widget's emit() wrapping is exercised in the probe). INK is the fill for
      // every glyph — the vector fixture geometry is ink-independent.
      const eqOp = (x, y, w, h, opacity = 1) => latexVector({
        ref: LATEX_PARITY_REF, x, y, w, h, opacity,
        glyphs: LATEX_EQUATION_GLYPHS.map((g) => ({ d: g.d, fill: INK })),
        viewBox: LATEX_EQUATION_VIEWBOX,
      });
      // The op's world wrapper (sceneIR node idiom): a bordered+rounded variant
      // wraps the op in the shared stroked-box decoration via a plain rect frame
      // (the box bundle keeps working over the vector form — the border is its
      // own vector op, no rasterization forced).
      const framed = (x, y, w, h) => [
        eqOp(x, y, w, h),
        rect({ x, y, w, h, cornerRadius: 14, stroke: INK, strokeWidth: 4 }),
      ];
      // Draw at the equation's natural aspect (LATEX_EQUATION_W×_H) so no squash
      // distorts the glyphs — exactly what the widget's aspect-driven w/h achieve.
      const aspect = LATEX_EQUATION_W / LATEX_EQUATION_H;
      const eqH = 70, eqW = Math.round(eqH * aspect); // ~274 wide
      return s("latex-basic", [
        rect({ x: 0, y: 0, w: SCENE_W, h: SCENE_H, fill: "#ffffff" }),
        // 1. bare equation (a plain latexVector op — the common case)
        eqOp(20, 20, eqW, eqH),
        // 2. bordered + rounded equation (the SHARED STROKED-BOX bundle)
        ...framed(20, 120, eqW, eqH),
        // 3. translucent equation (opacity rides on the op)
        eqOp(200, 200, Math.round(eqW * 0.6), Math.round(eqH * 0.6), 0.5),
      ], 18, { latexRef: LATEX_PARITY_REF, latexRaster: LATEX_EQUATION_PNG_DATA_URI }); // measured 21.17 dB (2026-07-15 live vector-parity run). THE COMPARISON IS VECTOR-vs-RASTER, NOT vector-vs-vector: the PDF side is now CRISP true-vector glyph paths (poppler rasterizes them sharply), while the GPU-EXPECTED side stays the soft MathJax raster bitmap (the live GPU view is the raster quad — out of scope to make it vector, per the task brief). So the floor did NOT rise (was 21.98 raster-vs-raster) — the vector's win is CRISPNESS AT ANY ZOOM, not a higher PSNR against the bitmap it replaces; the PSNR is bounded by the raster's own AA softness. floor 18 = measured − ~3 (the bordered-rounded-image edge-AA class margin). PENDING USER RATIFICATION. latexRef/latexRaster tell the parity harness which synthetic ref to seed with the equation bitmap for the GPU-expected side.
    })(),

    // ── LATEX glyph-counter FILL-RULE correctness (Round 15.1, OpusL) ──────────
    // The FILL-RULE test the task brief calls for: an equation with glyphs that
    // have COUNTERS (holes) — e, 0, 8, a, 3. Both backends fill glyph paths with
    // NONZERO winding (`f`, not even-odd `f*`) because a font's counter contour
    // is wound OPPOSITE its outer contour — nonzero leaves the hole. A WRONG
    // even-odd rule would MISFILL nested contours (filling the holes in e/0/8/a),
    // and since this scene compares the true-vector glyphs against the CORRECT
    // MathJax raster (holes intact), a wrong rule craters the PSNR far below the
    // floor. That divergence IS the correctness gate — visually obvious in the
    // dumped {expected,pdf} images. The equation is drawn LARGE so the counters
    // are big and unambiguous.
    (() => {
      const aspect = LATEX_COUNTER_W / LATEX_COUNTER_H;
      const eqH = 90, eqW = Math.round(eqH * aspect);
      return s("latex-counters", [
        rect({ x: 0, y: 0, w: SCENE_W, h: SCENE_H, fill: "#ffffff" }),
        latexVector({
          ref: LATEX_COUNTER_REF, x: 20, y: 100, w: Math.min(eqW, SCENE_W - 40), h: eqH,
          glyphs: LATEX_COUNTER_GLYPHS.map((g) => ({ d: g.d, fill: INK })),
          viewBox: LATEX_COUNTER_VIEWBOX,
        }),
      ], 27, { latexRef: LATEX_COUNTER_REF, latexRaster: LATEX_COUNTER_PNG_DATA_URI }); // measured 30.25 dB (2026-07-15 live vector-parity run) — HIGHER than latex-basic's 21.17 because this equation is large/simple (fewer fine strokes), so the crisp-vector-vs-soft-raster agreement is tighter. floor 27 = measured − ~3. PENDING USER RATIFICATION. A WRONG even-odd fill would fill the e/0/8/a counters solid and sink this FAR below 27 — that divergence IS the fill-rule correctness gate.
    })(),

    // ── FANCY ARROW: fill + outline stroke parity (Round 17.4) ────────────────
    // Built the SAME way as donut-basic above: REAL fancyArrowPlugin.emit()
    // calls (not hand-written IR), so this exercises actual widget glue — the
    // triangulated fill AND (Round 17.4's new bit) the outline polyline drawn
    // around the outer hull when strokeWidth > 0. Both backends consume the
    // SAME triangle list AND the SAME closed-polyline points from ONE emit()
    // call, so parity holds by construction (the donut-basic precedent).
    // Three arrows: (1) fill only, strokeWidth 0 — the migrated-old-doc /
    // untouched-default case, proving NO outline draws; (2) fill + a THICK
    // contrasting outline around the whole tapered hull (the user's probe
    // case: red body, black outline, no internal triangle seams); (3) a
    // translucent fill + thin outline overlapping a rect, so the outline's
    // edges are visually checkable against a straight-edged neighbor.
    s("fancy-arrow-basic", [
      rect({ x: 0, y: 0, w: SCENE_W, h: SCENE_H, fill: "#ffffff" }),
      ...fancyArrowPlugin.emit({
        ...fancyArrowPlugin.defaults, from: { x: 20, y: 60 }, to: { x: 200, y: 60 },
        fill: "#7aa2f7", strokeWidth: 0,
      }, null, { x: 0, y: 0, rotation: 0, scale: 1 }),
      ...fancyArrowPlugin.emit({
        ...fancyArrowPlugin.defaults, from: { x: 20, y: 150 }, to: { x: 260, y: 150 },
        tipLength: 30, tipWidth: 60, tipDimple: 10, startWidth: 8, endWidth: 14,
        fill: "#f7768e", stroke: INK, strokeWidth: 6,
      }, null, { x: 0, y: 0, rotation: 0, scale: 1 }),
      rect({ x: 230, y: 200, w: 140, h: 80, fill: "#9ece6a" }),
      ...fancyArrowPlugin.emit({
        ...fancyArrowPlugin.defaults, from: { x: 60, y: 240 }, to: { x: 300, y: 240 },
        fill: "#bb9af7", stroke: INK, strokeWidth: 2, opacity: 0.85,
      }, null, { x: 0, y: 0, rotation: 0, scale: 1 }),
    ], 35), // measured 41.02 dB (2026-07-15 live PDF-parity run) — same triangulated-polygon-fill + polyline-outline parity class as donut-basic (32 floor, 37.42 measured) and arrows-crossing (37 floor, 41.32 measured); floor = measured − ~6 dB (the same measured-minus-margin convention, AA/rotation/translucency headroom). PENDING RATIFICATION (same convention as every other scene's floor in this file).
  ];
}
