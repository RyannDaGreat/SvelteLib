/**
 * THE PHONE-BREAKPOINT MIRROR GATE — plain node, no framework.
 * Run: node src/demo_apps/PowerRP/tests/phone_breakpoint_test.js
 *
 * WHY THIS EXISTS. `--a-phone-max: 640px` is the one place the phone breakpoint
 * is DECIDED, but it cannot be the one place it is WRITTEN: a custom property is
 * illegal inside a media query — `@media (max-width: var(--a-phone-max))` does
 * not merely fail, it silently never matches — so the literal has to be repeated
 * in every phone `@media` block in web/app.css.
 *
 * That is a hand-maintained mirror, which is this codebase's worst recurring
 * defect class, and the standing rule for one is: if you cannot derive it, gate
 * it, and the gate must DERIVE the expectation from the other side's source text
 * rather than restate the rule in its own words (ledger C-1's corollary). So
 * this test hardcodes NO breakpoint value. It reads the token out of app.css and
 * checks every phone media query against whatever it finds. Change the token to
 * 700px and the gate demands the queries follow; change one query and the gate
 * names the line.
 *
 * WHY IT ALSO CHECKS FOR *UNANNOTATED* max-width QUERIES. A gate that only
 * validates the blocks it can recognize is satisfied by someone adding an
 * unrecognizable one. Every `max-width` query must therefore carry the
 * `--a-phone-max` annotation, OR be a deliberate second breakpoint — and the
 * failure message says so, rather than pretending a tablet breakpoint would be
 * illegal. What is forbidden is an UNEXPLAINED one, because that is
 * indistinguishable from a drifted copy.
 *
 * COMMENTS ARE STRIPPED FIRST, and that is load-bearing here rather than
 * hygiene: app.css's own token docblock CONTAINS the literal text
 * "@media (max-width: var(--a-phone-max))" as the example of what does not work.
 * A comment-blind parser reads that as a real query with no numeric value and
 * fails on prose (ledger C-14, which was earned twice in one hour by gates that
 * counted comments in BOTH directions). The stripper preserves line count so
 * every citation below points at the real line.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// Paths resolve from THIS FILE, never process.cwd().
const powerRP = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CSS_PATH = "web/app.css";
const cssRaw = readFileSync(resolve(powerRP, CSS_PATH), "utf8");

/**
 * Pure function. CSS with every block comment blanked out, LINE COUNT AND LINE
 * NUMBERS PRESERVED — newlines inside a comment survive, everything else in it
 * becomes a space.
 *
 * Preserving the newlines is the whole point: a stripper that deletes comments
 * outright shifts every subsequent line number, and a sweep that cites wrong
 * lines costs the reader more than the finding saves.
 *
 * @param {string} css - stylesheet source
 * @returns {string} same length in lines, comment bodies blanked
 *
 * The examples below write a comment terminator as `*!/` because a literal one
 * would close THIS docblock — the usual hazard of documenting a comment parser.
 * Read `*!/` as `*` followed by `/`.
 *
 * Examples:
 *   >>> stripCssComments("a{}/* x *!/b{}")   // the 7-char comment becomes 7 spaces
 *   'a{}       b{}'
 *   >>> // newlines survive, so line numbers downstream stay true:
 *   >>> stripCssComments("a{}\n/* x\ny *!/\nb{}").split("\n").length
 *   4
 *   >>> // the case this gate actually needs: prose quoting a media query is
 *   >>> // blanked, so it cannot be mistaken for a real one
 *   >>> stripCssComments("@media (max-width: 640px){} /* @media (max-width: 1px) *!/").includes("1px")
 *   false
 */
export function stripCssComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
}

const css = stripCssComments(cssRaw);

/** Pure function. 1-based line number of `index` within `text`. */
function lineOf(text, index) {
  return text.slice(0, index).split("\n").length;
}

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

// ── (1) The token exists and is the one place the number is decided ─────────
const tokenMatch = /--a-phone-max:\s*(\d+)px/.exec(css);
test("web/app.css declares --a-phone-max", () => {
  assert.ok(
    tokenMatch,
    `--a-phone-max is not declared in ${CSS_PATH}. It is the phone breakpoint every ` +
      `phone @media block mirrors; without it there is nothing for them to agree with.`
  );
});
const breakpoint = Number(tokenMatch[1]);

// ── (2) Every ANNOTATED phone query matches the token ───────────────────────
// The annotation is the comment naming the token, so it is read from the RAW
// text; the query itself is read from the STRIPPED text so prose cannot forge
// one. Both are needed, which is why this does not simply pick one.
const mediaRe = /@media[^{]*?\(\s*max-width:\s*(\d+)px\s*\)/g;
const queries = [];
for (let m; (m = mediaRe.exec(css)) !== null; ) {
  const line = lineOf(css, m.index);
  const rawLine = cssRaw.split("\n")[line - 1];
  queries.push({ value: Number(m[1]), line, annotated: rawLine.includes("--a-phone-max") });
}

test("at least one phone @media block exists (the gate cannot pass vacuously)", () => {
  assert.ok(
    queries.length > 0,
    `${CSS_PATH} declares --a-phone-max: ${breakpoint}px but contains no (max-width: …) query at all. ` +
      `Either the phone layout was removed and the token is dead, or the queries were written in a form ` +
      `this gate cannot see — both are worth a human look.`
  );
});

test(`every annotated phone @media matches --a-phone-max (${breakpoint}px)`, () => {
  const drifted = queries.filter((q) => q.annotated && q.value !== breakpoint);
  assert.equal(
    drifted.length,
    0,
    `these phone media queries disagree with --a-phone-max: ${breakpoint}px — ` +
      drifted.map((q) => `${CSS_PATH}:${q.line} says ${q.value}px`).join("; ") +
      `. The token is where the breakpoint is DECIDED; update the queries to follow it, ` +
      `or change the token if the decision itself changed.`
  );
});

test("no unexplained max-width query (an unannotated one is indistinguishable from a drifted copy)", () => {
  const bare = queries.filter((q) => !q.annotated);
  assert.equal(
    bare.length,
    0,
    `these (max-width: …) queries carry no --a-phone-max annotation — ` +
      bare.map((q) => `${CSS_PATH}:${q.line} (${q.value}px)`).join("; ") +
      `. A SECOND, DELIBERATE breakpoint is allowed — a tablet block is a legitimate thing to want. ` +
      `What is not allowed is an unexplained one, because nothing then distinguishes it from a phone ` +
      `query whose literal drifted. Annotate it with the token it mirrors, or with a comment naming ` +
      `the new breakpoint and why it is not --a-phone-max.`
  );
});

// ── (3) The tap floor is a named token, not a literal in the dock's rules ────
test("--a-tap-min is declared and the dock sizes itself from it", () => {
  const tap = /--a-tap-min:\s*(\d+)px/.exec(css);
  assert.ok(tap, `--a-tap-min is not declared in ${CSS_PATH} — the iOS tap floor must be named, not inlined`);
  assert.equal(
    Number(tap[1]),
    44,
    `--a-tap-min is ${tap[1]}px; the iOS Human Interface Guidelines floor is 44pt. ` +
      `If this is deliberate, the token's comment must say why the platform floor is being overridden.`
  );
  assert.match(
    css,
    /\.present-dock-btn\s*\{[^}]*width:\s*var\(--a-tap-min\)/,
    `.present-dock-btn does not take its width from var(--a-tap-min). The dock exists because the app-wide ` +
      `--a-control-h (26px) is 59% of the iOS tap floor, so sizing it from anything else defeats its purpose.`
  );
});

console.log(`\n${passed} passed`);
