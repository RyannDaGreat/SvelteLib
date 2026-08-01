/**
 * PHANTOM-TOKEN BAN — `var(--undeclared, literal)` is a SILENT FALLBACK in CSS form.
 * Run: node src/demo_apps/PowerRP/tests/phantom_token_ban_test.js
 * Inventory (every var() fallback the scanner sees, live token or phantom):
 *     node src/demo_apps/PowerRP/tests/phantom_token_ban_test.js --inventory
 *
 * THE RULE, from convention ledger C-3, raised by W3-C and measured:
 * `web/ContextMenu.svelte` painted `color: var(--a-danger, #e05252)`. `--a-danger`
 * DOES NOT EXIST, so every danger row in the app painted a hardcoded hex that no
 * theme could reach — while app.css:427 states verbatim that `--a-guide` IS this
 * design system's danger colour and ~25 theme blocks tune it. Nothing warned:
 * `var()` with a fallback is VALID CSS and looks deliberate. It is the same law
 * that bans `?? fallback` in JS, and it is worse than the JS form because the
 * failure is invisible even at runtime.
 *
 * A LIVE TOKEN WITH A FALLBACK IS FINE. `var(--cf-swatch, #00000000)` is correct:
 * ColorField sets `--cf-swatch` inline per instance (ColorField.svelte:259), and
 * the fallback is the value before one is chosen. The defect is specifically a
 * fallback for a token NOBODY DECLARES — a hardcoded value wearing a theme lever's
 * clothes. So the gate resolves the token against every place one can be declared:
 * a `--x:` declaration in app.css or any component's `<style>`, and a Svelte
 * `style:--x` / `style="--x: …"` binding in any component's markup.
 *
 * WHY IT EXISTS AS A GATE, in the ledger's own words: "Sweep for the shape, not
 * just this instance." Nobody had. The sweep found EIGHT sites across four tokens.
 *
 * AND THEN THE GATE EARNED ITSELF INSIDE THE HOUR. Three of those tokens
 * (--a-debug-nav-w, --a-debug-cache-fold-h, --a-debug-preview-max, seven sites) were
 * declared by the agent who owns web/app.css while this file was being written, and
 * the EXACT-SET rule below turned that into three failures reading "the debt is PAID.
 * Delete its entry." A floor would have gone quiet; an exact set made the repayment
 * visible. That is also why the ledger is keyed by NAME: app.css moved ~150 lines
 * twice during this one investigation.
 *
 * PRECEDENT: tests/square_chrome_test.js — one forbidden shape, named exemptions
 * with reasons, a self-check proving the gate can fail, a non-vacuity floor.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolve(HERE, "..");
const WEB = resolve(APP, "web");
const LIB = resolve(APP, "../../lib");
const inventory = process.argv.includes("--inventory");

/**
 * KNOWN PHANTOMS, KEYED BY TOKEN NAME — the debt this gate froze on the day it was
 * written, so the count can only go DOWN. Every entry names the FIX and its OWNER,
 * and the summary line PRINTS them on a passing run: a gate that is red for a
 * reason it names is honest, and a gate that quietly exempts four tokens is how
 * debt becomes design.
 *
 * KEYED BY NAME AND NOT BY LINE, deliberately: web/app.css moved 156 lines under
 * this very investigation between two measurements an hour apart. A line-keyed
 * ledger in a file ten agents are editing is wrong before it is committed.
 *
 * NOT FIXED HERE, and that is a rule rather than a shrug: web/app.css belongs to
 * another agent who is rewriting theme structure right now, and four mechanical
 * declarations landing underneath a live rewrite is the co-tenant hazard that
 * broke this fleet's tree twice today. Ledger C-19: the assertion follows the fix.
 */
const PHANTOM_DEBT = {
  "--ae-quota-fill":
    "DO NOT DECLARE THIS ONE — the fix is DELETION. `.asset-explorer .ae-quota-bar-fill` reads it, and " +
    "web/AssetExplorer.svelte no longer renders `.ae-quota-bar` or `.ae-quota-bar-fill` at all (eec6819: " +
    "'Asset Explorer quota: text only, fill bar removed'). The markup went; three rules stayed. Declaring " +
    "the token would make a bar that is permanently 0% wide into VALID css, enshrining a dead control. " +
    "Owner: W4-P (web/app.css) — delete .ae-quota-bar, .ae-quota-bar-fill and the .ae-quota-nearly-full " +
    ".ae-quota-bar-fill override.",
};

/**
 * Pure function. Blanks CSS comment bodies, PRESERVING LINE COUNT.
 *
 * Line preservation is not cosmetic: a stripper spelled `^\s*` eats the blank
 * line above a comment (because `\s` matches `\n`) and every subsequent citation
 * is wrong, which costs a reader more than the finding saves.
 *
 * @param {string} css
 * @returns {string}
 *
 * @example stripCssComments("a{} /* var(--x, 1px) *\/ b{}").includes("--x")
 * // false
 * @example stripCssComments("a{}\n/* p *\/\nb{}").split("\n").length
 * // 3
 */
export function stripCssComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
}

/**
 * Pure function. Blanks HTML comment bodies, PRESERVING LINE COUNT.
 *
 * @param {string} src
 * @returns {string}
 *
 * @example stripHtmlComments("<!-- var(--x, 1px) -->").includes("--x")
 * // false
 * @example stripHtmlComments("<!-- a -->\nb").split("\n").length
 * // 2
 */
export function stripHtmlComments(src) {
  return src.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, " "));
}

/**
 * Pure function. Every custom-property name this text DECLARES, in any of the
 * three spellings the app uses.
 *
 * @param {string} text CSS or Svelte source, comments already blanked
 * @returns {Set<string>}
 *
 * @example [...declaredTokens(":root { --a-sp-1: 4px; }")]
 * // ["--a-sp-1"]
 * @example [...declaredTokens('<div style:--cf-swatch={css}></div>')]
 * // ["--cf-swatch"] — Svelte's per-instance binding declares it too
 * @example [...declaredTokens('<div style="--gp-accent: red"></div>')]
 * // ["--gp-accent"] — and so does an inline style string
 */
export function declaredTokens(text) {
  const out = new Set();
  for (const m of text.matchAll(/(--[a-zA-Z0-9_-]+)\s*:/g)) out.add(m[1]);
  for (const m of text.matchAll(/style:(--[a-zA-Z0-9_-]+)/g)) out.add(m[1]);
  return out;
}

/**
 * Pure function. Every `var(--name, fallback)` USE in one line, as [name, fallback].
 *
 * A bare `var(--name)` is not a use of interest: with no fallback there is nothing
 * silent about it — an undeclared token simply makes the declaration invalid and
 * the property falls back to inherited/initial, which is visible.
 *
 * @param {string} line one line of source, comments already blanked
 * @returns {Array<[string, string]>}
 *
 * @example varFallbacks("  width: var(--a-debug-nav-w, 180px);")
 * // [["--a-debug-nav-w", "180px"]]
 * @example varFallbacks("  color: var(--fg);")
 * // [] — no fallback, nothing silent
 */
export function varFallbacks(line) {
  return [...line.matchAll(/var\(\s*(--[a-zA-Z0-9_-]+)\s*,\s*([^)]+)\)/g)].map((m) => [m[1], m[2].trim()]);
}

/** Query. Every source whose declarations count, plus the CSS the gate scans. */
function sources() {
  const svelte = (dir) => readdirSync(dir).filter((f) => f.endsWith(".svelte")).sort().map((f) => ({ dir, f }));
  const scanned = [{ file: "web/app.css", text: stripCssComments(readFileSync(resolve(WEB, "app.css"), "utf8")) }];
  for (const { dir, f } of svelte(WEB)) scanned.push({ file: `web/${f}`, text: stripHtmlComments(readFileSync(resolve(dir, f), "utf8")) });
  // src/lib components DECLARE tokens the app reads (Modal's --modal-* contract),
  // so they count as declaration sites — but they are library code with their own
  // conventions, so their own var() uses are not policed here.
  const declaringOnly = svelte(LIB).map(({ dir, f }) => stripHtmlComments(readFileSync(resolve(dir, f), "utf8")));
  return { scanned, declaringOnly };
}

const { scanned, declaringOnly } = sources();
const declared = new Set();
for (const s of scanned) for (const t of declaredTokens(s.text)) declared.add(t);
for (const t of declaringOnly) for (const n of declaredTokens(t)) declared.add(n);

const uses = [];
for (const { file, text } of scanned) {
  text.split("\n").forEach((line, i) => {
    for (const [name, fallback] of varFallbacks(line)) uses.push({ file, line: i + 1, name, fallback });
  });
}
const phantoms = uses.filter((u) => !declared.has(u.name));

if (inventory) {
  for (const u of uses) console.log(`${declared.has(u.name) ? "live   " : "PHANTOM"}  ${u.file}:${u.line}  ${u.name} -> ${u.fallback}`);
  console.log(`\n${uses.length} var() fallbacks, ${phantoms.length} phantom, across ${scanned.length} sources`);
  process.exit(0);
}

const failures = [];
for (const p of phantoms) {
  if (p.name in PHANTOM_DEBT) continue;
  failures.push(`${p.file}:${p.line} reads var(${p.name}, ${p.fallback}) but ${p.name} is DECLARED NOWHERE.\n` +
    "    That is a silent fallback: valid CSS, looks deliberate, and paints a hardcoded value\n" +
    "    no theme can override. Declare the token, or use the one that already means this\n" +
    "    (ledger C-3: --a-guide IS the danger colour; --a-z-popover IS the popover tier).");
}
for (const name of Object.keys(PHANTOM_DEBT)) {
  if (!phantoms.some((p) => p.name === name)) failures.push(`${name} is listed in PHANTOM_DEBT but is no longer phantom — the debt is PAID. Delete its entry.`);
}

// ── THE GATE MUST BE ABLE TO FAIL ────────────────────────────────────────────
// On every shape it claims to handle, including the exact historical defect.
assert.deepEqual(varFallbacks("  color: var(--a-danger, #e05252);"), [["--a-danger", "#e05252"]],
  "SELF-CHECK: the original C-3 defect shape is not parsed — the gate is vacuous");
assert.deepEqual(varFallbacks("  color: var(--fg);"), [], "SELF-CHECK: a bare var() is treated as a fallback");
assert.deepEqual([...declaredTokens(":root { --a-sp-1: 4px; }")], ["--a-sp-1"], "SELF-CHECK: a plain declaration is not recognised — every token would read as phantom");
assert.deepEqual([...declaredTokens("<div style:--cf-swatch={css}></div>")], ["--cf-swatch"], "SELF-CHECK: a Svelte style: binding is not a declaration — ColorField's swatch would read as phantom");
assert.deepEqual([...declaredTokens('<div style="--gp-accent: red"></div>')], ["--gp-accent"], "SELF-CHECK: an inline style string is not a declaration");
assert.ok(!stripCssComments("a{} /* var(--x, 1px) */ b{}").includes("--x"), "SELF-CHECK: a commented var() counts as a use");
assert.ok(!stripHtmlComments("<!-- var(--x, 1px) -->").includes("--x"), "SELF-CHECK: a commented var() in markup counts as a use");
assert.equal(stripCssComments("a{}\n/* p */\nb{}").split("\n").length, 3, "SELF-CHECK: the stripper eats lines — every citation would be wrong");

// ── NON-VACUITY ──────────────────────────────────────────────────────────────
assert.ok(scanned.length >= 50, `only ${scanned.length} sources scanned — app.css plus every web/ component was expected`);
assert.ok(declared.size >= 200, `only ${declared.size} tokens found declared — the declaration scan is broken and everything would read as phantom`);
// NOT A COUNT FLOOR ON `uses`, and that was a design error caught within the hour:
// the first version demanded >= 15 var() fallbacks, and W4-P paid seven of the debts
// while this file was being written, taking the tree to 11. A floor on a number the
// codebase is SUPPOSED to drive down turns paying the debt into a red gate. What has
// to be non-vacuous is the SCANNER, so that is what is pinned: it must resolve at
// least one live token through a fallback (both halves working at once).
assert.ok(uses.some((u) => declared.has(u.name)), "no var() fallback resolved to a LIVE token — the use scan or the declaration scan is broken");
assert.ok(declared.has("--cf-swatch"), "the Svelte-bound token --cf-swatch is not recognised as declared — the inline-binding branch is unexercised");

if (failures.length) {
  console.error(`\nFAIL phantom_token_ban_test (${failures.length}):\n`);
  for (const f of failures) console.error(`  · ${f}`);
  process.exit(1);
}
// A LEDGERED DEBT THAT PRINTS NOTHING IS A DEBT NOBODY PAYS. On every green run
// this names each frozen phantom, its site count, its fix and its owner.
/** Pure function. "1 token" / "4 tokens" — a debt report that says "1 tokens" reads
 *  as machine noise, and a debt report nobody reads is a debt nobody pays.
 *  @example plural(1, "token") // "1 token"
 *  @example plural(4, "site")  // "4 sites" */
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
console.log(`KNOWN DEBT — ${plural(Object.keys(PHANTOM_DEBT).length, "phantom token")} at ${plural(phantoms.length, "site")}, frozen so the count can only go down:`);
for (const [name, fix] of Object.entries(PHANTOM_DEBT)) {
  const sites = phantoms.filter((p) => p.name === name).map((p) => `${p.file}:${p.line}`);
  console.log(`  ${name}  (${sites.length}: ${sites.join(", ")})\n    ${fix}`);
}
console.log(`PASS phantom_token_ban_test — ${plural(uses.length, "var() fallback")} across ${plural(scanned.length, "source")}; ${phantoms.length} phantom, all ledgered.`);
