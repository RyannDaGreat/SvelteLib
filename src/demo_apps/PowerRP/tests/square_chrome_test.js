/**
 * square_chrome_test.js — APP CHROME IS SQUARE, enforced by grep instead of by memory.
 *
 * `app.css:671-673` declares the radius family and states the rule:
 *   --a-radius-control: 0    square — the app-chrome rule
 *   --a-radius-panel:   0    square — docked furniture matches its controls
 *   --a-radius-floating: var(--radius)   today's 4px cap, the one rounded family
 *
 * `--radius` is the cap for `src/lib` REUSABLE COMPONENTS. App chrome — fields,
 * buttons, swatches, chips, panels, nav items — is square. Rounding is reserved
 * for the few floating surfaces, and they reach it through
 * `--a-radius-floating`, never through `--radius` directly.
 *
 * WHY THIS FILE EXISTS, and it is not because anyone was careless. That rule was
 * written in the shared agent brief, restated in a convention ledger, and repeated
 * in individual instructions to a dozen agents over one day. It was still violated
 * FIVE times, in `.gradient-swatch`, `.brush-cat-chip`, `.brush-swatch`,
 * `.code-modal-btn` and `.debug-nav-item` — and it was a USER who noticed, by
 * looking at the built-in widget browser and seeing rounded tiles inside a square
 * frame. One of the five was a REGRESSION of a task that had already squared that
 * exact element.
 *
 * So the lesson is the one this codebase keeps teaching and this file is the
 * response to it: A RULE WITHOUT A GATE IS A SUGGESTION. Prose scales badly and
 * rots silently; a grep does neither.
 *
 * PRECEDENT: `tests/connectivity_seam_test.js` — same shape (one forbidden token,
 * one documented exemption, a reason a reviewer cannot be expected to remember),
 * and `tests/orphan_class_test.js`, from which this borrows the comment-stripping
 * discipline.
 *
 * Run:  node tests/square_chrome_test.js
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CSS = join(HERE, "..", "web", "app.css");

/** The ONE line permitted to read `--radius`: the floating-family definition.
 *  Everything else in app.css must go through a named `--a-radius-*` token. */
const ALLOWED = /^\s*--a-radius-floating:\s*var\(--radius\)/;

/**
 * Pure function. Strips CSS comments so prose that merely NAMES a token is not
 * counted as a use.
 *
 * COMMENTS ARE NOT CODE, and getting this wrong breaks the gate in BOTH
 * directions — measured twice in one hour on 2026-08-01. An orphan-class gate
 * counted commented class names as definitions and so passed while a real
 * selector was renamed out from under it; a duplicate-sentence sweep counted
 * commented mentions as copies and reported 19 where there was 1. app.css
 * explains itself heavily, which is a virtue everywhere except inside a grep.
 *
 * @param {string} css
 * @returns {string} the same text with comment bodies blanked, LINE COUNT PRESERVED
 *
 * @example stripComments("a{} /* --radius *\/ b{}").includes("--radius") // false
 * @example stripComments("a\n/* x *\/\nb").split("\n").length // 3 — line numbers survive
 */
function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
}

/**
 * Pure function. Every line that reads `--radius` directly and is not the one
 * allowed definition.
 *
 * @param {string} css - stylesheet text, comments already stripped
 * @returns {{line: number, text: string}[]}
 *
 * @example violations("--a-radius-floating: var(--radius);") // []
 * @example violations("  border-radius: var(--radius);").length // 1
 * @example violations("  border-radius: var(--a-radius-control);") // []
 */
function violations(css) {
  const out = [];
  css.split("\n").forEach((line, i) => {
    if (!line.includes("var(--radius)")) return;
    if (ALLOWED.test(line)) return;
    out.push({ line: i + 1, text: line.trim() });
  });
  return out;
}

const raw = readFileSync(CSS, "utf8");
const css = stripComments(raw);
const failures = [];

// ── 1. THE RULE ──────────────────────────────────────────────────────────────
const bad = violations(css);
for (const v of bad) {
  failures.push(
    `web/app.css:${v.line} reads --radius directly.\n` +
      `    App chrome is SQUARE: use var(--a-radius-control) for a control,\n` +
      `    var(--a-radius-panel) for docked furniture, or var(--a-radius-floating)\n` +
      `    if this really is one of the few floating surfaces.\n` +
      `    ${v.text}`,
  );
}

// ── 2. THE GATE MUST BE ABLE TO FAIL ─────────────────────────────────────────
// Four gates were found this round that could not fail — each proved only the
// case its author was picturing. So this one proves itself on fixtures of every
// shape it claims to handle, rather than asserting its own correctness.
if (violations("  border-radius: var(--radius);").length !== 1) {
  failures.push("SELF-CHECK: the gate does not catch a bare direct use — it is vacuous");
}
if (violations("--a-radius-floating: var(--radius);").length !== 0) {
  failures.push("SELF-CHECK: the gate rejects the one ALLOWED definition");
}
if (stripComments("/* var(--radius) */").includes("--radius")) {
  failures.push("SELF-CHECK: comments are being counted as uses — the gate will cry wolf");
}
if (violations("  border-radius: var(--a-radius-control);").length !== 0) {
  failures.push("SELF-CHECK: the gate flags a CORRECT token — it would block the fix it demands");
}

// ── 3. NON-VACUITY ───────────────────────────────────────────────────────────
// A guard that reads an empty or wrong file passes trivially. Pin that it is
// looking at a real stylesheet with the radius family actually declared.
if (!/--a-radius-control:\s*0/.test(css)) {
  failures.push("app.css does not declare --a-radius-control: 0 — the token family is gone or this is the wrong file");
}
if (raw.length < 10000) failures.push(`app.css is only ${raw.length} bytes — this is not the stylesheet`);

if (failures.length) {
  console.error(`\nFAIL square_chrome_test (${failures.length}):\n`);
  for (const f of failures) console.error(`  · ${f}`);
  process.exit(1);
}
console.log(`PASS square_chrome_test — app chrome is square; --radius reached only through --a-radius-floating (${raw.split("\n").length} lines swept).`);
