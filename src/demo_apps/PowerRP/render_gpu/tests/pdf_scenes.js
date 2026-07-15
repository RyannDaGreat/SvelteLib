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

import { rect, ellipse, polyline, polygon, text, image, video, pushTransform, popTransform, blurBackdrop, magnifyBackdrop } from "../ir.js";
import { CHECKER_PNG_DATA_URI } from "../../tests/fixtures/checker_png.js";
import { STILL_VIDEO_MP4_DATA_URI, STILL_VIDEO_FRAME_DATA_URI } from "../../tests/fixtures/still_video.js";
import { filmstripLayout } from "../../plugins/filmstrip.js";

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
  ];
}
