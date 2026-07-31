/**
 * GLASS-BLUR GUARD — the grep-guard precedent (theme_contrast_test.py) applied
 * to the "glass tooltips in glass themes only" idiom: every CSS rule in
 * app.css whose `background` reads one of the translucent glass tokens
 * (--a-glass-bg, --a-glass-bg-panel, --a-glass-tip-bg) — or paints a literal
 * rgba() with alpha < 1 — must ALSO declare backdrop-filter (both prefixes),
 * either on that rule itself or on a rule sharing its leading class-chain
 * (the .tt-tip.tt-tip / .tt-tip.tt-tip:has(...) pattern, where CSS composes
 * `background` and `backdrop-filter` from two different rules on one element).
 *
 * WHY THIS CATCHES THE REPORTED BUG: the glass tokens are INERT (`none` /
 * opaque) outside nocturne/daybreak (see :root's --a-glass-* comments), so a
 * surface painting one of them is OPTING IN to the glass material — and the
 * material is blur+tint together, never tint alone. A surface that reads
 * --a-glass-bg-panel without backdrop-filter is see-through in the glass
 * themes with nothing softening what shows through (the FontPicker dropdown
 * bug this test was written for: sharp canvas-text bleed through a translucent
 * popover). Parsing app.css directly (not re-deriving values by hand) is the
 * same reason theme_contrast_test.py reads the stylesheet instead of a
 * hand-copied dict: a hand-copied list of "the floating surfaces" goes stale
 * the moment a new one is added and nobody remembers to extend the list.
 *
 * Run: node src/demo_apps/PowerRP/tests/glass_blur_guard_test.js
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const CSS_PATH = resolve(HERE, "../web/app.css");

const GLASS_TOKENS = ["--a-glass-bg-panel", "--a-glass-bg", "--a-glass-tip-bg"];

/**
 * Pure function. Strips /* *\/ CSS comments so brace-matching below can't be
 * confused by braces or semicolons mentioned inside prose comments.
 *
 * Args:
 *     css (string): raw CSS source
 *
 * Returns:
 *     string
 *
 * Examples:
 *     >>> stripCssComments("a { color: red; } /* b { x: 1; } *\/ c { y: 2; }")
 *     'a { color: red; }  c { y: 2; }'
 */
export function stripCssComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/**
 * Pure function. Splits comment-free CSS text into flat {selector, body}
 * rules, recursing one level into @media/@supports wrappers so their nested
 * rules are reported too. Braces are matched by depth, not by line shape, so
 * multi-line selectors/values never desync the scan.
 *
 * Args:
 *     css (string): comment-free CSS source
 *
 * Returns:
 *     Array<{selector: string, body: string}>
 *
 * Examples:
 *     >>> extractRules("a { color: red; } @media (x) { b { color: blue; } }")
 *     [ { selector: 'a', body: ' color: red; ' }, { selector: 'b', body: ' color: blue; ' } ]
 */
export function extractRules(css) {
  const rules = [];
  const scan = (text) => {
    let i = 0;
    while (i < text.length) {
      const open = text.indexOf("{", i);
      if (open === -1) break;
      let depth = 1;
      let j = open + 1;
      while (j < text.length && depth > 0) {
        if (text[j] === "{") depth++;
        else if (text[j] === "}") depth--;
        j++;
      }
      const selector = text.slice(i, open).trim();
      const body = text.slice(open + 1, j - 1);
      if (!selector.startsWith("@") && !body.includes("{")) {
        rules.push({ selector, body });
      } else if (body.includes("{")) {
        scan(body); // one level of @media/@supports nesting
      }
      i = j;
    }
  };
  scan(css);
  return rules;
}

/**
 * Pure function. Extracts a rule's leading dot-class chain — the prefix built
 * only of `.class` tokens before any combinator, pseudo-class, or space.
 *
 * Args:
 *     selector (string): a CSS selector
 *
 * Returns:
 *     string | null
 *
 * Examples:
 *     >>> leadingClassChain(".tt-tip.tt-tip:has(.storage-local-tip)")
 *     '.tt-tip.tt-tip'
 *     >>> leadingClassChain(".fp-pop")
 *     '.fp-pop'
 *     >>> leadingClassChain("#weird")
 *     null
 */
export function leadingClassChain(selector) {
  const m = selector.match(/^((?:\.[a-zA-Z0-9_-]+)+)/);
  return m ? m[1] : null;
}

/**
 * Pure function. True when two leading class-chains describe the SAME
 * element family under CSS's per-property cascade — i.e. one is a
 * dot-boundary prefix of the other, so a `background` declared on the longer
 * (more specific) chain and a `backdrop-filter` declared on the shorter chain
 * both apply to the same element (CSS composes independently per property).
 *
 * Args:
 *     a (string): a leading class-chain
 *     b (string): another leading class-chain
 *
 * Returns:
 *     bool
 *
 * Examples:
 *     >>> chainsCompose(".tt-tip.tt-tip", ".tt-tip.tt-tip.tt-tip")
 *     True
 *     >>> chainsCompose(".fp-pop", ".palette")
 *     False
 */
export function chainsCompose(a, b) {
  if (a === b) return true;
  const [shorter, longer] = a.length < b.length ? [a, b] : [b, a];
  return longer.startsWith(shorter) && (longer[shorter.length] === "." || longer[shorter.length] === undefined);
}

/**
 * Pure function. True when a `background`/`background-color` value opts a
 * rule into the glass material: it reads one of the app's translucent glass
 * tokens, or paints a literal rgba() with alpha below 1.
 *
 * Args:
 *     bgValue (string): the raw value of a background/background-color decl
 *
 * Returns:
 *     bool
 *
 * Examples:
 *     >>> isGlassBackground("var(--a-glass-bg-panel)")
 *     True
 *     >>> isGlassBackground("rgba(0, 0, 0, 0.4)")
 *     True
 *     >>> isGlassBackground("var(--control-bg)")
 *     False
 */
export function isGlassBackground(bgValue) {
  if (GLASS_TOKENS.some((t) => bgValue.includes(t))) return true;
  const m = bgValue.match(/rgba\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*,\s*([\d.]+)\s*\)/);
  return Boolean(m && parseFloat(m[1]) < 1);
}

/**
 * Pure function. Given the parsed rules of a stylesheet, returns every rule
 * that paints a glass background (see isGlassBackground) but has no
 * backdrop-filter coverage — neither on itself nor on a rule composing with
 * it via chainsCompose.
 *
 * Args:
 *     rules (Array<{selector: string, body: string}>): extractRules() output
 *
 * Returns:
 *     Array<{selector: string, bgValue: string}>
 *
 * Examples:
 *     >>> uncoveredGlassRules([
 *     ...   {selector: ".a", body: "background: var(--a-glass-bg-panel);"},
 *     ... ])
 *     [{'selector': '.a', 'bgValue': 'var(--a-glass-bg-panel)'}]
 */
export function uncoveredGlassRules(rules) {
  const backdropChains = rules
    .filter((r) => /backdrop-filter\s*:/.test(r.body))
    .map((r) => leadingClassChain(r.selector))
    .filter(Boolean);

  const findings = [];
  for (const { selector, body } of rules) {
    const bgMatch = body.match(/\bbackground(-color)?\s*:\s*([^;]+);/);
    if (!bgMatch) continue;
    const bgValue = bgMatch[2].trim();
    if (!isGlassBackground(bgValue)) continue;
    if (/backdrop-filter\s*:/.test(body)) continue; // covered by itself
    const chain = leadingClassChain(selector);
    if (chain && backdropChains.some((c) => chainsCompose(chain, c))) continue; // covered by a composing rule
    findings.push({ selector, bgValue });
  }
  return findings;
}

// ── doctests (run inline; no separate doctest runner in this repo) ─────────
function runDoctests() {
  assert.equal(stripCssComments("a { color: red; } /* b { x: 1; } */ c { y: 2; }"), "a { color: red; }  c { y: 2; }");
  assert.deepEqual(extractRules("a { color: red; } @media (x) { b { color: blue; } }"), [
    { selector: "a", body: " color: red; " },
    { selector: "b", body: " color: blue; " },
  ]);
  assert.equal(leadingClassChain(".tt-tip.tt-tip:has(.storage-local-tip)"), ".tt-tip.tt-tip");
  assert.equal(leadingClassChain(".fp-pop"), ".fp-pop");
  assert.equal(leadingClassChain("#weird"), null);
  assert.equal(chainsCompose(".tt-tip.tt-tip", ".tt-tip.tt-tip.tt-tip"), true);
  assert.equal(chainsCompose(".fp-pop", ".palette"), false);
  assert.equal(isGlassBackground("var(--a-glass-bg-panel)"), true);
  assert.equal(isGlassBackground("rgba(0, 0, 0, 0.4)"), true);
  assert.equal(isGlassBackground("var(--control-bg)"), false);
  assert.deepEqual(
    uncoveredGlassRules([{ selector: ".a", body: "background: var(--a-glass-bg-panel);" }]),
    [{ selector: ".a", bgValue: "var(--a-glass-bg-panel)" }]
  );
  console.log("  ok  doctests");
}

runDoctests();

const css = readFileSync(CSS_PATH, "utf8");
const rules = extractRules(stripCssComments(css));
const uncovered = uncoveredGlassRules(rules);

if (uncovered.length > 0) {
  console.error("Rules with a translucent/glass-token background but NO backdrop-filter coverage:");
  for (const f of uncovered) console.error(`  ${f.selector}  background: ${f.bgValue}`);
}
assert.equal(uncovered.length, 0, `${uncovered.length} glass-background rule(s) missing backdrop-filter — see list above`);
console.log(`  ok  every glass-background rule in app.css has backdrop-filter coverage (${rules.length} rules scanned)`);

console.log("PASS glass_blur_guard_test.js");
