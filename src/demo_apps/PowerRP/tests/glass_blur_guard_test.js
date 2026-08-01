/**
 * GLASS-BLUR GUARD — a surface that paints the glass TINT must also BLUR.
 * Run: node src/demo_apps/PowerRP/tests/glass_blur_guard_test.js
 * Inventory (every glass-background rule the scanner sees, covered or not):
 *     node src/demo_apps/PowerRP/tests/glass_blur_guard_test.js --inventory
 *
 * THE RULE. The glass tokens (--a-glass-bg, --a-glass-bg-panel, --a-glass-tip-bg)
 * are INERT outside nocturne/daybreak — opaque, or `none` — so a surface painting
 * one is OPTING IN to the glass material, and the material is blur+tint TOGETHER,
 * never tint alone. A surface that reads a glass token without `backdrop-filter`
 * is see-through in the glass themes with nothing softening what shows through
 * (the FontPicker dropdown bug this file was written for: sharp canvas text
 * bleeding through a translucent popover).
 *
 * ── WHY IT WAS REWRITTEN: IT PASSED ON THE BROKEN CODE ───────────────────────
 * The defect it was written to catch recurred TWICE more, in the fourteen src/lib
 * dialogs and in ContextMenu, and this file was green through both. Two blind
 * spots, measured, not theorised:
 *
 *   (1) IT DID NOT FOLLOW CUSTOM-PROPERTY INDIRECTION. src/lib/Modal.svelte paints
 *       `background: var(--modal-bg)` (Modal.svelte:392) and app.css remaps
 *       `--modal-bg: var(--a-glass-bg)` (app.css:9460). The rule that paints the
 *       glass NEVER NAMES a glass token; the rule that names one declares no
 *       background. Matching on the literal token text therefore saw nothing on
 *       either side. A component that publishes an override contract and a host
 *       that fills it in is the NORMAL shape here — src/lib components must ship
 *       host-independent defaults — so the indirection is not an edge case, it is
 *       the architecture.
 *   (2) IT ONLY READ app.css. Every `.svelte` `<style>` block was outside the
 *       sweep: all 23 src/lib components, and web/ContextMenu.svelte, whose glass
 *       panel had no backdrop-filter at all until 6f8c533 — a defect its own
 *       comment now records, found by a human rather than by this file.
 *
 * The indirection is followed ONLY as far as a glass TOKEN, never to a literal
 * rgba() reached through some other token. That distinction is load-bearing: a
 * theme is free to give an ordinary token a translucent value, and chasing alpha
 * through every token in the file would demand a backdrop-filter on dozens of
 * surfaces that are not made of glass. The direct-value rgba() check stays, since
 * a rule that hardcodes its own translucency has opted in just as explicitly.
 *
 * ── HOW COVERAGE IS DECIDED ──────────────────────────────────────────────────
 * By the SUBJECT COMPOUND's class set — the classes on the last compound selector,
 * which is the element the rule actually paints. `background` and
 * `backdrop-filter` routinely arrive from two different rules (CSS composes per
 * property), in two different FILES, at two different specificities: Modal.svelte
 * writes `.modal-panel`, app.css writes `.modal-backdrop .modal-panel.modal-panel`.
 * Those are the same element and the previous leading-chain test could not say so.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, relative, basename } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolve(HERE, "..");
const LIB = resolve(APP, "../../lib");
const inventory = process.argv.includes("--inventory");

/** The translucent surface tokens. Painting one IS the opt-in to the material. */
const GLASS_TOKENS = ["--a-glass-bg-panel", "--a-glass-bg", "--a-glass-tip-bg"];

/** How far a `var()` chain is followed. Three is one more hop than the deepest
 *  chain in the tree today (background → --modal-bg → --a-glass-bg) and stops a
 *  cyclic declaration from spinning. */
const MAX_VAR_DEPTH = 3;

/**
 * Pure function. Strips CSS comments, PRESERVING LINE COUNT, so prose that merely
 * names a token is not read as a use and reported line numbers stay true.
 *
 * @param {string} css raw CSS source
 * @returns {string}
 *
 * @example stripCssComments("a { color: red; } /* b { x: 1; } *\/ c {}").includes("b {")
 * // false
 * @example stripCssComments("a{}\n/* p *\/\nb{}").split("\n").length
 * // 3 — line numbers survive
 */
export function stripCssComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
}

/**
 * Pure function. The CSS inside a `.svelte` file's `<style>` blocks, blanked
 * elsewhere so line numbers still address the original file.
 *
 * HTML COMMENTS ARE BLANKED FIRST, and that is not defensive tidiness — it is a
 * measured bug. web/ContextMenu.svelte's header comment reads "WHY A SCOPED
 * <style> IS STILL HERE", and the opening tag inside that prose matched first, so
 * the non-greedy body ran from the comment all the way to the real `</style>` and
 * swallowed the entire component markup as CSS. The reported selector came out as
 * `</div>\n\n<style>\n  .context-menu`. Same lesson as everywhere else in this
 * codebase's greps: comments are not code.
 *
 * @param {string} src Svelte component source
 * @returns {string} same length, only style-block contents preserved
 *
 * @example styleBlockCss("<div/>\n<style>\n.a { color: red; }\n</style>").trim()
 * // ".a { color: red; }"
 * @example styleBlockCss("<!-- <style> in prose -->\n<style>\n.a {}\n</style>").trim()
 * // ".a {}" — the commented tag does not open a block
 * @example styleBlockCss("<div/>").trim()
 * // "" — a component with no <style> contributes nothing
 */
export function styleBlockCss(src) {
  const blanked = src.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, " "));
  const out = blanked.replace(/[^\n]/g, " ").split("");
  for (const m of blanked.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)) {
    const start = m.index + m[0].indexOf(">") + 1;
    for (let i = 0; i < m[1].length; i++) out[start + i] = m[1][i];
  }
  return out.join("");
}

/**
 * Pure function. Splits comment-free CSS into flat {selector, body, line} rules,
 * recursing one level into @media/@supports wrappers. Braces are matched by
 * depth, so multi-line selectors and values never desync the scan.
 *
 * @param {string} css comment-free CSS source
 * @param {number} [base] line number the text starts on (1-based)
 * @returns {Array<{selector: string, body: string, line: number}>}
 *
 * @example extractRules("a { color: red; }")
 * // [{selector: "a", body: " color: red; ", line: 1}]
 * @example extractRules("a {}\n@media (x) { b { color: blue; } }")[1]
 * // {selector: "b", body: " color: blue; ", line: 2} — nested rules are reported too
 */
export function extractRules(css, base = 1) {
  const rules = [];
  const scan = (text, offset) => {
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
      const line = base + countLines(css.slice(0, offset + i + text.slice(i, open).search(/\S/)));
      if (!selector.startsWith("@") && !body.includes("{")) rules.push({ selector, body, line });
      else if (body.includes("{")) scan(body, offset + open + 1);
      i = j;
    }
  };
  scan(css, 0);
  return rules;
}

/**
 * Pure function. Newlines in `s` — the 0-based line offset of the text after it.
 *
 * @param {string} s
 * @returns {number}
 *
 * @example countLines("a\nb")
 * // 1
 * @example countLines("")
 * // 0
 */
export function countLines(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s[i] === "\n") n++;
  return n;
}

/**
 * Pure function. The class names on a selector's SUBJECT compound — the last
 * compound selector, which is the element the rule paints.
 *
 * Pseudo-class arguments are dropped first: `:has(.x)` names a DIFFERENT element
 * (the one being tested for), and treating `.x` as the subject would let an
 * unrelated rule vouch for coverage.
 *
 * @param {string} selector a CSS selector (one comma-branch)
 * @returns {Set<string>}
 *
 * @example [...subjectClasses(".modal-backdrop .modal-panel.modal-panel")]
 * // ["modal-panel"]
 * @example [...subjectClasses(".tt-tip.tt-tip:has(.storage-local-tip)")]
 * // ["tt-tip"]
 * @example [...subjectClasses("#weird")]
 * // []
 */
export function subjectClasses(selector) {
  const flat = selector.replace(/:[a-z-]+\([^()]*\)/gi, "");
  const last = flat.split(/[\s>+~]+/).filter(Boolean).pop() ?? "";
  return new Set([...last.matchAll(/\.([a-zA-Z0-9_-]+)/g)].map((m) => m[1]));
}

/**
 * Pure function. Every custom-property declaration in the parsed rules, as
 * name → all declared values.
 *
 * ALL of them, not the winning one. Which declaration wins is a cascade question
 * this scanner cannot answer without a DOM, and the conservative reading is the
 * right one here: if ANY theme or host override makes a token glass, a surface
 * reading that token can be glass, and must be able to blur.
 *
 * @param {Array<{body: string}>} rules
 * @returns {Map<string, string[]>}
 *
 * @example [...customProperties([{body: "--modal-bg: var(--a-glass-bg);"}]).keys()]
 * // ["--modal-bg"]
 * @example customProperties([{body: "--x: 1px;"}, {body: "--x: 2px;"}]).get("--x")
 * // ["1px", "2px"]
 */
export function customProperties(rules) {
  const map = new Map();
  for (const { body } of rules) {
    for (const m of body.matchAll(/(--[a-zA-Z0-9_-]+)\s*:\s*([^;]+);/g)) {
      const name = m[1];
      if (!map.has(name)) map.set(name, []);
      map.get(name).push(m[2].trim());
    }
  }
  return map;
}

/**
 * Pure function. Does `value` reach a glass token, directly or through at most
 * MAX_VAR_DEPTH custom-property hops?
 *
 * @param {string} value a declaration value
 * @param {Map<string, string[]>} props customProperties() output
 * @param {number} [depth]
 * @returns {boolean}
 *
 * @example reachesGlassToken("var(--a-glass-bg-panel)", new Map())
 * // true — named directly
 * @example reachesGlassToken("var(--modal-bg)", new Map([["--modal-bg", ["var(--a-glass-bg)"]]]))
 * // true — one hop, the Modal case this guard was blind to
 * @example reachesGlassToken("var(--control-bg)", new Map([["--control-bg", ["#1c1c24"]]]))
 * // false — an ordinary opaque token
 */
export function reachesGlassToken(value, props, depth = MAX_VAR_DEPTH) {
  if (GLASS_TOKENS.some((t) => value.includes(t))) return true;
  if (depth <= 0) return false;
  return [...value.matchAll(/var\(\s*(--[a-zA-Z0-9_-]+)/g)]
    .some((m) => (props.get(m[1]) ?? []).some((v) => reachesGlassToken(v, props, depth - 1)));
}

/**
 * Pure function. True when a background value hardcodes its own translucency:
 * a literal rgba() with alpha < 1, NOT inside a gradient.
 *
 * THE GRADIENT EXCLUSION IS NOT A CONVENIENCE. A gradient fading to transparent
 * is a COLOUR RAMP, not a surface tint — ColorPicker's saturation square is
 * `linear-gradient(to right, #fff, rgba(255,255,255,0))` and demanding a
 * backdrop-filter on it would be nonsense. The rule this file enforces is about
 * the material a surface is MADE OF.
 *
 * @param {string} bgValue raw value of a background/background-color declaration
 * @returns {boolean}
 *
 * @example isLiteralTranslucent("rgba(0, 0, 0, 0.4)")
 * // true
 * @example isLiteralTranslucent("linear-gradient(to right, #fff, rgba(255, 255, 255, 0))")
 * // false — a colour ramp, not a surface
 * @example isLiteralTranslucent("rgba(0, 0, 0, 1)")
 * // false — opaque
 */
export function isLiteralTranslucent(bgValue) {
  if (/gradient\(/.test(bgValue)) return false;
  const m = bgValue.match(/rgba\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*,\s*([\d.]+)\s*\)/);
  return Boolean(m && parseFloat(m[1]) < 1);
}

/**
 * Pure function. True when a background value opts a rule into the glass
 * material.
 *
 * TWO SIGNALS, AND THEY DO NOT APPLY EVERYWHERE. Reaching an `--a-glass-*` token
 * is the app's explicit opt-in and counts in any file. A hardcoded translucent
 * rgba() counts only in CSS THIS APP OWNS: `src/lib` components are shared with
 * other demo apps, ship host-independent defaults, and cannot read `--a-*` tokens
 * at all — MiniMap's `var(--minimap-bg, rgba(0,0,0,0.6))` and Thumbnail's badge
 * are library defaults, not PowerRP declaring a glass surface. Treating them as
 * glass produced six findings on a tree with no glass defect in it, which is how
 * a guard gets muted. Where the app DOES want one of those surfaces to be glass,
 * it says so with a token override, and that is caught by the first signal.
 *
 * @param {string} bgValue raw value of a background/background-color declaration
 * @param {Map<string, string[]>} props customProperties() output
 * @param {boolean} [appOwned] is this CSS the app's own chrome (app.css, web/*)?
 * @returns {boolean}
 *
 * @example isGlassBackground("var(--a-glass-bg-panel)", new Map())
 * // true
 * @example isGlassBackground("rgba(0, 0, 0, 0.4)", new Map(), true)
 * // true — the app hardcoding its own translucency has opted in
 * @example isGlassBackground("rgba(0, 0, 0, 0.4)", new Map(), false)
 * // false — a src/lib default, not this app's material
 * @example isGlassBackground("var(--control-bg)", new Map())
 * // false
 */
export function isGlassBackground(bgValue, props, appOwned = true) {
  return reachesGlassToken(bgValue, props) || (appOwned && isLiteralTranslucent(bgValue));
}

/**
 * Pure function. The glass background value this rule paints, or null.
 *
 * @param {{body: string, appOwned?: boolean}} rule
 * @param {Map<string, string[]>} props customProperties() output
 * @returns {string|null}
 *
 * @example glassBackgroundOf({body: "background: var(--a-glass-bg);"}, new Map())
 * // "var(--a-glass-bg)"
 * @example glassBackgroundOf({body: "color: red;"}, new Map())
 * // null
 */
export function glassBackgroundOf(rule, props) {
  const m = rule.body.match(/\bbackground(-color)?\s*:\s*([^;]+);/);
  if (!m) return null;
  const value = m[2].trim();
  return isGlassBackground(value, props, rule.appOwned !== false) ? value : null;
}

/**
 * Pure function. Every rule painting a glass background with no backdrop-filter
 * covering it — neither on itself nor on any rule whose SUBJECT class set
 * intersects its own.
 *
 * The intersection is across ALL files: a src/lib component's `.modal-panel` and
 * app.css's `.modal-backdrop .modal-panel.modal-panel` are one element.
 *
 * @param {Array<{selector: string, body: string, line: number, file: string, appOwned?: boolean}>} rules
 * @returns {Array<{selector: string, bgValue: string, line: number, file: string}>}
 *
 * @example uncoveredGlassRules([{selector: ".a", body: "background: var(--a-glass-bg-panel);", line: 1, file: "x.css"}])
 * // [{selector: ".a", bgValue: "var(--a-glass-bg-panel)", line: 1, file: "x.css"}]
 * @example uncoveredGlassRules([
 * //   {selector: ".a", body: "background: var(--a-glass-bg);", line: 1, file: "a.svelte"},
 * //   {selector: ".w .a.a", body: "backdrop-filter: blur(8px);", line: 9, file: "app.css"}]).length
 * // 0 — the two rules paint the same element, in two files
 */
export function uncoveredGlassRules(rules) {
  const props = customProperties(rules);
  const blurred = rules.filter((r) => /backdrop-filter\s*:/.test(r.body)).map((r) => subjectClasses(r.selector));
  const findings = [];
  for (const rule of rules) {
    const bgValue = glassBackgroundOf(rule, props);
    if (bgValue === null) continue;
    if (/backdrop-filter\s*:/.test(rule.body)) continue;
    const mine = subjectClasses(rule.selector);
    if (mine.size && blurred.some((other) => [...other].some((c) => mine.has(c)))) continue;
    findings.push({ selector: rule.selector, bgValue, line: rule.line, file: rule.file });
  }
  return findings;
}

/**
 * Query (reads the filesystem). Every stylesheet the app's chrome is painted
 * from: app.css, the app's own components, and the src/lib components it MOUNTS.
 *
 * The library is shared with other demo apps that are not bound by this app's
 * theme, so the sweep asks which lib files this app imports rather than policing
 * all of src/lib — tests/native_tooltip_ban_test.js's rule, for its reason.
 *
 * @returns {Array<{file: string, css: string}>}
 */
function stylesheets() {
  const out = [{ file: "web/app.css", appOwned: true, css: readFileSync(resolve(APP, "web/app.css"), "utf8") }];
  const webDir = resolve(APP, "web");
  const webFiles = readdirSync(webDir).filter((f) => f.endsWith(".svelte"));
  for (const f of webFiles) {
    out.push({ file: `web/${f}`, appOwned: true, css: styleBlockCss(readFileSync(resolve(webDir, f), "utf8")) });
  }
  const mounted = new Set();
  for (const f of webFiles.concat(readdirSync(webDir).filter((x) => x.endsWith(".js")))) {
    for (const m of readFileSync(resolve(webDir, f), "utf8").matchAll(/["'][^"']*\/lib\/([A-Za-z0-9_]+)\.svelte["']/g)) {
      mounted.add(`${m[1]}.svelte`);
    }
  }
  for (const f of [...mounted].sort()) {
    const p = resolve(LIB, f);
    if (!existsSync(p)) throw new Error(`glass_blur_guard: web/ imports ${f} but ${relative(APP, p)} does not exist`);
    out.push({ file: `src/lib/${f}`, appOwned: false, css: styleBlockCss(readFileSync(p, "utf8")) });
  }
  return out;
}

// ── doctests + self-check: the checker's own fixtures, before the sweep ───────
{
  assert.ok(!stripCssComments("a { color: red; } /* b { x: 1; } */ c {}").includes("b {"));
  assert.equal(stripCssComments("a{}\n/* p */\nb{}").split("\n").length, 3);
  assert.equal(styleBlockCss("<div/>\n<style>\n.a { color: red; }\n</style>").trim(), ".a { color: red; }");
  assert.equal(styleBlockCss("<!-- <style> in prose -->\n<style>\n.a {}\n</style>").trim(), ".a {}");
  assert.equal(styleBlockCss("<div/>").trim(), "");
  assert.equal(isLiteralTranslucent("rgba(0, 0, 0, 0.4)"), true);
  assert.equal(isLiteralTranslucent("linear-gradient(to right, #fff, rgba(255, 255, 255, 0))"), false);
  assert.equal(isLiteralTranslucent("rgba(0, 0, 0, 1)"), false);
  assert.equal(isGlassBackground("rgba(0, 0, 0, 0.4)", new Map(), true), true);
  assert.equal(isGlassBackground("rgba(0, 0, 0, 0.4)", new Map(), false), false);
  assert.equal(glassBackgroundOf({ body: "background: var(--a-glass-bg);" }, new Map()), "var(--a-glass-bg)");
  assert.equal(glassBackgroundOf({ body: "color: red;" }, new Map()), null);
  assert.deepEqual(extractRules("a { color: red; }"), [{ selector: "a", body: " color: red; ", line: 1 }]);
  assert.deepEqual(extractRules("a {}\n@media (x) { b { color: blue; } }")[1], { selector: "b", body: " color: blue; ", line: 2 });
  assert.equal(countLines("a\nb"), 1);
  assert.deepEqual([...subjectClasses(".modal-backdrop .modal-panel.modal-panel")], ["modal-panel"]);
  assert.deepEqual([...subjectClasses(".tt-tip.tt-tip:has(.storage-local-tip)")], ["tt-tip"]);
  assert.deepEqual([...subjectClasses("#weird")], []);
  assert.deepEqual([...customProperties([{ body: "--modal-bg: var(--a-glass-bg);" }]).keys()], ["--modal-bg"]);
  assert.deepEqual(customProperties([{ body: "--x: 1px;" }, { body: "--x: 2px;" }]).get("--x"), ["1px", "2px"]);
  assert.equal(reachesGlassToken("var(--a-glass-bg-panel)", new Map()), true);
  assert.equal(reachesGlassToken("var(--modal-bg)", new Map([["--modal-bg", ["var(--a-glass-bg)"]]])), true);
  assert.equal(reachesGlassToken("var(--control-bg)", new Map([["--control-bg", ["#1c1c24"]]])), false);
  assert.equal(isGlassBackground("var(--a-glass-bg-panel)", new Map()), true);
  assert.equal(isGlassBackground("rgba(0, 0, 0, 0.4)", new Map()), true);
  assert.equal(isGlassBackground("var(--control-bg)", new Map()), false);

  // THE GATE MUST BE ABLE TO FAIL — on the two shapes it was blind to, reproduced
  // from the real pre-fix text, not from a shape imagined for the occasion.
  //
  // (1) THE MODAL CASE, as it stood before app.css:9470. Modal.svelte's own rule
  //     paints an aliased token; app.css remaps that token to glass and (in this
  //     fixture) declares NO backdrop-filter. Every literal-token search over
  //     either file alone sees nothing.
  const modalBroken = [
    { selector: ".modal-panel", body: "--modal-bg: var(--control-bg, #1c1c24); background: var(--modal-bg);", line: 371, file: "src/lib/Modal.svelte" },
    { selector: ".modal-backdrop .modal-panel.modal-panel", body: "--modal-bg: var(--a-glass-bg); --modal-radius: 4px;", line: 9459, file: "web/app.css" },
  ];
  assert.equal(uncoveredGlassRules(modalBroken).length, 1,
    "SELF-CHECK: the indirection case passes — this is exactly the defect the guard was green through");
  assert.equal(uncoveredGlassRules(modalBroken)[0].file, "src/lib/Modal.svelte");
  // (2) …and it must go quiet once the real fix is applied, or it blocks the cure.
  const modalFixed = [modalBroken[0], { ...modalBroken[1], body: `${modalBroken[1].body} backdrop-filter: var(--a-glass-blur);` }];
  assert.deepEqual(uncoveredGlassRules(modalFixed), [],
    "SELF-CHECK: the guard still fails after the real fix — it would block the change it demands");
  // (3) A .svelte <style> block must be reachable at all: ContextMenu's panel is
  //     glass and lives in a component, which the old sweep never opened.
  const inComponent = extractRules(stripCssComments(styleBlockCss(
    "<div/>\n<style>\n.context-menu { background: var(--a-glass-bg-panel); }\n</style>")))
    .map((r) => ({ ...r, file: "web/ContextMenu.svelte" }));
  assert.equal(uncoveredGlassRules(inComponent).length, 1, "SELF-CHECK: a glass rule inside a <style> block is invisible");
  // (4) Cross-file coverage must be granted, or every component would be flagged.
  assert.deepEqual(uncoveredGlassRules([
    { selector: ".a", body: "background: var(--a-glass-bg);", line: 1, file: "a.svelte" },
    { selector: ".w .a.a", body: "backdrop-filter: blur(8px);", line: 9, file: "web/app.css" },
  ]), [], "SELF-CHECK: a backdrop-filter in another FILE does not count — Modal is styled that way on purpose");
  // (5) A pseudo-class ARGUMENT must not be mistaken for the subject.
  assert.deepEqual([...subjectClasses(".x:has(.y)")], ["x"]);
  console.log("  ok  doctests + self-check");
}

// ── the sweep ────────────────────────────────────────────────────────────────
const sheets = stylesheets();
const rules = sheets.flatMap(({ file, appOwned, css }) =>
  extractRules(stripCssComments(css)).map((r) => ({ ...r, file, appOwned })));
const props = customProperties(rules);
const glassRules = rules.filter((r) => glassBackgroundOf(r, props) !== null);
const uncovered = uncoveredGlassRules(rules);

if (inventory) {
  for (const r of glassRules) {
    const bad = uncovered.some((u) => u.file === r.file && u.line === r.line);
    const how = reachesGlassToken(glassBackgroundOf(r, props), props, 0) ? "token   " : "indirect";
    console.log(`${bad ? "UNCOVERED" : "covered  "} ${how}  ${r.file}:${r.line}  ${r.selector}`);
  }
  console.log(`\n${glassRules.length} glass-background rules across ${sheets.length} stylesheets`);
  process.exit(0);
}

if (uncovered.length > 0) {
  console.error("Rules with a glass background but NO backdrop-filter coverage:");
  for (const f of uncovered) console.error(`  ${f.file}:${f.line}  ${f.selector}  background: ${f.bgValue}`);
  console.error("\nThe glass material is blur+tint together. Add `backdrop-filter: var(--a-glass-blur)` and its");
  console.error("-webkit- twin, on this rule or on one that shares its subject class.");
}
assert.equal(uncovered.length, 0, `${uncovered.length} glass-background rule(s) missing backdrop-filter — see list above`);

// ── NON-VACUITY ──────────────────────────────────────────────────────────────
// A sweep that opened the wrong files, or an indirection resolver that resolved
// nothing, passes trivially. Pin that the corpus and both mechanisms are live.
assert.ok(sheets.length >= 60, `only ${sheets.length} stylesheets swept — app.css plus every web/ and mounted lib component was expected`);
assert.ok(sheets.some((s) => s.file.startsWith("src/lib/") && s.css.includes("{")), "no src/lib component contributed any CSS — the mounted-component scan is broken");
assert.ok(glassRules.length >= 8, `only ${glassRules.length} glass-background rules found — the matcher is not matching`);
assert.ok(glassRules.some((r) => !GLASS_TOKENS.some((t) => r.body.includes(t))),
  "every glass rule names a token DIRECTLY — the indirection resolver is unexercised, so blind spot (1) is untested against the real tree");

console.log(`  ok  ${glassRules.length} glass-background rules across ${sheets.length} stylesheets, all with backdrop-filter coverage (${rules.length} rules scanned)`);
console.log("PASS glass_blur_guard_test.js");
