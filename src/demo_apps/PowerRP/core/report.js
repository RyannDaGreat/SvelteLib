/**
 * Loud error reporting — ONE home for the "report loudly, but never spam"
 * pattern (previously copied as private Sets in core/expressions.js and
 * plugins/fancy_arrow.js). DOM-free pure JS.
 *
 * TWO FUNCTIONS, AND CHOOSING BETWEEN THEM IS NOT A STYLE QUESTION — it decides
 * whether the SECOND occurrence is audible:
 *
 *   reportOnce   — for code the MACHINE runs repeatedly: emit(), the expression
 *                  pass, a paint path. Deduped forever, because at display rate
 *                  an undeduped report is a console flood.
 *   reportAction — for a refusal of ONE USER ACT: a click, a menu pick, a drag
 *                  release. NEVER deduped. The rate limit is the human hand, so
 *                  there is no flood to prevent — and deduping here produces the
 *                  exact silent failure this codebase forbids: the user clicks
 *                  Flip a second time, nothing happens, and nothing is said.
 *
 * THROTTLE SEMANTICS of reportOnce (deliberate — documenting the Opus1 review
 * finding #5 question): each unique key logs ONCE per process/page session, so a
 * RECURRING error stays silent after its first report until reload. The dedup set
 * grows only with DISTINCT message texts (bounded in practice by how many
 * different errors a session can produce); capping it would need a ratified
 * constant — flagged, not invented.
 */

const reported = new Set();

/**
 * Command (module-level dedup memory + console side effect). console.errors
 * `line` once per unique `key`; repeat keys are silent. `key` and `line` are
 * separate so callers can dedupe on the stable message but print a
 * call-site-prefixed line (the expressions.js idiom). Returns whether it
 * logged — callers can hang extra once-only work off the first report.
 *
 * @example // reportOnce("bad geometry (w 0)") → true, console.errors it
 * @example // reportOnce("bad geometry (w 0)") → false, silent (same key)
 * @example // reportOnce("cycle a→b→a", "PowerRP expression error at items.a.x: cycle a→b→a") — dedupe on the message, print the prefixed line
 */
export function reportOnce(key, line = key) {
  if (reported.has(key)) return false;
  reported.add(key);
  console.error(line);
  return true;
}

/**
 * Command (console side effect only — no dedup memory, by design). console.errors
 * `line` EVERY time. Use it for a refusal the USER just triggered, where each
 * invocation is a distinct act and therefore deserves its own answer; use
 * reportOnce for anything a frame loop or an evaluation pass can call.
 *
 * Takes no `key`: there is nothing to dedupe on, and accepting one would invite
 * exactly the mistake this function exists to prevent.
 *
 * @param {string} line - the message to print
 * @returns {void}
 *
 * @example // reportAction("PowerRP: Flip Horizontal refused — 1 item stores an equation on x. Nothing was changed.")
 * @example // calling it twice with the same text prints TWICE (a second click is a second refusal)
 */
export function reportAction(line) {
  console.error(line);
}
