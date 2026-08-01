/**
 * glass_structure_test.js — A GLASS THEME IS A MATERIAL, NOT A HUE.
 *
 * WHY THIS EXISTS, and it is a user report rather than a theory. Three glass
 * families were shipped after Nocturne — Verdigris, Cranberry, Obsidian/Moonstone
 * — each with a researched material citation in its `app.css` header, and every
 * one of them set the STRUCTURAL levers to Nocturne's numbers verbatim:
 *
 *     --a-glass-blur: blur(18px) saturate(140%)   identical in all four
 *     --a-radius-floating: 10px                   identical in all four
 *     --a-palette-shadow: 0 16px 48px …           same geometry, colour only
 *
 * The user's verdict: *"they're all just changes in color. They're not
 * interesting. They don't have any different shapes or different widths or
 * different fonts."* He was right, and it was measurable the whole time — which
 * is what makes it a gate rather than a taste argument.
 *
 * THE RULE THIS ENFORCES. Two glass families must differ in all THREE of the
 * cue groups Nocturne's own block names as the physics of a floating pane
 * ("The elevation reads from the blur, the rim and the shadow"), plus the shape
 * that carries them:
 *
 *     SHAPE   --a-radius-floating, --a-glass-tip-radius
 *     MATTER  --a-glass-blur           (the filter chain: radius AND functions)
 *     WEIGHT  --a-palette-shadow       (GEOMETRY only — the colour is stripped,
 *                                       because "same throw, different colour"
 *                                       IS the defect being banned)
 *
 * Requiring all three, rather than "differ somewhere", is deliberate: a family
 * that re-tints one lever and copies the other two has copied the object and
 * repainted it, which is exactly what happened. Poles of the SAME family are
 * exempt — Nocturne/Daybreak are one material at two times of day and are
 * supposed to share geometry.
 *
 * The family map is DERIVED from `web/app.svelte.js`'s THEME_FAMILIES literal,
 * never restated here: a hand-kept copy of another module's shape is this
 * codebase's worst recurring defect (convention ledger C-8).
 *
 * PRECEDENT: `tests/square_chrome_test.js` — same shape (one rule stated in
 * app.css prose, enforced by parsing app.css, comments stripped first, self-test
 * fixtures proving the checker can actually fail).
 *
 * Run:  node tests/glass_structure_test.js
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CSS = join(HERE, "..", "web", "app.css");
const APP_JS = join(HERE, "..", "web", "app.svelte.js");

/** The cue groups, and the tokens that carry each. Order is the order a reader
 *  meets them in a theme block. */
const GROUPS = {
  shape: ["--a-radius-floating", "--a-glass-tip-radius"],
  matter: ["--a-glass-blur"],
  weight: ["--a-palette-shadow"],
};

/**
 * Pure function. Blanks CSS comment bodies, preserving line count so any line
 * number derived afterwards still points at the real line.
 *
 * COMMENTS ARE NOT CODE. This file's own subject matter makes the point: the
 * Obsidian block's prose contains the literal text `--a-radius-floating: 0`
 * inside a sentence explaining why, and a comment-blind parse would read that
 * sentence as a declaration. Getting this wrong breaks a grep gate in BOTH
 * directions and has done so twice in this repo (convention ledger C-14).
 *
 * THIS IS THE SIXTH COPY of this helper in `tests/` and that is a known defect,
 * not an oversight — see the hand-back in `.frenzy/round6/W4-P.md`. The five
 * existing ones (`square_chrome_test.js`, `orphan_class_test.js`,
 * `one_ranking_ban_test.js`, `popover_reinvention_ban_test.js`,
 * `native_tooltip_ban_test.js`, `equation_lock_test.js`) have DIVERGED — some
 * strip HTML comments, some strip JS line comments, some do not preserve line
 * count, and the two that export it do so from files that run assertions at
 * import scope, so importing one would run another gate as a side effect.
 * Consolidating them is a cross-owner change and is handed back rather than
 * done here.
 *
 * @param {string} css
 * @returns {string} same text, comment bodies blanked, LINE COUNT PRESERVED
 *
 * @example stripCssComments("a { /* --x: 1px; *\/ }").includes("--x") // false
 * @example stripCssComments("a\n/* x *\/\nb").split("\n").length // 3
 */
function stripCssComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
}

/**
 * Pure function. Every `:root` / `:root[data-theme="…"]` block in a stylesheet,
 * as {themeId: {token: value}}. The bare `:root` block is keyed `""` — it is the
 * defaults every theme inherits, not a theme.
 *
 * @param {string} css - stylesheet text, comments already stripped
 * @returns {Object<string, Object<string, string>>}
 *
 * @example themeBlocks(':root { --bg: #111; }')[""]["--bg"] // "#111"
 * @example themeBlocks(':root[data-theme="x"] { --bg: #eee; }').x["--bg"] // "#eee"
 */
function themeBlocks(css) {
  const out = {};
  const block = /:root(?:\[data-theme="([a-z0-9-]+)"\])?\s*\{([^}]*)\}/g;
  for (const [, id, body] of css.matchAll(block)) {
    const decls = (out[id ?? ""] ??= {});
    for (const [, token, value] of body.matchAll(/^[ \t]*(--[a-z0-9-]+)\s*:\s*([^;]+);/gm)) {
      decls[token] = value.trim();
    }
  }
  return out;
}

/**
 * Pure function. Theme id -> family id, parsed out of a THEME_FAMILIES literal.
 * Derived from the source text rather than restated, so the two cannot drift.
 *
 * @param {string} src - web/app.svelte.js text
 * @returns {Object<string, string>}
 *
 * @example themeFamilies('{ id: "ember", title: "E", dark: "ember", light: "ember-light" },')
 * // { ember: "ember", "ember-light": "ember" }
 */
function themeFamilies(src) {
  const out = {};
  const entry = /\{\s*id:\s*"([a-z0-9-]+)",\s*title:[^,]+,\s*dark:\s*"([a-z0-9-]+)",\s*light:\s*"([a-z0-9-]+)"\s*\}/g;
  for (const [, family, dark, light] of src.matchAll(entry)) {
    out[dark] = family;
    out[light] = family;
  }
  return out;
}

/**
 * Pure function. A box-shadow with every colour removed, leaving the GEOMETRY.
 * Two panes that throw the same shadow in different colours are the same pane.
 *
 * @param {string} shadow - a box-shadow value
 * @returns {string} the lengths and keywords, whitespace-normalised
 *
 * @example shadowGeometry("0 16px 48px rgba(0, 0, 0, 0.66)") // "0 16px 48px"
 * @example shadowGeometry("0 16px 44px rgba(38, 55, 84, 0.26)") // "0 16px 44px"
 * @example shadowGeometry("0 2px 8px #123") // "0 2px 8px"
 */
function shadowGeometry(shadow) {
  return shadow
    .replace(/(?:rgba?|hsla?|color-mix)\([^)]*\)/g, "")
    .replace(/#[0-9a-f]{3,8}\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Pure function. The structural fingerprint of one theme, per cue group, with a
 * theme's own declaration falling back to the :root default it inherits.
 *
 * @param {Object<string,string>} theme - that theme's declarations
 * @param {Object<string,string>} base - the :root declarations
 * @returns {Object<string, string>} one joined string per GROUPS key
 *
 * @example fingerprint({ "--a-radius-floating": "16px", "--a-glass-tip-radius": "9px",
 *   "--a-glass-blur": "blur(34px) saturate(180%)",
 *   "--a-palette-shadow": "0 26px 64px rgba(0,0,0,0.62)" }, {})
 * // { shape: "16px|9px", matter: "blur(34px) saturate(180%)", weight: "0 26px 64px" }
 */
function fingerprint(theme, base) {
  const read = (t) => (theme[t] ?? base[t] ?? "").trim();
  return {
    shape: GROUPS.shape.map(read).join("|"),
    matter: read("--a-glass-blur"),
    weight: shadowGeometry(read("--a-palette-shadow")),
  };
}

// ── The gate ────────────────────────────────────────────────────────────────

const css = stripCssComments(readFileSync(CSS, "utf8"));
const blocks = themeBlocks(css);
const base = blocks[""] ?? {};
const families = themeFamilies(readFileSync(APP_JS, "utf8"));

// REFUSE TO PASS VACUOUSLY. Every number below is a floor the shipped app
// already clears; a parse that silently returned nothing would otherwise report
// a green with zero comparisons made — the failure mode square_chrome_test.js
// guards against the same way.
const MIN_THEMES = 20, MIN_GLASS_FAMILIES = 4;
if (Object.keys(blocks).length < MIN_THEMES) {
  throw new Error(`glass_structure: parsed only ${Object.keys(blocks).length} :root blocks from app.css — the parser is broken, not the stylesheet`);
}
if (Object.keys(families).length < MIN_THEMES) {
  throw new Error(`glass_structure: parsed only ${Object.keys(families).length} themes from THEME_FAMILIES — the parser is broken`);
}

/** A theme is GLASS when it says so, by pulling --a-glass-blur off its `none`
 *  default. Same test the app itself applies (app.css's tooltip note: "A theme
 *  is glass when it says so, not when a heuristic infers it"). */
const glass = Object.keys(blocks)
  .filter((id) => id && (blocks[id]["--a-glass-blur"] ?? "none") !== "none")
  .sort();

const unfamilied = glass.filter((id) => !families[id]);
if (unfamilied.length) {
  throw new Error(`glass_structure: glass themes absent from THEME_FAMILIES: ${unfamilied.join(", ")}`);
}

const glassFamilies = new Set(glass.map((id) => families[id]));
if (glassFamilies.size < MIN_GLASS_FAMILIES) {
  throw new Error(`glass_structure: found only ${glassFamilies.size} glass families (${[...glassFamilies].join(", ")}) — expected at least ${MIN_GLASS_FAMILIES}`);
}

const prints = Object.fromEntries(glass.map((id) => [id, fingerprint(blocks[id], base)]));
const failures = [];
for (let i = 0; i < glass.length; i++) {
  for (let j = i + 1; j < glass.length; j++) {
    const [a, b] = [glass[i], glass[j]];
    if (families[a] === families[b]) continue; // one material, two times of day
    const same = Object.keys(GROUPS).filter((g) => prints[a][g] === prints[b][g]);
    if (same.length) {
      failures.push(
        `${a} vs ${b}: identical ${same.join(" + ")} — ` +
        same.map((g) => `${g}="${prints[a][g]}"`).join(", ")
      );
    }
  }
}

// The rim-width lever must stay INERT by default: every lever in app.css's
// MATERIAL LEVERS section promises to be a no-op until a theme pulls it, and
// a default that is anything but the hairline would silently re-edge every
// floating surface in all 46 themes.
const RIM_W_DEFAULT = "var(--a-hairline)";
if (base["--a-glass-rim-w"] !== RIM_W_DEFAULT) {
  failures.push(`:root --a-glass-rim-w is "${base["--a-glass-rim-w"]}", must be ${RIM_W_DEFAULT} — the lever has to be a no-op until a theme pulls it`);
}

// ── Self-test: the checker can actually fail. A gate that cannot go red is not
// a gate, and two were found in this repo that could not.
const FIXTURE_BASE = { "--a-glass-blur": "none" };
const nocturneish = { "--a-radius-floating": "10px", "--a-glass-tip-radius": "6px", "--a-glass-blur": "blur(18px) saturate(140%)", "--a-palette-shadow": "0 16px 48px rgba(0,0,0,0.66)" };
const recoloured = { ...nocturneish, "--a-palette-shadow": "0 16px 48px rgba(20,55,46,0.66)" };
const fpA = fingerprint(nocturneish, FIXTURE_BASE), fpB = fingerprint(recoloured, FIXTURE_BASE);
const selfSame = Object.keys(GROUPS).filter((g) => fpA[g] === fpB[g]);
if (selfSame.length !== 3) {
  throw new Error(`glass_structure self-test: a pure RECOLOUR of Nocturne must collide on all three groups, collided on ${selfSame.join(",") || "none"}`);
}
const reshaped = { ...nocturneish, "--a-radius-floating": "3px", "--a-glass-blur": "blur(6px) saturate(80%)", "--a-palette-shadow": "0 2px 8px rgba(0,0,0,0.55)" };
const fpC = fingerprint(reshaped, FIXTURE_BASE);
const stillSame = Object.keys(GROUPS).filter((g) => fpA[g] === fpC[g]);
if (stillSame.length !== 0) {
  throw new Error(`glass_structure self-test: a materially different theme must collide on nothing, collided on ${stillSame.join(",")}`);
}

if (failures.length) {
  console.error("GLASS STRUCTURE — a glass family is a MATERIAL, not a hue:");
  for (const f of failures) console.error(`  ${f}`);
  console.error(`\n${failures.length} cross-family collision(s). Two families must differ in SHAPE, MATTER and WEIGHT — see this file's header.`);
  process.exit(1);
}

console.log(`glass_structure: OK — ${glass.length} glass themes in ${glassFamilies.size} families, all cross-family pairs differ in shape, matter and weight`);
for (const id of glass) {
  console.log(`  ${id.padEnd(18)} shape=${prints[id].shape.padEnd(11)} matter=${prints[id].matter.padEnd(42)} weight=${prints[id].weight}`);
}
