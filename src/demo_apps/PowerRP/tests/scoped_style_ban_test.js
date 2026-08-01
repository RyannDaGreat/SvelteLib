/**
 * SCOPED-`<style>` BAN — "styling lives in app.css", enforced by grep.
 * Run: node src/demo_apps/PowerRP/tests/scoped_style_ban_test.js
 *
 * THE CONVENTION, from the app's CLAUDE.md: "App components carry NO <style>
 * blocks; all styling in app.css via --a-* tokens (annotator convention)." Fifty
 * of the fifty-two components in web/ say so in their own header — "Styling lives
 * in app.css (.boolfield; app convention: no <style>)" — which is how strongly
 * held this is, and also why it needed a gate: a rule restated fifty times is a
 * rule nobody will notice being broken the fifty-first.
 *
 * WHY IT MATTERS, and this is measured rather than asserted. web/ContextMenu.svelte
 * is the one component that kept a scoped block, for a good and dated reason (see
 * the exemption below). Its own header now records what that cost: living outside
 * app.css let it invent FIVE private answers to questions app.css had already
 * settled — a `var(--a-danger, #e05252)` phantom token painting a hardcoded hex in
 * all ~25 themes, a hand-picked `z-index: 60` where `--a-z-popover` exists, a
 * fourth radius token past the 4px cap, and a translucent panel with no
 * backdrop-filter at all. None of them was visible to any sweep, because every
 * sweep read app.css. That is the whole argument: a component stylesheet is not
 * merely untidy, it is UNPOLICED.
 *
 * THE SET IS EXACT, not a floor. A new offender fails, and so does a STALE
 * exemption — if ContextMenu's block finally moves, this file must be told, or the
 * exemption sits here forever claiming a debt that is paid.
 *
 * SCOPE: web/ only. src/lib components are reusable library code shared with other
 * demo apps; scoped styles are exactly right there, and they ship host-independent
 * defaults plus an override contract. tests/native_tooltip_ban_test.js draws the
 * same boundary for the same reason.
 *
 * PRECEDENT: tests/native_tooltip_ban_test.js and tests/square_chrome_test.js —
 * one forbidden shape, named exemptions with reasons, a self-check proving the
 * gate can fail, and a non-vacuity floor.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = resolve(HERE, "../web");

/**
 * The components allowed to keep a scoped block, and why. REMOVE AN ENTRY THE DAY
 * ITS BLOCK MOVES — the gate fails on a stale exemption too.
 */
const EXEMPT = {
  "ContextMenu.svelte":
    "Dated deferral, re-dated 2026-08-01 in the file's own header rather than left silent. " +
    "Original reason (fde04ee): the component was new and app.css was owned by a sibling agent. " +
    "Current reason: app.css again carries another agent's uncommitted hunks, and a pathspec " +
    "commit takes the WHOLE file, so moving the block would sweep their in-flight work into " +
    "someone else's commit. The relocation is mechanical — every declaration is already a shared " +
    "token, so it is a copy with the selectors reparented under `.main`.",
};

/**
 * Pure function. Blanks HTML comment bodies, PRESERVING LINE COUNT.
 *
 * THIS IS THE WHOLE GATE, and getting it wrong inverts the answer. A first pass
 * without it reported 39 of 52 components as violators — because fifty of them
 * contain the sentence "app convention: no <style> blocks" IN A COMMENT. A
 * comment-blind grep over this codebase fails in both directions; here it failed
 * in the direction that manufactures 38 phantom defects.
 *
 * @param {string} src Svelte component source
 * @returns {string} the same text, comment bodies blanked
 *
 * @example stripHtmlComments("<!-- no <style> here -->\n<div/>").includes("<style")
 * // false
 * @example stripHtmlComments("<!-- a -->\n<style>").split("\n").length
 * // 2 — line numbers survive
 */
export function stripHtmlComments(src) {
  return src.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, " "));
}

/**
 * Pure function. The 1-based lines carrying a real `<style>` OPENING TAG.
 *
 * @param {string} src Svelte component source
 * @returns {number[]}
 *
 * @example styleTagLines("<div/>\n<style>\n.a{}\n</style>")
 * // [2]
 * @example styleTagLines("<!-- app convention: no <style> blocks -->\n<div/>")
 * // [] — the rule stated in prose is not a violation of itself
 */
export function styleTagLines(src) {
  const out = [];
  stripHtmlComments(src).split("\n").forEach((line, i) => {
    if (/<style[\s>]/.test(line)) out.push(i + 1);
  });
  return out;
}

const components = readdirSync(WEB).filter((f) => f.endsWith(".svelte")).sort();
const carrying = new Map();
for (const f of components) {
  const lines = styleTagLines(readFileSync(resolve(WEB, f), "utf8"));
  if (lines.length) carrying.set(f, lines);
}

const failures = [];
for (const [f, lines] of carrying) {
  if (f in EXEMPT) continue;
  failures.push(`web/${f}:${lines.join(",")} carries a scoped <style> block.\n` +
    "    App components style themselves through web/app.css and --a-* tokens. A component\n" +
    "    stylesheet is outside every sweep this repo runs, which is how ContextMenu.svelte\n" +
    "    accumulated five private answers to settled questions. Move the rules to app.css,\n" +
    "    or add a dated exemption here saying why it cannot move yet.");
}
for (const f of Object.keys(EXEMPT)) {
  if (!carrying.has(f)) failures.push(`web/${f} is exempted here but no longer carries a <style> block — the debt is PAID. Delete its EXEMPT entry.`);
}

// ── THE GATE MUST BE ABLE TO FAIL ────────────────────────────────────────────
// Proven on every shape it claims to handle, because a gate that only handles the
// case its author pictured is the defect this round keeps finding.
assert.deepEqual(styleTagLines("<div/>\n<style>\n.a{}\n</style>"), [2], "SELF-CHECK: a real <style> tag is not seen — the gate is vacuous");
assert.deepEqual(styleTagLines("<!-- app convention: no <style> blocks -->\n<div/>"), [], "SELF-CHECK: a commented mention counts as a violation — the gate would cry wolf on 38 correct files");
assert.deepEqual(styleTagLines('<style lang="postcss">\n</style>'), [1], "SELF-CHECK: an ATTRIBUTED style tag slips through");
assert.deepEqual(styleTagLines("<p>styles</p>"), [], "SELF-CHECK: the word 'style' in markup counts as a tag");
assert.equal(stripHtmlComments("<!-- a -->\n<style>").split("\n").length, 2, "SELF-CHECK: the stripper eats lines — every reported line number would be wrong");

// ── NON-VACUITY ──────────────────────────────────────────────────────────────
// A detector that found nothing would pass an empty sweep. Pinning the corpus is
// enough here: the EXACT-SET rule above already turns "the detector stopped
// seeing anything" into a stale-exemption failure with a readable message, and
// an extra `carrying.size >= 1` assertion would pre-empt that message with a
// stack — measured, on the fixture that proves this branch.
assert.ok(components.length >= 40, `only ${components.length} components found in web/ — the scan is looking in the wrong place`);

if (failures.length) {
  console.error(`\nFAIL scoped_style_ban_test (${failures.length}):\n`);
  for (const f of failures) console.error(`  · ${f}`);
  process.exit(1);
}
console.log(`PASS scoped_style_ban_test — ${components.length} components in web/, ${carrying.size} carrying a scoped <style>, all of them exempted with a dated reason.`);
