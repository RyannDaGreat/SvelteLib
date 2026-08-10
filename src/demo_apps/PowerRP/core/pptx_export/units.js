/**
 * UNIT CONVERSION — PowerRP canvas px -> OOXML EMU/60,000ths-of-a-degree. The
 * export-side mirror of core/pptx/deck.js's read-side unit convention (that
 * file's header states EMU deliberately UNCONVERTED at parse time, because
 * "that conversion depends on a target DPI/zoom stage 2 owns" — this module
 * IS that stage 2, for the opposite direction).
 *
 * PowerRP's own canvas has no stated DPI anywhere (measured: no EMU/DPI
 * constant exists outside this file and render_gpu/pdf_display.js's UNRELATED
 * PDF-rasterization pair). 96 DPI is the value this module commits to: a
 * document's default slide size (1280x720, core/document.js DEFAULT_SLIDE_W/H)
 * divides evenly by 96 into 13.333"x7.5" — exactly PowerPoint's own "Widescreen
 * (16:9)" slide size in inches — which is strong corroborating evidence that
 * 96 DPI is PowerRP's implicit ambient assumption, not an arbitrary pick.
 */

/** EMU per PowerRP canvas pixel: 914400 EMU/inch ÷ 96 px/inch. */
export const EMU_PER_PX = 9525;

/** 60,000ths of a degree per degree — OOXML's `rot`/`ang` attribute unit. */
export const SIXTY_THOUSANDTHS_PER_DEGREE = 60000;

/**
 * Pure function. PowerRP canvas px -> EMU, rounded to the nearest integer
 * (OOXML lengths are integers; a fractional EMU has no meaning to PowerPoint).
 *
 * @param {number} px
 * @returns {number}
 *
 * @example pxToEmu(1280) // 12192000
 * @example pxToEmu(0) // 0
 */
export function pxToEmu(px) {
  return Math.round(px * EMU_PER_PX);
}

/**
 * Pure function. Radians (PowerRP's rotation unit, core/transform.js) -> OOXML
 * `rot` units (60,000ths of a degree, clockwise from 3 o'clock) — the SAME
 * rotational sense as PowerRP's, since both measure in screen space with +y
 * down, so no sign flip is needed. Wrapped into [0, 360) degrees first: OOXML's
 * `rot` is conventionally a small non-negative integer, and PowerRP's own
 * rotation is UNWRAPPED (may exceed +-2pi mid-tween per core/transform.js) —
 * a static per-slide export has no "mid-spin" to preserve, so wrapping loses
 * nothing a still picture could show.
 *
 * @param {number} radians
 * @returns {number}
 *
 * @example radiansToRot60k(0) // 0
 * @example radiansToRot60k(Math.PI) // 10800000
 * @example radiansToRot60k(Math.PI / 2) // 5400000
 */
export function radiansToRot60k(radians) {
  const degrees = ((radians * 180) / Math.PI) % 360;
  const wrapped = ((degrees % 360) + 360) % 360;
  return Math.round(wrapped * SIXTY_THOUSANDTHS_PER_DEGREE);
}

/**
 * Pure function. Degrees -> OOXML angle units (60,000ths of a degree), wrapped
 * into [0, 360) first — the gradient-angle counterpart of radiansToRot60k, used
 * because PowerRP stores gradient angle directly in degrees
 * (core/properties.js) rather than radians.
 *
 * @param {number} degrees
 * @returns {number}
 *
 * @example degreesToAng60k(0) // 0
 * @example degreesToAng60k(90) // 5400000
 * @example degreesToAng60k(-90) // 16200000
 */
export function degreesToAng60k(degrees) {
  const wrapped = ((degrees % 360) + 360) % 360;
  return Math.round(wrapped * SIXTY_THOUSANDTHS_PER_DEGREE);
}
