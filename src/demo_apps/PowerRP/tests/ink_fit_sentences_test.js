/**
 * INK-FIT SENTENCE guard — plain node, no framework.
 * Run: node src/demo_apps/PowerRP/tests/ink_fit_sentences_test.js
 *
 * WHY THIS EXISTS. The user tried "Set Size to Ink Bounds" on a widget whose ink
 * was SMALLER than its box and the app told them the contents had to leave it
 * (2026-08-02, verbatim): "no, it just has to be different from the box in order
 * to use the tool. Getting smaller is a legitimate use case too".
 *
 * The GATE was never the bug — #inkFitTargets has always compared all four edges
 * and fired on any disagreement. The bug was entirely in the WORDS, which is the
 * expensive place for it: the tool declined for one reason and explained itself
 * with another, so the user was sent to fix a condition that was not being
 * tested. A wrong reason costs more than no reason.
 *
 * WHAT IT PROVES, on the SOURCE (the behaviour is tests/reparametrize_law_test.mjs):
 *   (1) NO SURFACING OF THIS COMMAND DESCRIBES THE GATE AS OVERFLOW. The old
 *       sentences are asserted ABSENT, not merely replaced — a fix that leaves
 *       the lie expressible invites its return.
 *   (2) THE GATE HAS THREE DISTINCT CLAUSES, one per disqualifying condition,
 *       because a single string would be a confident wrong answer for two of
 *       them. This is the `save-project` precedent (CLAUDE.md).
 *   (3) The command reads its clause through the app query that OWNS the
 *       worklist, so the sentence and the behaviour cannot drift apart.
 *
 * Source-level because App.svelte and app.svelte.js are Svelte modules that do
 * not import into bare node; this is the technique tests/toolbar_surfacing_test.js
 * already uses for the same reason.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// Paths resolve from THIS FILE, never process.cwd().
const powerRP = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const appSvelte = readFileSync(resolve(powerRP, "web/App.svelte"), "utf8");
const appJs = readFileSync(resolve(powerRP, "web/app.svelte.js"), "utf8");

let failures = 0;
const check = (ok, msg) => { if (!ok) { failures++; console.error(`FAIL ${msg}`); } };

// ── (1) THE OVERFLOW LANGUAGE IS GONE, AND STAYS GONE ────────────────────────
// Each phrase below described the gate as "the ink must be OUTSIDE the box".
// The real gate is DIFFERENCE. These are pinned absent so the lie cannot come
// back by a well-meaning re-word.
const FORBIDDEN = [
  "contents leave its box",
  "contents that leave its box",
  "whose contents leave",
  "already fits what it holds",
  "has overflowed its box",
];
for (const phrase of FORBIDDEN) {
  for (const [name, src] of [["web/App.svelte", appSvelte], ["web/app.svelte.js", appJs]]) {
    check(!src.includes(phrase),
      `${name} still contains "${phrase}" — the ink-bounds gate is DIFFERENCE, not overflow (user, 2026-08-02: "it just has to be different from the box … Getting smaller is a legitimate use case too"). A widget whose ink is SMALLER than its box is a legitimate target, so a sentence demanding the contents leave the box is a confident wrong answer.`);
  }
}

// ── (2) THREE CONDITIONS, THREE CLAUSES ──────────────────────────────────────
// The gate disqualifies for three genuinely different reasons and each must have
// its own true sentence: nothing with a box is selected / everything already
// matches / something differs but every differing widget REFUSED.
const requiresFn = appJs.match(/fitToInkBoundsRequires\(\)\s*\{[\s\S]*?\n {2}\}/);
check(requiresFn !== null,
  "web/app.svelte.js no longer defines fitToInkBoundsRequires() — the command's three-way gate clause lives there, beside the worklist that decides it.");

if (requiresFn) {
  const body = requiresFn[0];
  // (a) no subject at all.
  check(/capabilities\.bbox/.test(body) && /a selected widget with a box/.test(body),
    "fitToInkBoundsRequires: the NO-SUBJECT case (nothing with a box selected) must be distinguished and say so — this is the one condition the old two-way gate got right.");
  // (b) everything already matches — must be stated as EQUALITY, never overflow.
  check(/already matches/.test(body) && /differs from its box/.test(body),
    "fitToInkBoundsRequires: the ALREADY-MATCHES case must describe the gate as a DIFFERENCE ('ink differs from its box'), not as overflow. This is the sentence the user was shown while shrinking.");
  // (c) the refusal case — the one the old gate could not express at all, and
  //     the reason a differing-but-refusing selection used to show (b)'s lie.
  check(/refused/.test(body) && /inkFitRefusalClause/.test(body),
    "fitToInkBoundsRequires: a selection that DIFFERS but whose every differing widget REFUSED must report the REFUSAL's own reason. Falling through to 'already matches' here is the confident wrong answer this workstream exists to delete — the user can see on screen that it does not already match.");
  // The three must be genuinely distinct branches, not one string with commas.
  check((body.match(/return /g) ?? []).length === 3,
    "fitToInkBoundsRequires: expected exactly three return paths, one per disqualifying condition (the save-project precedent: several true sentences, so a fixed string would be wrong for all but one).");
}

// ── (3) THE COMMAND READS THE APP'S CLAUSE, NOT ITS OWN COPY ─────────────────
// A transcribed sentence in App.svelte is a second source of truth, and the
// toolbar's own history (tests/toolbar_surfacing_test.js) is three drifts long.
const entry = appSvelte.match(/id: "fit-to-ink-bounds"[\s\S]*?\n {4}\}/);
check(entry !== null, "web/App.svelte no longer declares the fit-to-ink-bounds command entry.");
if (entry) {
  check(/requires: \(a\) => a\.fitToInkBoundsRequires\(\)/.test(entry[0]),
    "fit-to-ink-bounds must take its `requires` from a.fitToInkBoundsRequires() — the gate's reasons are computed from the same worklist the run uses, so the two cannot disagree.");
  // The help text must state the tool is bidirectional; that is the user's ruling.
  check(/shrink|smaller|EITHER direction/i.test(entry[0]),
    "fit-to-ink-bounds help must say the tool works in BOTH directions — a box larger than its ink shrinks to it (user, 2026-08-02: \"Getting smaller is a legitimate use case too\"). Help that only describes growth is why the user believed shrinking was unsupported.");
}

// ── THE NO-OP REPORTS ────────────────────────────────────────────────────────
// The run's two no-op reports are separate facts and must stay separate: the
// user can SEE which one applies, so conflating them contradicts the screen.
check(/every selected box already matches its ink exactly/.test(appJs),
  "fitSelectionToInkBounds: the nothing-differs report must say the boxes already MATCH their ink (an equality), not that the contents fail to leave the box.");
check(/inkFitRefusalClause\(refused\)\}\. Nothing was changed\./.test(appJs),
  "fitSelectionToInkBounds: an all-refused run must report the REFUSAL's reason, not the already-matches sentence.");

if (failures) {
  console.error(`\n${failures} failure(s) — the ink-bounds gate is describing itself dishonestly.`);
  process.exit(1);
}
console.log("ink_fit_sentences: OK — overflow language absent from both surfacings; three distinct gate clauses (no subject / already matches / refused); command reads the app's clause; both no-op reports state their own true reason.");
