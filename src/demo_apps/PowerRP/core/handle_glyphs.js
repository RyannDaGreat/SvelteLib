/**
 * THE HANDLE GLYPH BANK — the closed vocabulary of LOOKS a modifier point may
 * wear, so that two handles of different ROLES sitting on the same widget read
 * apart before you drag either one.
 *
 * THE PROBLEM (user, 2026-08-02, verbatim): "it's not always clear what handle is
 * what. Is it like, does it belong to the shape or belong to the gradient?" A
 * shape's vertex handle and its gradient's centre bead were the SAME yellow
 * square, drawn by the same branch, distinguishable only by dragging one and
 * watching what moved. Two fixes ship together and are deliberately independent:
 * a `label` (the hover tooltip — words, on demand) and a `glyph` (this file — a
 * look, always visible). Either alone is worse: a tooltip requires a hover to ask
 * a question the picture should already answer, and a glyph alone is a code the
 * reader has to learn.
 *
 * WHY THIS LIVES IN core/ AND NOT render_gpu/ OR web/. It is DISPLAY VOCABULARY,
 * not rendering: nothing here draws, it only names shapes and marks and hands
 * back a plain description. Two constraints then decide the folder outright:
 *
 *   1. THE DECLARERS ARE IN core/ AND plugins/. `core/paint_handles.js` and any
 *      widget declaring `glyph: "..."` must be able to import the key list to
 *      validate against, and neither may depend UP on render_gpu/ or web/ (the
 *      same rule that keeps core/ bare-node testable — plugins run under
 *      cli/render.js with no DOM anywhere).
 *   2. IT IS BACKEND-NEUTRAL BY CONSTRUCTION. A glyph is {shape, mark, accent} —
 *      three enum-ish fields — never an SVG string, a path, a canvas call or a
 *      CSS colour. web/CanvasView.svelte renders it to SVG today; the same
 *      description would render to Skia or to a hypothetical DOM overlay with no
 *      change here. Had this file emitted markup it would have been web-only and
 *      the plugins could not have named it.
 *
 * It is a BANK, not a config surface. A row picks a key from a fixed list; it
 * cannot spell an arbitrary look. That is on purpose — handles are a shared
 * visual LANGUAGE across every widget, and an open {shape, mark, colour} soup in
 * each plugin's row would let two widgets mint two different appearances for the
 * same role and one appearance for two different roles. Adding a glyph means
 * adding an entry HERE, where the whole vocabulary is visible on one screen and a
 * clash is obvious.
 *
 * THE DEFAULT IS THE OLD LOOK, EXACTLY. `handleGlyph(undefined)` and
 * `handleGlyph("default")` both return the plain accent-less square, which is
 * byte-identical to what every handle drew before this file existed — so every
 * widget that declares nothing renders unchanged, and this feature is purely
 * additive.
 *
 * DOM-free pure JS (bare-node testable, like the rest of core/).
 */

/**
 * THE BANK. Each entry is {shape, mark, accent, description}:
 *
 *   shape  — the outline: "square" | "circle" | "triangle" | "diamond".
 *   mark   — the INNER mark drawn on top: "none" | "x" | "o" | "dot". A mark is
 *            drawn in the RIM colour, not a new one, so it reads as engraving on
 *            the glyph rather than a second object sitting on it.
 *   accent — which colour family the fill takes: "default" (the PPT-yellow
 *            --a-modifier every handle has always used) or "paint" (the app's
 *            selection/accent colour, --a-selection). An accent is how a handle
 *            says "I belong to a DIFFERENT subsystem than the shape you selected"
 *            — the exact question the user asked. Kept to two values: a third
 *            colour family would have to earn a token in every one of the app's
 *            themes, and the shape+mark axes already separate more roles than we
 *            have.
 *
 * `description` is documentation for the reader of this file — it is NOT the
 * tooltip. A row's `label` is the tooltip, because the SENTENCE depends on the
 * widget ("Gradient centre" vs "Bezier control"), while the glyph is the shared
 * look several widgets share.
 *
 * THE GRADIENT FAMILY IS "boxedO" ON THE USER'S OWN PICK (2026-08-02, verbatim:
 * "maybe it's a box with an O in it. Actually, that one would be kind of cool.
 * And the gradient handles would have a different look than the shape handles").
 * It happens to be a good pick independent of that: it keeps the square footprint
 * every handle has (so the grab target does not change size or shape and muscle
 * memory survives), and the ring reads at 8px where a stripe or a hatch does not.
 */
export const HANDLE_GLYPHS = {
  default: { shape: "square", mark: "none", accent: "default", description: "The plain PPT-yellow square. Every handle that declares nothing. A geometry handle belonging to the widget itself." },
  triangle: { shape: "triangle", mark: "none", accent: "default", description: "A bezier CONTROL point, as against the ANCHOR it swings around (paint_path). Predates the bank; kept as a glyph key so the legacy `shape: \"triangle\"` and a modern `glyph: \"triangle\"` draw one picture." },
  boxedO: { shape: "square", mark: "o", accent: "paint", description: "THE PAINT/GRADIENT family: a box with an O in it, in the accent colour. Same footprint as a shape handle, unmistakably not one." },
  boxedX: { shape: "square", mark: "x", accent: "paint", description: "The paint family's SECOND role, when a gradient exposes two beads that must not be confused with each other (unused today; reserved so the family can grow without minting a colour)." },
  circle: { shape: "circle", mark: "none", accent: "default", description: "A FREE handle — one with no constraint, draggable anywhere. The round footprint is the standard cue for that." },
  dottedCircle: { shape: "circle", mark: "dot", accent: "paint", description: "A paint-family CENTRE or origin: the dot marks the exact point, the ring is the grab target around it." },
  diamond: { shape: "diamond", mark: "none", accent: "default", description: "A handle that scrubs a SCALAR parameter rather than moving a point (a corner radius, an inner ratio) — it slides, it is not a position." },
};

/** The default look, spelled once so `handleGlyph` and its callers cannot disagree. */
const DEFAULT_GLYPH_KEY = "default";

/**
 * Pure function. The {shape, mark, accent} look for a glyph key. An ABSENT key
 * (the overwhelming majority of handles) and the key "default" both give the
 * plain square, so a widget that declares nothing renders exactly as it did
 * before the bank existed.
 *
 * AN UNKNOWN KEY THROWS rather than falling back to the square. A typo'd glyph
 * that silently drew the default would be invisible in review and in use — the
 * handle would simply keep looking like every other handle, which is the ONE
 * failure this whole feature exists to prevent. The bank is a closed vocabulary
 * (see the module docstring), so an unrecognized key is a bug in the declaring
 * plugin, not user input.
 *
 * Args:
 *   key (string|null|undefined): a key of HANDLE_GLYPHS, or absent for the default
 *
 * Returns:
 *   {shape: string, mark: string, accent: string} — the look, without `description`
 *
 * Examples:
 *   >>> handleGlyph()            // {shape: "square", mark: "none", accent: "default"}
 *   >>> handleGlyph("default")   // {shape: "square", mark: "none", accent: "default"}
 *   >>> handleGlyph("boxedO")    // {shape: "square", mark: "o", accent: "paint"}
 *   >>> handleGlyph("triangle")  // {shape: "triangle", mark: "none", accent: "default"}
 *   >>> handleGlyph("nope")      // throws Error("unknown handle glyph \"nope\" …")
 *
 * @param {string|null} [key]
 * @returns {{shape: string, mark: string, accent: string}}
 */
export function handleGlyph(key) {
  const entry = HANDLE_GLYPHS[key ?? DEFAULT_GLYPH_KEY];
  if (!entry) throw new Error(`unknown handle glyph ${JSON.stringify(key)} — the bank is ${Object.keys(HANDLE_GLYPHS).join(", ")} (core/handle_glyphs.js)`);
  return { shape: entry.shape, mark: entry.mark, accent: entry.accent };
}

/**
 * Pure function. Is `key` a glyph the bank knows? For a consumer that wants to
 * ASK rather than be thrown at — a test sweeping every plugin's declared glyphs,
 * or a tolerant renderer.
 *
 * Examples:
 *   >>> isHandleGlyph("boxedO")  // true
 *   >>> isHandleGlyph("nope")    // false
 *   >>> isHandleGlyph(undefined) // true (absent means the default)
 *
 * @param {string|null} [key]
 * @returns {boolean}
 */
export function isHandleGlyph(key) {
  return (key ?? DEFAULT_GLYPH_KEY) in HANDLE_GLYPHS;
}
