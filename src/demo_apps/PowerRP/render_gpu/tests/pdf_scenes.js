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

import { rect, ellipse, polyline, polygon, text, pushTransform, popTransform, blurBackdrop, magnifyBackdrop } from "../ir.js";

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
    ], 16), // measured 19.68 dB — text-heavy: standard-14 Helvetica vs the atlas's system-ui dominates; rises when the fonts task embeds one shared TTF

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
  ];
}
