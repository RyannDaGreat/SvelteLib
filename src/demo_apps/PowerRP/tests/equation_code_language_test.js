/**
 * THE EQUATION LANGUAGE'S TOKEN MAP — bare-node gate.
 *
 * web/equationCode.js's CLASS_TO_SCOPE maps the resolver's token classes onto Monaco
 * token scopes. That map CANNOT be derived: a resolver's class names and an editor
 * theme's scope names are two vocabularies with no mechanical relation between them.
 * The house rule for that case is "gate it so drift turns something red", and this is
 * the gate.
 *
 * WHAT DRIFT LOOKS LIKE, and why it would otherwise be silent: the class vocabulary
 * lives in core/expressions.js and is PAINTED by web/app.css's `.eq-tok-*` rules. Add
 * a class to the resolver and the inline field colours it the moment app.css gets a
 * rule; the code modal keeps rendering it in the default foreground, with no error
 * anywhere — the exact failure mode that shipped once already in this feature (a
 * whole expression as one `mtk1` run, no warning). So app.css's rules are taken as
 * THE ROSTER and the map is checked against them in both directions.
 *
 * Also checks the pure functions' documented behaviour, since lineTokens' output is a
 * wire format for Monaco (tokens sorted from index 0, gaps stated explicitly) and an
 * off-by-one there reads like a font problem rather than a bug.
 *
 * Run: node src/demo_apps/PowerRP/tests/equation_code_language_test.js
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import assert from "node:assert/strict";
import { CLASS_TO_SCOPE, lineTokens, splitEquationMarker, completionKind } from "../web/equationCode.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(resolve(HERE, "../web/app.css"), "utf8");

const fails = [];
const test = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); fails.push(name); }
};

// A tiny state the resolver can classify against: one item (so `self.` resolves) and
// one variable (so an identifier can come back as `var` rather than `error`).
const ctx = {
  state: { items: { a1: { type: "rect", name: "Box", x: 0, y: 0, w: 10, h: 10 } }, vars: { speed: 2 } },
  selfId: "a1",
  scriptExports: {},
};

console.log("equation_code_language_test");

test("THE GATE: every class app.css paints is in CLASS_TO_SCOPE, and vice versa", () => {
  // `.numfield .eq-tok-<cls> { … }` is how the inline field declares it paints a class.
  const painted = new Set([...css.matchAll(/\.eq-tok-([a-z]+)\b/g)].map((m) => m[1]));
  assert.ok(painted.size >= 10, `expected app.css to paint the eq-tok classes; found ${painted.size}`);
  const mapped = new Set(Object.keys(CLASS_TO_SCOPE));
  const unmapped = [...painted].filter((c) => !mapped.has(c));
  const orphaned = [...mapped].filter((c) => !painted.has(c));
  assert.deepEqual(unmapped, [],
    `app.css paints these classes but the code modal has no scope for them (they would render uncoloured, silently): ${unmapped.join(", ")}`);
  assert.deepEqual(orphaned, [],
    `CLASS_TO_SCOPE names these classes but app.css paints no such class — one of the two is stale: ${orphaned.join(", ")}`);
});

test("every scope is one the sibling grammars already use (so the theme colours it)", () => {
  // The measured failure this guards: a scope no theme knows resolves to the default
  // foreground with no error. monacoSetup.js's grammars are the proof-of-colour set.
  const monacoSetup = readFileSync(resolve(HERE, "../web/monacoSetup.js"), "utf8");
  for (const scope of new Set(Object.values(CLASS_TO_SCOPE))) {
    if (scope === "invalid") continue; // vs/vs-dark's own error scope; no sibling uses it
    assert.ok(monacoSetup.includes(`"${scope}"`),
      `scope ${JSON.stringify(scope)} appears in no sibling grammar, so nothing proves the theme colours it`);
  }
});

test("splitEquationMarker peels the `=` and leaves the expression", () => {
  assert.deepEqual(splitEquationMarker("= self.w * 2"), { lead: "= ", expr: "self.w * 2" });
  assert.deepEqual(splitEquationMarker("1 +\n  2"), { lead: "", expr: "1 +\n  2" });
  assert.deepEqual(splitEquationMarker("=\n  self.w"), { lead: "=\n  ", expr: "self.w" });
});

test("lineTokens states every gap, and always starts at index 0", () => {
  assert.deepEqual(lineTokens("1 + 2", ctx), [
    { startIndex: 0, scopes: "number" },
    { startIndex: 1, scopes: "" },
    { startIndex: 2, scopes: "operator" },
    { startIndex: 3, scopes: "" },
    { startIndex: 4, scopes: "number" },
  ]);
  // An empty line and a whitespace-only line still need one token at 0 — Monaco
  // requires it, and returning [] would throw inside the editor.
  assert.deepEqual(lineTokens("", ctx), [{ startIndex: 0, scopes: "" }]);
  assert.deepEqual(lineTokens("   ", ctx), [{ startIndex: 0, scopes: "" }]);
  for (const line of ["self.w * 2 +", "  abs(self.h) +", "  nope", "speed"])
    assert.equal(lineTokens(line, ctx)[0].startIndex, 0, `first token must be at index 0 for ${JSON.stringify(line)}`);
});

test("the `=` marker becomes its own token and shifts the rest", () => {
  assert.deepEqual(lineTokens("= 7", ctx), [
    { startIndex: 0, scopes: "delimiter" },
    { startIndex: 2, scopes: "number" },
  ]);
});

test("PER-LINE resolution is faithful — a line need not be a whole expression", () => {
  // This is what lets the provider be per-line at all (the resolver classifies
  // LEXICALLY). If it ever needed a complete parse, these would collapse to one
  // `error` span and the modal would paint every continuation line red.
  const scopesOf = (line) => lineTokens(line, ctx).filter((t) => t.scopes).map((t) => t.scopes);
  assert.deepEqual(scopesOf("self.w * 2 +"), ["keyword", "operator", "number", "operator"]);
  assert.deepEqual(scopesOf("  abs(self.h) +"), ["type.identifier", "delimiter", "keyword", "delimiter", "operator"]);
  assert.deepEqual(scopesOf("speed"), ["identifier"]);
  // An unresolvable name is the resolver's OWN verdict, and it must survive to the
  // editor — this is the one token the author most needs coloured.
  assert.deepEqual(scopesOf("  nope"), ["invalid"]);
});

test("with NO resolver context the line is left uncoloured, never guessed", () => {
  assert.deepEqual(lineTokens("self.w + nope", null), [{ startIndex: 0, scopes: "" }]);
});

test("completionKind falls back to Text rather than throwing on a new kind", () => {
  const monaco = { languages: { CompletionItemKind: { Keyword: 1, Class: 2, Variable: 3, Property: 4, Function: 5, Text: 9 } } };
  assert.equal(completionKind(monaco, "function"), 5);
  assert.equal(completionKind(monaco, "variable"), 3);
  assert.equal(completionKind(monaco, "brand-new-kind"), 9);
});

if (fails.length) {
  console.error(`\nequation_code_language_test FAILED: ${fails.length} — ${fails.join(", ")}`);
  process.exit(1);
}
console.log("equation_code_language_test PASSED");
