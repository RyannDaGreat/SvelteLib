/**
 * THE camera's ANTI-ALIASING render-setting reader + resolvers — the AA twin of
 * dither_shader.cameraDither, kept in its own small module so the AA concern does
 * not bloat the dither file.
 *
 * WHAT IT WIRES: until now the camera's "Anti-aliasing" control was INERT — the
 * per-draw coverage AA in paint_skia.js / text_layout.js was HARDCODED on, so
 * toggling the property changed nothing. cameraAntialias(state) reads the chosen
 * mode off THE camera; antialiasCoverage(mode) resolves it to the boolean the
 * raster sinks thread into paintIR → setAntiAlias, which IS the live per-draw
 * edge-smoothing control (no surface recreation). "off" ⇒ setAntiAlias(false) ⇒
 * crisp, jagged, stair-stepped edges; "standard" ⇒ setAntiAlias(true) ⇒ today's
 * smooth look. The browser's WebGL2 context MSAA flag is a SEPARATE, coarser knob
 * set only at surface creation (browser_surface.js) — the coverage-AA path here
 * is the one that changes edges live.
 *
 * SUPERSAMPLE TODO ("high"): a smoother mode (render at 2× into an offscreen then
 * downsample) is intentionally NOT shipped. The LOUD GUARD below throws at import
 * if properties.js ever declares a mode this module does not implement, so the
 * SELECT can never offer an option that silently no-ops (the user ruling: no fake
 * options). See ANTIALIAS_MODES in core/properties.js for how to add it.
 */

import { ANTIALIAS_MODES } from "../../core/properties.js";

// ── named constants (WHY each exists — no magic numbers) ─────────────────────
const AA_OFF = "off";           // no coverage AA — crisp, jagged edges
const AA_STANDARD = "standard"; // Skia coverage AA on every draw (today's look, the default)

// The modes this module FULLY implements. Kept in lock-step with core/properties
// ANTIALIAS_MODES: a mode declared there but not here would render as a no-op, so
// the import-time guard forbids it (loud, never silent — the "no fake option"
// rule). Adding a mode (e.g. "high" supersample) means implementing it here AND
// appending it to both lists.
const SUPPORTED_MODES = [AA_OFF, AA_STANDARD];
for (const mode of ANTIALIAS_MODES)
  if (!SUPPORTED_MODES.includes(mode))
    throw new Error(`render_settings: ANTIALIAS_MODES declares "${mode}" but this module only implements ${JSON.stringify(SUPPORTED_MODES)} — wire its behavior (e.g. supersample for "high") before offering it, or the option would silently do nothing.`);

/**
 * Pure function. Reads THE camera's anti-aliasing mode out of a folded/evaluated
 * state — the first active camera item, mirroring dither_shader.cameraDither's
 * selection (first active camera by id, deterministic). Absent camera / prop, or
 * an unknown stored value, → the default ("standard"), so a pre-select document
 * renders byte-identically to today.
 *
 * @param {object} state - evaluated folded state ({items: {id: {type, ...}}})
 * @returns {string} the antialias mode id ("off" | "standard")
 *
 * @example cameraAntialias({items: {c: {type: "camera", antialias: "off"}}}) // "off"
 * @example cameraAntialias({items: {}}) // "standard"
 * @example cameraAntialias({items: {c: {type: "camera", antialias: "bogus"}}}) // "standard" (unknown → default)
 */
export function cameraAntialias(state) {
  const cams = Object.entries(state?.items ?? {})
    .filter(([, s]) => s.type === "camera" && s.active !== false)
    .sort(([a], [b]) => (a < b ? -1 : 1));
  const cam = cams.length ? cams[0][1] : {};
  return ANTIALIAS_MODES.includes(cam.antialias) ? cam.antialias : AA_STANDARD;
}

/**
 * Pure function. Whether per-draw COVERAGE anti-aliasing (Skia setAntiAlias) is
 * on for a mode — every mode except "off". This is the boolean the raster sinks
 * thread into paintIR; a future "high" supersample mode still has coverage AA on
 * (it ADDS supersampling on top), so the ONLY off case is "off".
 *
 * @param {string} mode - an antialias mode id
 * @returns {boolean} true ⇒ setAntiAlias(true) (smooth); false ⇒ crisp/jagged
 *
 * @example antialiasCoverage("standard") // true
 * @example antialiasCoverage("off") // false
 */
export function antialiasCoverage(mode) {
  return mode !== AA_OFF;
}
