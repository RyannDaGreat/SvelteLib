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
const warned = new Set();

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
 * Command (module-level dedup memory + console side effect). The WARN-level twin of
 * reportOnce: console.warns `line` once per unique `key`, repeats silent, returns
 * whether it logged. Its dedup set is SEPARATE, so a warning and an error sharing a
 * key do not silence each other.
 *
 * ── WHEN TO USE THIS RATHER THAN reportOnce ──────────────────────────────────
 * The choice is about whether the picture is still CORRECT. reportOnce says
 * something is wrong. warnOnce says the app did the right thing by a worse route and
 * the author should know: a gradient stroke degraded to its first stop because PDF
 * has no shading for one, a material too big for the raster cache re-running its
 * shader every frame, a software surface standing in for a GPU one. The output is
 * what the author asked for; the cost or the fidelity is not.
 *
 * ── WHY IT EXISTS ────────────────────────────────────────────────────────────
 * This module shipped with error-level members only, so every caller that needed the
 * warn level wrote its own Set — and one of them, render_gpu/skia/paint_skia.js, named
 * its private copy `reportOnce`, which COLLIDED with this module's export and forced
 * that file to import the real one under an alias, with a five-line comment
 * explaining which `reportOnce` a reader is looking at. A missing member of a shared
 * module does not stop the pattern being copied; it just stops the copies being
 * recognisable.
 *
 * @param {string} key - dedup key; distinct keys warn independently
 * @param {string} [line] - the message to print; defaults to `key`
 * @returns {boolean} whether this call actually logged
 *
 * @example // warnOnce("pdf-gradient-stroke", "…degrading to the first stop") → true, console.warns it
 * @example // the same key again → false, silent
 * @example // warnOnce("a") then reportOnce("a") → both log; the two sets are separate
 */
export function warnOnce(key, line = key) {
  if (warned.has(key)) return false;
  warned.add(key);
  console.warn(line);
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

/**
 * The longest source string echoed VERBATIM in a report line, and how much of a
 * longer one survives the elision. A `data:` URI is routinely megabytes, so a
 * report that quotes one whole is not a report — it is a console flood with the
 * message buried in it, which is the same failure reportOnce exists to prevent.
 * 48/24 are the values the oldest copy shipped with (render_gpu/gpu/image_registry.js,
 * ccb79cf 2026-07-14) and the only site that ever NAMED them used these names
 * (web/videoV8Registry.js:59-60), so both the numbers and the spelling are inherited
 * rather than chosen.
 */
const SRC_LOG_MAX = 48;
const SRC_LOG_HEAD = 24;

/**
 * Pure function. Shortens a long source string for a report line: the first
 * SRC_LOG_HEAD characters plus the FULL LENGTH in parentheses, so the reader can
 * still tell a 200-char URI from a 2-million-char one. A short string passes
 * through byte-for-byte.
 *
 * THE NINTH COPY IS WHY THIS IS HERE. The same elision was written out nine times
 * — `truncate` in image_registry / video_registry / pdf_page_raster /
 * pdf_page_vector / latex_raster / mermaid_raster, `truncateSrc` in
 * web/videoV8Registry.js, `truncateRef` in render_gpu/svg_backend.js, and a
 * `truncate` in render_gpu/skia/video_v5.js — and by the ninth it had drifted into
 * three different behaviours. That is the exact history in this module's own header
 * (a private copy per file, until one home ended it), so it lands in the same place
 * for the same reason.
 *
 * @param {string} src - the source string to elide
 * @returns {string}
 *
 * @example truncate("clip.mp4") // "clip.mp4"
 * @example truncate("data:image/png;base64," + "A".repeat(200)) // "data:image/png;base64,AA…(222 chars)"
 * @example truncate("x".repeat(48)) // "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" (48 is not yet too long)
 */
export function truncate(src) {
  return src.length > SRC_LOG_MAX ? `${src.slice(0, SRC_LOG_HEAD)}…(${src.length} chars)` : src;
}
