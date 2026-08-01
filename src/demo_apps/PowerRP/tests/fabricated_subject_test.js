/**
 * A SUITE THAT FABRICATES ITS SUBJECT MUST HARD-EXIT WHEN THE SUBJECT IS MISSING.
 *
 * Some probes are shaped "measure the real thing if it is there, else stand one
 * in" — a widget declaration that has not landed yet, a fixture another agent
 * owns. That shape is legitimate and this gate does not forbid it: it is what
 * lets a renderer's gate be written before the declaration that exercises it.
 *
 * WHAT IT FORBIDS is the shape WITHOUT a hard stop on absence. Such a file has
 * TWO states and in practice only ever runs one — whichever the tree happens to
 * be in. The unexercised one runs when the subject is ABSENT, and its failure
 * mode is not a check failing but a check PASSING over `undefined`:
 * `undefined !== "[object Object]"` is true, and an element that is not in the
 * DOM has none of the children you were about to assert are absent.
 *
 * **A gate that goes green when its subject is missing is worse than no gate,
 * because it is cited as evidence.**
 *
 * This is ledger C-13's counter-intuitive corollary — *a GREEN can be the
 * outlier* — reaching the same place from a different direction. There the cause
 * was probe flakiness and the spurious result was a pass; here the cause is a
 * branch nobody has run, and the branch nobody has run is precisely the one that
 * ships green. Both defeat the instinct to re-run reds and trust greens.
 *
 * ── PROVENANCE ──────────────────────────────────────────────────────────────
 * `tests/richtext_row_probe.js` at 831b34d^. It injected a `richtext` inspector
 * row when plugins/text.js had none, so it could gate the Inspector's dispatcher
 * before the declaration landed — correct, and the guard was right. But the
 * LOOKUP LABEL was hardcoded on the other side, so the moment the real row
 * shipped (0aaf38a) the injection was correctly SKIPPED, nothing carried the
 * label, and the row was not found. Three checks false-red and TWO PASSED
 * VACUOUSLY, including the central one — the assertion that the row does not
 * render "[object Object]" was unfalsifiable in exactly the state it exists to
 * catch. Found by a second agent running the file, not by its author.
 *
 * ── WHY A GATE AND NOT A LEDGER ENTRY (lead ruling) ─────────────────────────
 * Doctrine gets written after a rule is violated TWICE; one violation is an
 * incident. This has exactly one instance and it is self-inflicted, so prose
 * would be an artifact that reads as thorough, costs maintenance and goes stale.
 * But the failure mode is severe and ledger C-7 is unambiguous — defer the fix if
 * you must, never the gate. So the reasoning lives HERE, next to the check that
 * enforces it, and it catches instance two without anyone remembering a rule.
 *
 * ── THE ABSENCE, MEASURED FROM BOTH SIDES, SO NOBODY RE-RUNS IT (ledger C-18)
 * The pattern was first pitched as "a greppable class worth sweeping". It was
 * agreed to, then measured, and the measurement cut it down. Both agents then
 * searched — the second deliberately auditing the first's negative result,
 * because "I could not find more" is exactly the claim C-18 says must carry its
 * search. ~420 suites in tests/ and render_gpu/tests/, comments stripped per C-14:
 *   - SHAPE scan (a conditional whose body assigns to the subject when a check
 *     fails): 18 candidates, every one a running-minimum accumulator
 *     (`if (!best || d < best.d) best = …`) or a failure flag
 *     (`if (!ok) failed = true`). ZERO fabricators.
 *   - MECHANISM scan (a suite mutating a plugin's declared shape): ONE hit.
 *   - TERNARY fallbacks (gap in the first search): 0 hits.
 *   - Fabrication via a HELPER (gap in the first search): 20 candidates, 0 real.
 *   - Conditional fabrication of DOCUMENT state rather than plugin shape (a gap
 *     neither search was keyed for): 9 candidates, 0 real.
 *
 * AND THE NEGATIVE RESULT IS STRONGER THAN "ONE INSTANCE". All 29 candidates in
 * the last two rows turn out to be the CORRECT idiom already — `throw`,
 * `return null` or `continue` on a missing subject; two of them
 * (`render_gpu/tests/brightness_contrast_browser_probe.js`, `tests/god_rays_probe.js`)
 * even carry the same explanatory sentence. So the codebase has a near-universal
 * convention for a missing subject in a suite, and it is precisely the one the
 * fix above adopted. `richtext_row_probe` was not following a bad pattern; it was
 * the sole deviation from a good one that ~29 other places already observe. That
 * is the real reason not to commission a sweep: not that the class is small, but
 * that the convention exists and a sweep would spend a slot confirming compliance.
 *
 * THE DEFINING PROPERTY IS CONDITIONALITY, NOT FABRICATION — the single most
 * useful thing learned while measuring this, and it is a searching lesson rather
 * than a result. A first pass grepping for fabrication alone returned 59 hits,
 * all noise: unconditional `fakeApp()` fixtures. A fixture with ONE state cannot
 * have an unexercised branch. Requiring an absence check took one gap 20 → 0 and
 * another 59 → 0. Grepping the payload measures how many suites build fixtures,
 * which is not the question. Same family as C-14 (a grep gate failing in both
 * directions) one level up: there the fix is strip comments, here it is scan for
 * the conditional, not the payload.
 *
 * ── WHAT THIS GATE CAN AND CANNOT SEE ───────────────────────────────────────
 * It checks that a fabricating suite CONTAINS a hard stop on a negated
 * condition. It cannot check that the stop guards the RIGHT subject — that is
 * not decidable from source text — so this is a FLOOR, not a proof. It is still
 * worth having: the defect it models was the total absence of such a stop, and
 * an author who adds one has been made to think about the absent case, which is
 * the whole ask.
 *
 * Note it deliberately keys on the MECHANISM (mutating a declared shape) rather
 * than on the conditional, even though conditionality is what defines the defect.
 * A grep for the conditional cannot be written tightly enough to avoid the 18
 * accumulators above; the mechanism is narrow, and every suite that trips it
 * should hard-stop on absence whether its fabrication is conditional or not. The
 * cost of that choice is the blind spot the self-check at the bottom exists for.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SUITE_DIRS = [resolve(HERE, "."), resolve(HERE, "../render_gpu/tests")];
const SUITE_RE = /_(test|probe)\.(js|mjs)$/;

/**
 * Pure function. Source with `//` line comments and block comments blanked,
 * LINE COUNT AND LINE NUMBERS PRESERVED.
 *
 * Ledger C-14: a comment-blind grep over this codebase fails in both directions,
 * because the codebase explains itself heavily in prose — this very file
 * describes the forbidden shape in its header, and would otherwise flag itself.
 * The line-comment rule matches horizontal whitespace only: `\s` matches `\n`, so
 * an `^\s*` stripper eats the blank lines above a comment and every subsequent
 * line number drifts.
 *
 * @param {string} src Source text.
 * @returns {string} The same text with comment bodies blanked.
 *
 * @example stripComments('a\n  // b\nc')
 * 'a\n\nc'
 * @example // prose describing a mutation is not a mutation
 * stripComments('  // plugin.inspector = [...]').trim()
 * ''
 * @example // and the code around it keeps its line numbers
 * stripComments('keep\n// gone\nreal').split('\n').length
 * 3
 */
export function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

/**
 * Pure function. The source text of the `{...}` block or single statement that
 * follows position `i`, so a guard's body can be examined without matching
 * whatever happens to sit a few lines below it.
 *
 * @param {string} src Source text.
 * @param {number} i Index just past the guard's closing `)`.
 * @returns {string} The block body (braced) or the remainder of the statement.
 *
 * @example guardBody('if (!x) { a(); b(); } c();', 7)
 * ' { a(); b(); }'
 * @example // a braceless guard is its one statement, not the line after it
 * guardBody('if (!x) throw new Error("no"); next();', 7)
 * ' throw new Error("no");'
 */
export function guardBody(src, i) {
  const open = src.indexOf("{", i);
  const semi = src.indexOf(";", i);
  if (open === -1 || (semi !== -1 && semi < open)) return src.slice(i, semi === -1 ? src.length : semi + 1);
  let depth = 0;
  for (let j = open; j < src.length; j += 1) {
    if (src[j] === "{") depth += 1;
    else if (src[j] === "}") {
      depth -= 1;
      if (depth === 0) return src.slice(i, j + 1);
    }
  }
  return src.slice(i);
}

/** A suite MUTATING a plugin's declared shape — the fabrication mechanism. */
const FABRICATES = /(?:registry\.get\([^)]*\)\s*\.\w+\s*=[^=]|\.inspector\s*=[^=]|\bplugin\.\w+\s*=\s*\[)/;
/** A guard on a NEGATED condition, whose body is checked for a hard stop. */
const NEGATED_GUARD = /\bif\s*\(\s*!\s*[\w.$[\]]+[^)\n]*\)/g;
/** A hard stop: leave the process, or throw. Never a soft assertion. */
const HARD_STOP = /(?:process\.exit\s*\(|\bthrow\b)/;

/** Query. Every suite file across both test directories, as {path, src}. */
function suites() {
  const out = [];
  for (const dir of SUITE_DIRS)
    for (const f of readdirSync(dir).filter((n) => SUITE_RE.test(n)))
      out.push({ path: `${dir.endsWith("render_gpu/tests") ? "render_gpu/tests" : "tests"}/${f}`, src: stripComments(readFileSync(resolve(dir, f), "utf8")) });
  return out;
}

/**
 * Pure function. Does this (comment-stripped) source hard-exit on some negated
 * condition? The stop must be INSIDE the guard's own body — a `process.exit`
 * further down the file belongs to a different question.
 *
 * @param {string} src Comment-stripped source text.
 * @returns {boolean}
 *
 * @example hasAbsenceStop('if (!row) { console.error("gone"); process.exit(1); }')
 * true
 * @example // a SOFT assertion is exactly the defect, not the remedy
 * hasAbsenceStop('assert(before.found, "the row renders");')
 * false
 * @example // ...and neither is a guard that merely records and continues
 * hasAbsenceStop('if (!ok) { failed = true; }')
 * false
 */
export function hasAbsenceStop(src) {
  for (const m of src.matchAll(NEGATED_GUARD))
    if (HARD_STOP.test(guardBody(src, m.index + m[0].length))) return true;
  return false;
}

let checks = 0;
const ok = (msg) => { checks += 1; console.log(`  ok   ${msg}`); };

const all = suites();
const fabricators = all.filter((s) => FABRICATES.test(s.src));

// THE CHECK.
const offenders = fabricators.filter((s) => !hasAbsenceStop(s.src));
assert.deepEqual(offenders.map((s) => s.path), [],
  `these suites FABRICATE their subject but never hard-exit when it is missing, so every check below the lookup passes over undefined:\n` +
  offenders.map((s) => `  ${s.path}`).join("\n") +
  `\nAdd a guard that EXITS (not an assert) when the subject is not found. See this file's header.`);
ok(`${fabricators.length} fabricating suite(s), each hard-exiting on a missing subject: ${fabricators.map((s) => s.path).join(", ") || "(none)"}`);

// SELF-CHECK AGAINST BLINDNESS — this gate applying its own rule to itself.
// If the mechanism scan matches nothing, this file passes while asserting
// nothing, which is the exact failure it exists to prevent. Zero fabricators is
// far more likely to mean the DETECTOR has gone blind (a fabrication moved into
// a helper, or into a form the regex does not model) than that the pattern has
// genuinely disappeared. If the last fabricator is ever legitimately removed,
// this is the line to update, deliberately, with that fact recorded.
assert.ok(fabricators.length >= 1,
  "the fabrication scan matched NOTHING across " + all.length + " suites. Either the last fabricating suite was removed — in which case update this assertion and say so — or the detector has gone blind and this gate is now passing vacuously, which is the very defect it was written for.");
ok(`the detector still sees its subject (${all.length} suites scanned)`);

console.log(`fabricated subject: ${checks} checks passed`);
