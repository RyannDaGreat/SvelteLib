/**
 * FONTS — DeckIR font family names -> PowerRP committed font ids
 * (render_gpu/fonts.js FONTS), per the mapping spec's priority-5 gap ("Futura
 * Medium"/"FUTURA MEDIUM" case normalization) and the dump manifest's user
 * law: never silently substitute — every substitution is collected into the
 * translate report, `{wanted, used}`.
 *
 * MATCHING IS CASE-FOLDED EXACT-TITLE, nothing fuzzier: render_gpu/fonts.js
 * has no built-in closest-match helper, and a fuzzy match risks landing on a
 * visually wrong family with no report to catch it — the mapping spec's
 * "unmatched -> record substitution, use system" is the honest default.
 */

/**
 * Pure function. Case-folded map from a committed font's TITLE (its display
 * name, e.g. "Futura") to its registry id (e.g. "futura") — built once from
 * the `FONTS` table passed in, so this module never imports render_gpu/fonts
 * directly (keeping core/pptx_translate decoupled from render_gpu, per this
 * app's layering: core/ imports render_gpu in a few places but a translator
 * that only needs font ID STRINGS should not need the whole render module
 * graph — callers pass the table).
 *
 * @param {Record<string, {title: string}>} fontsTable - render_gpu/fonts.js FONTS
 * @returns {Map<string, string>} lowercased title -> font id
 *
 * @example [...fontTitleIndex({futura: {title: "Futura"}})] // [["futura", "futura"]]
 */
export function fontTitleIndex(fontsTable) {
  const out = new Map();
  for (const [id, d] of Object.entries(fontsTable)) out.set(d.title.toLowerCase(), id);
  return out;
}

/**
 * Pure function. Resolve one DeckIR font family name to a PowerRP font id —
 * case-folded exact match against the committed registry's titles, else
 * `"system"` (render_gpu/fonts.js DEFAULT_FONT) with a substitution record.
 *
 * @param {string} wanted - the DeckIR-resolved font family (e.g. "Futura Medium")
 * @param {Map<string, string>} titleIndex - fontTitleIndex() output
 * @returns {{used: string, substitution: {wanted: string, used: string}|null}}
 *
 * @example resolveFontId("Georgia", fontTitleIndex({})) // {used: "system", substitution: {wanted: "Georgia", used: "system"}}
 * @example resolveFontId("Futura", fontTitleIndex({futura: {title: "Futura"}})) // {used: "futura", substitution: null}
 * @example resolveFontId("FUTURA MEDIUM", fontTitleIndex({futura: {title: "Futura"}})).used // "system" (case-normalized lookup still finds no "Futura Medium" title — a real substitution, not a bug)
 */
export function resolveFontId(wanted, titleIndex) {
  const hit = titleIndex.get(wanted.toLowerCase());
  if (hit) return { used: hit, substitution: null };
  return { used: "system", substitution: { wanted, used: "system" } };
}
