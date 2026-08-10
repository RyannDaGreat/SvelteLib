/**
 * MORPH SHAPE IDENTITY — the "!!" forced-match convention (.frenzy/
 * research_09_export_pptx.md section 3, converging multiple independent
 * sources: SlideModel, Office Watch, The PowerPoint Blog, Microsoft Support).
 *
 * PowerPoint's Morph transition normally matches shapes ACROSS two slides by a
 * visual-similarity heuristic (name/position/size/type). Prefixing BOTH
 * shapes' `<p:cNvPr name="…">` with the same `!!`-prefixed string FORCES the
 * match, overriding the heuristic entirely.
 *
 * PowerRP already has EXACT ground truth for "is this the same object across
 * slides" — an item's UUID persists across every slide it appears on (this
 * app's CLAUDE.md: "An item appearing across slides IS the 'symlink'"), which
 * is precisely the concept morph's matching needs. So every exported shape's
 * name is `!!<itemId>` — zero heuristics, zero fuzzy matching, mechanically
 * exact per research_09's own conclusion ("near-zero-cost, mechanically exact
 * encoding of morph's matching requirement").
 */

/** The forced-match prefix PowerPoint's morph engine recognizes. */
export const MORPH_FORCE_PREFIX = "!!";

/**
 * Pure function. The `<p:cNvPr name>` for one exported shape: the forced-morph
 * prefix plus the item's own UUID. Used on EVERY exported shape, unconditionally
 * — a shape that never appears on an adjacent slide simply never gets matched
 * against anything, so there is no cost to always stamping it (deck-wide
 * uniqueness comes for free: PowerRP item ids are already unique per document).
 *
 * @param {string} itemId
 * @returns {string}
 *
 * @example morphShapeName("ab12cd34") // "!!ab12cd34"
 */
export function morphShapeName(itemId) {
  return `${MORPH_FORCE_PREFIX}${itemId}`;
}
