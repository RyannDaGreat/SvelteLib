/**
 * ui_font_bundled_first_test.js — A THEME THAT NAMES A BUNDLED FACE MUST NAME
 * THE BUNDLED FORM FIRST.
 *
 * THE BUG THIS MAKES UNREPEATABLE, and it shipped. `futura-dark` and
 * `futura-light` — the two themes whose entire identity is TYPOGRAPHY — set
 * `--a-ui-font: Futura, Jost, "Century Gothic", "Avenir Next", system-ui`, every
 * one of those an OS family name. Measured in this app's own browser against a
 * family name that certainly does not exist, all three resolved to the SAME
 * last-resort face as the control, while `"PowerRP Futura"` did not. So the
 * typography-led theme rendered in the fallback on every platform, for five
 * days, while the real Renner Futura sat loaded in `document.fonts` — the file
 * having been committed five days BEFORE the theme was written.
 *
 * WHY IT WAS INVISIBLE. `render_gpu/fonts.js` gives every committed face a
 * UNIQUE `PowerRP <name>` cssFamily on purpose, so a local @font-face can never
 * collide with a same-named OS font. THE COROLLARY IS THE TRAP: asking for the
 * OS name therefore never reaches the bundled file. Nothing errors, nothing
 * warns, and `document.fonts.check()` reports SUCCESS — it only tracks FontFace
 * objects and answers true for an absent system family. The only way to see it
 * is to measure text width against a nonexistent-family control, which is not
 * something anyone does by accident.
 *
 * THE RULE — BUNDLED FIRST, not bundled-only. A stack may still name OS families
 * as a courtesy to a machine that happens to have them; what it may not do is
 * name one BEFORE the bundled form, because the browser takes the first family
 * that resolves. So `"PowerRP Futura", Futura` is correct and `Futura,
 * "PowerRP Futura"` is the bug with the fix appended after it, which is the
 * shape a well-meaning repair would most likely produce.
 *
 * THE BUNDLED SET IS DERIVED from `render_gpu/fonts.js`'s cssFamily values, never
 * restated here — a hand-kept copy of another module's shape is this codebase's
 * worst recurring defect (ledger C-8), and a mirror would silently exempt every
 * font added after this file was written, which is exactly when it is needed.
 *
 * Run:  node tests/ui_font_bundled_first_test.js
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stripCssComments } from "./cssComments.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const CSS = join(HERE, "..", "web", "app.css");
const FONTS_JS = join(HERE, "..", "render_gpu", "fonts.js");

/** The prefix `render_gpu/fonts.js` gives every committed face, so a local
 *  @font-face can never collide with a same-named OS font. */
const PREFIX = "PowerRP ";

/**
 * Pure function. The bare family names of every BUNDLED face, derived from
 * fonts.js's `cssFamily: "PowerRP <name>"` entries.
 *
 * @param {string} src - render_gpu/fonts.js text
 * @returns {string[]} e.g. ["Inter", "Futura", "Jost", …]
 *
 * COMMENTS ARE STRIPPED FIRST, and this gate shipped WITHOUT that for one draft
 * — which is ledger C-14 committed by an author who cites C-14 two files away.
 * `fonts.js:265` documents `dynamicFontFaces()` with an `@example` containing
 * `cssFamily:"PowerRP Font X.ttf"`, so the comment-blind read derived FOURTEEN
 * families where thirteen ship, the extra being a doc example. Harmless today
 * (no stack names it) and exactly the shape that later produces a bogus red or
 * masks a real one. Caught only because the printed count disagreed with a grep
 * by one — a reminder that a gate should report the size of the set it derived,
 * so a wrong set is visible instead of silent.
 * `stripCssComments` on a .js file is not a category error: `/* … *\/` is the
 * same syntax in both languages, and the alternative is a second stripper, which
 * `one_css_stripper_ban_test.js` exists to prevent. Line comments are NOT
 * stripped; verified that no `//` line in fonts.js carries this pattern, and if
 * one ever does the count check below is what will surface it.
 *
 * @example bundledFamilies('cssFamily: "PowerRP Futura",') // ["Futura"]
 * @example bundledFamilies('cssFamily: SYSTEM_STACK,') // [] — not a bundled face
 * @example bundledFamilies('/* @example cssFamily:"PowerRP Font X.ttf" *\/') // [] — a doc example
 */
function bundledFamilies(src) {
  const code = stripCssComments(src);
  return [...code.matchAll(new RegExp(`cssFamily:\\s*"${PREFIX}([^"]+)"`, "g"))].map((m) => m[1]);
}

/**
 * Pure function. Every `--a-ui-font` value in a stylesheet, with its line.
 *
 * @param {string} css - stylesheet text, comments already stripped
 * @returns {{line: number, value: string}[]}
 *
 * @example uiFontDeclarations("  --a-ui-font: Futura, sans-serif;")
 * // [{ line: 1, value: "Futura, sans-serif" }]
 */
function uiFontDeclarations(css) {
  const out = [];
  css.split("\n").forEach((text, i) => {
    const m = text.match(/^[ \t]*--a-ui-font:\s*([^;]+);/);
    if (m) out.push({ line: i + 1, value: m[1].trim() });
  });
  return out;
}

/**
 * Pure function. Bundled families a stack names in their BARE form before (or
 * without) their `PowerRP` form — i.e. the families the browser will resolve to
 * something other than the shipped file.
 *
 * @param {string} stack - a font-family value
 * @param {string[]} families - bare names of bundled faces
 * @returns {string[]} the offending family names
 *
 * @example unreachableBundled('Futura, "Century Gothic"', ["Futura"]) // ["Futura"]
 * @example unreachableBundled('"PowerRP Futura", Futura', ["Futura"]) // [] — bundled first
 * @example unreachableBundled('Futura, "PowerRP Futura"', ["Futura"]) // ["Futura"] — too late
 * @example unreachableBundled('Georgia, serif', ["Futura"]) // [] — not a bundled family
 */
function unreachableBundled(stack, families) {
  const out = [];
  for (const fam of families) {
    // Word-boundary match on the bare name, ignoring the one inside `PowerRP <fam>`.
    const bare = new RegExp(`(^|[,\\s"'])(?!${PREFIX})${fam.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=["',]|$)`, "g");
    const bundledAt = stack.indexOf(`${PREFIX}${fam}`);
    for (const m of stack.matchAll(bare)) {
      const at = m.index + m[1].length;
      if (at === bundledAt) continue; // this IS the bundled occurrence
      if (bundledAt === -1 || at < bundledAt) { out.push(fam); break; }
    }
  }
  return out;
}

const families = bundledFamilies(readFileSync(FONTS_JS, "utf8"));
const decls = uiFontDeclarations(stripCssComments(readFileSync(CSS, "utf8")));

// REFUSE TO PASS VACUOUSLY — a parser that found nothing must be a red, not a
// green. Both floors are well under what ships today.
const MIN_FAMILIES = 10, MIN_DECLS = 3;
if (families.length < MIN_FAMILIES) {
  throw new Error(`ui_font_bundled_first: derived only ${families.length} bundled families from fonts.js — the parser is broken, not the registry`);
}
if (decls.length < MIN_DECLS) {
  throw new Error(`ui_font_bundled_first: found only ${decls.length} --a-ui-font declarations in app.css — the parser is broken, not the stylesheet`);
}

// The detector must be able to fail, proven on fixtures rather than asserted.
if (unreachableBundled('Futura, "Century Gothic", sans-serif', ["Futura"]).length !== 1) {
  throw new Error("ui_font_bundled_first self-test: the shipped bug is not detected");
}
if (unreachableBundled('"PowerRP Futura", Futura, sans-serif', ["Futura"]).length !== 0) {
  throw new Error("ui_font_bundled_first self-test: the CORRECT bundled-first form was flagged");
}
if (unreachableBundled('Georgia, "Times New Roman", serif', ["Futura", "Inter"]).length !== 0) {
  throw new Error("ui_font_bundled_first self-test: a non-bundled OS family was flagged");
}

const failures = [];
for (const { line, value } of decls) {
  for (const fam of unreachableBundled(value, families)) {
    failures.push(`app.css:${line}  names "${fam}" bare before (or without) "${PREFIX}${fam}"\n      ${value}`);
  }
}

if (failures.length) {
  console.error("A THEME MUST NAME THE BUNDLED FACE FIRST — these stacks reach the OS name instead:");
  for (const f of failures) console.error(`  ${f}`);
  console.error(`\nThe app SHIPS these faces and loads them at boot as "${PREFIX}<name>" (render_gpu/fonts.js, web/fontLoader.js).`);
  console.error(`An OS name never reaches the bundled file — that uniqueness is deliberate — so the theme renders in the last-resort face with NO error and document.fonts.check() reporting success.`);
  console.error(`Put "${PREFIX}<name>" FIRST and keep the OS name after it as a courtesy.`);
  process.exit(1);
}

console.log(`PASS ui_font_bundled_first_test — ${decls.length} --a-ui-font stacks checked against ${families.length} bundled families; every bundled face is named in its reachable form first.`);
