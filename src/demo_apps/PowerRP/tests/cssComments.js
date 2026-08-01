/**
 * cssComments.js — THE ONE CSS COMMENT STRIPPER the grep gates share.
 *
 * WHY THIS FILE EXISTS. `stripComments` had reached SIX independent copies in
 * `tests/`, written by six authors who each needed the same thing and had no way
 * to find the previous one. That is convention-ledger C-10 exactly: the copies
 * regenerate because the need is real and the shared home is not discoverable
 * from where the author is standing.
 *
 * WHY THE OTHER COPIES ARE NOT ALL GONE. They had DIVERGED, and not cosmetically:
 *   · `equation_lock_test.js` strips JS `//` line comments and does NOT preserve
 *     line count.
 *   · `one_ranking_ban_test.js` and `popover_reinvention_ban_test.js` strip block
 *     + HTML + JS line comments, line-preserving, and both `export` theirs.
 *   · `native_tooltip_ban_test.js` strips HTML comments only.
 * Pretending one shape fits all is how the seventh copy gets written. This module
 * owns the CSS case and says so in its name; the JS/HTML variants are a separate
 * question, deliberately left open rather than smuggled in under a name that
 * would not describe them.
 *
 * NO IMPORT-SCOPE ASSERTIONS LIVE HERE, and that is load-bearing rather than
 * tidy. Two of the copies above are exported from files that run their whole
 * gate at import scope, so importing one of those would fire an unrelated gate
 * as a side effect — which is why they could not simply be reused, and is the
 * same sequencing hazard ledger C-19 records. A shared helper must be safe to
 * import from anywhere; this one does nothing but define a function.
 *
 * WHY LINE COUNT IS PRESERVED. A gate that reports `file:line` must report the
 * REAL line. An `^\s*` stripper eats the blank lines above a comment and every
 * subsequent number drifts — measured, a sweep reported `:1605` for a literal on
 * `:1628` (ledger C-14). Blanking each comment character in place, newlines
 * excepted, keeps every offset and every line number exact.
 */

/**
 * Pure function. Blanks the BODY of every CSS block comment, leaving a run of
 * spaces of the same length and every newline intact, so offsets and line
 * numbers into the result are identical to the input's.
 *
 * COMMENTS ARE NOT CODE, and a comment-blind grep over this codebase fails in
 * BOTH directions — it has done so twice in one hour (ledger C-14). `app.css`
 * explains itself heavily in prose, which is a virtue everywhere except inside a
 * grep: an orphan-class gate counted class names appearing only in comments as
 * DEFINED (616 -> 568 once stripped, i.e. 48 names existed in prose alone), and
 * a duplicate-sentence sweep counted commented mentions as copies (19 hits
 * unstripped, 1 real).
 *
 * @param {string} css - stylesheet text (or the body of one `<style>` block)
 * @returns {string} the same text, comment bodies blanked, LENGTH and LINE COUNT
 *   both preserved
 *
 * @example stripCssComments(".a { color: red; }")
 * // ".a { color: red; }"  — nothing to strip, returned unchanged
 * @example stripCssComments(".a {}\n/* --radius is the src/lib cap *\/\n.b {}").includes("--radius")
 * // false — prose naming a token no longer reads as a use of it
 * @example stripCssComments("a\n/* two\n   lines *\/\nb").split("\n").length
 * // 4 — the comment's own newlines survive, so line numbers do not drift
 * @example stripCssComments("x /* y *\/ z").length
 * // 11 — same length as the input, so character offsets stay valid
 */
export function stripCssComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
}
