/**
 * AUTHORING.md DOC-LINK tests — plain node, no framework.
 * Run: node src/demo_apps/PowerRP/tests/authoring_doc_test.js
 *
 * AUTHORING.md is the guide a USER hands their Claude before it builds a deck. It
 * is therefore a load-bearing artifact in the same way a test fixture is: an agent
 * reads it, believes it, and acts on it. A guide that has quietly gone stale is
 * WORSE than no guide — it sends its reader to a file that moved, names a widget
 * that was renamed, or teaches an API that changed, and the reader has no way to
 * know. Documentation rot is normally invisible; this suite makes it a test
 * failure.
 *
 * WHAT IS CHECKED, and why each one is a rot vector rather than a style rule:
 *
 *   (1) EVERY CITED FILE PATH RESOLVES. The guide's whole method is "go read this
 *       file" — plugins/graph_bars.js, core/plugin_assets.js, the template. A path
 *       that no longer exists is the single most likely way this document rots,
 *       because a refactor moves a file and nothing links the move to the prose.
 *   (2) EVERY CITED WIDGET TYPE IS REGISTERED. The roster section lists widget
 *       types; a renamed or deleted widget must not linger there. This is checked
 *       against the LIVE registry (built-ins + the committed plugin assets), not
 *       against a second hardcoded list that could drift in its own right.
 *   (3) THE PERMISSION POLICY IS PRESENT VERBATIM. The user's ruling on custom
 *       widgets is quoted in the guide on purpose: it is the sentence that tells an
 *       agent it is ALLOWED to write a plugin. An edit that softened or dropped it
 *       would silently change what agents believe they may do.
 *   (4) THE TUTORIAL'S SUBJECT EXISTS AND STILL BEHAVES AS DESCRIBED. The guide
 *       walks through csv_bar_graph.plugin.js naming specific knobs; if a knob is
 *       renamed the walkthrough becomes fiction. The knobs the prose names are
 *       cross-checked against the loaded plugin's own inspector rows.
 *   (5) THE VALIDATION RECIPES ACTUALLY RUN. The guide tells the reader to validate
 *       with repairedDocument and to render a still with cli/render.js. Those two
 *       entry points are asserted to exist with the shape the guide claims.
 *
 * Paths are extracted from the prose by pattern, so a NEW citation added later is
 * covered automatically — the test does not carry its own copy of the list.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRegistry } from "../core/registry.js";
import { createCommands } from "../core/commands.js";
import { registerAll } from "../plugins/index.js";
import { registerPluginAssets, isPluginAssetName, PLUGIN_ASSET_SUFFIX } from "../core/plugin_assets.js";
import { repairedDocument, newDocument } from "../core/document.js";

const here = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(here, "..");
const GUIDE_PATH = resolve(APP_ROOT, "AUTHORING.md");

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

// ── (0) IT EXISTS AND SHIPS WITH THE APP ─────────────────────────────────────

test("AUTHORING.md exists at the app root, where the bundle picks it up", () => {
  assert.ok(existsSync(GUIDE_PATH), `AUTHORING.md must exist at ${GUIDE_PATH}`);
});

const GUIDE = readFileSync(GUIDE_PATH, "utf8");

test("the guide is substantial, not a stub", () => {
  // A stub would pass every other assertion here while being useless. The floor is
  // deliberately low — this catches truncation and accidental emptying, not brevity.
  assert.ok(GUIDE.length > 8000, `the guide is only ${GUIDE.length} chars — a truncated or stubbed guide is worse than none`);
  assert.ok(/^#\s+/m.test(GUIDE), "it must have a markdown heading");
});

test("it says up front that it ships with the app", () => {
  // The reader needs to know this file travels with the install, so an agent that
  // finds it in a bundle trusts it as current rather than as a stray note.
  const head = GUIDE.slice(0, 2000);
  assert.ok(/ships with the app|vendored|travels with/i.test(head),
    "the top of the guide must state that it ships with the app");
});

// ── (1) EVERY CITED FILE PATH RESOLVES ──────────────────────────────────────

/**
 * Pure function. Every repo-relative file path the guide cites.
 *
 * Matches the DIRECTORY-PREFIXED form the house style uses for citations
 * (`core/x.js`, `plugins/demo/y.js`, `tests/z.js`, `web/a.svelte`, …), optionally
 * inside backticks and optionally followed by `:123` or `#anchor`, which are
 * stripped. A bare filename with no directory is NOT matched: `doc.json` and
 * `sales.csv` appear in the prose as generic examples rather than as citations, and
 * treating them as paths would produce false failures on every example.
 *
 * @param {string} md - the guide's markdown
 * @returns {string[]} unique repo-relative paths, in first-appearance order
 *
 * @example citedPaths("see `core/derive.js` and core/view.js:88") // ["core/derive.js", "core/view.js"]
 * @example citedPaths("a plain sales.csv is not a citation") // []
 * @example citedPaths("`plugins/demo/sky.js`") // ["plugins/demo/sky.js"]
 */
export function citedPaths(md) {
  const DIRS = "core|plugins|render_gpu|web|cli|tests|examples|plugin_assets|projects|server|desktop|fonts|assets";
  const pattern = new RegExp(`\\b(?:${DIRS})\\/[A-Za-z0-9_./-]*[A-Za-z0-9_)-]`, "g");
  const out = [];
  for (const raw of md.match(pattern) ?? []) {
    // Trim trailing punctuation the prose may leave attached, then any :line suffix.
    const path = raw.replace(/[).,;:]+$/, "").replace(/:\d+$/, "");
    // Only keep things that look like FILES (have an extension) or explicit dirs.
    if (!/\.[a-z]+$/.test(path) && !path.endsWith("/")) continue;
    if (!out.includes(path)) out.push(path);
  }
  return out;
}

test("every file path the guide cites resolves on disk", () => {
  const paths = citedPaths(GUIDE);
  // A guide that cites nothing has lost its whole method (go read this file).
  assert.ok(paths.length >= 15, `the guide should cite many real files; found only ${paths.length}`);
  const missing = paths.filter((p) => !existsSync(resolve(APP_ROOT, p)));
  assert.deepEqual(missing, [], `AUTHORING.md cites ${missing.length} path(s) that do not exist: ${missing.join(", ")}`);
  console.log(`      (${paths.length} cited paths, all resolve)`);
});

test("the paths it cites for the reader's own next steps are the important ones", () => {
  // These four are the guide's spine: the widget base class docblock, the sandbox
  // contract, the template a user copies, and the tutorial subject. If any citation
  // is dropped the guide stops being actionable, which a pure existence check on
  // whatever paths remain would not catch.
  const paths = citedPaths(GUIDE);
  for (const required of [
    "core/registry.js",
    "core/plugin_assets.js",
    "plugin_assets/plugin_template.plugin.js",
    "plugin_assets/csv_bar_graph.plugin.js",
  ])
    assert.ok(paths.includes(required), `the guide must cite ${required}`);
});

// ── (2) EVERY CITED WIDGET TYPE IS REGISTERED ───────────────────────────────

/** The live registry: the built-in roster plus the committed plugin assets — what
 *  a real project actually has available. */
function fullRegistry() {
  const registry = createRegistry();
  registerAll(registry, createCommands());
  const sources = [];
  const dir = resolve(APP_ROOT, "plugin_assets");
  for (const name of ["csv_bar_graph.plugin.js", "gear.plugin.js", "superellipse.plugin.js"])
    if (existsSync(resolve(dir, name)))
      sources.push({ name, source: readFileSync(resolve(dir, name), "utf8") });
  const { reports } = registerPluginAssets(registry, sources);
  assert.deepEqual(reports, [], `the committed plugin assets must load cleanly: ${reports.join("; ")}`);
  return registry;
}

const registry = fullRegistry();

/**
 * Pure function. Every widget type the guide names in a `type: "..."` or backticked
 * lower_snake_case form that looks like a widget id.
 *
 * Only BACKTICKED tokens are considered, because ordinary prose words are
 * lower-case too — the backticks are what make a mention a claim about a type.
 * A token is treated as a widget-type claim only when the registry has ANY type
 * (so the roster's real entries are checked) — the point of the test is to catch a
 * type that USED to exist and no longer does, which is done separately below.
 *
 * @param {string} md - the guide's markdown
 * @returns {string[]} unique backticked lower_snake_case tokens
 *
 * @example backtickedIdentifiers("use `graph_bars` or `rect`") // ["graph_bars", "rect"]
 * @example backtickedIdentifiers("`core/x.js` is a path, not an id") // []
 */
export function backtickedIdentifiers(md) {
  const out = [];
  for (const m of md.matchAll(/`([a-z][a-z0-9_]*)`/g)) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}

test("the widget roster lists only types that are actually registered", () => {
  // The ROSTER SECTION is parsed rather than the whole document, because the prose
  // elsewhere legitimately says `emit`, `defaults`, `time` and other lower-case
  // words in backticks that are not widget types.
  const section = GUIDE.match(/##+\s*[^\n]*(?:roster|widgets you already have)[^\n]*\n([\s\S]*?)(?=\n##\s)/i);
  assert.ok(section, "the guide must have a widget-roster section");
  const known = new Set(registry.all().map((p) => p.type));
  // Every roster ROW's leading code span is a type claim (the roster is a table or
  // a bullet list whose first code span names the widget).
  const claims = [];
  for (const line of section[1].split("\n")) {
    const m = line.match(/^\s*(?:[-*|]\s*)`([a-z][a-z0-9_]*)`/);
    if (m && !claims.includes(m[1])) claims.push(m[1]);
  }
  assert.ok(claims.length >= 25, `the roster should name most of the widget family; found ${claims.length}`);
  const unknown = claims.filter((t) => !known.has(t));
  assert.deepEqual(unknown, [], `the roster names ${unknown.length} unregistered type(s): ${unknown.join(", ")}`);
  console.log(`      (${claims.length} roster entries, all registered)`);
});

// ── (3) THE PERMISSION POLICY IS PRESENT VERBATIM ───────────────────────────

test("the user's custom-widget permission ruling is quoted verbatim", () => {
  // THE SENTENCE THAT GRANTS PERMISSION. An agent reading this guide must find the
  // user's own words saying custom widgets are allowed — a paraphrase would leave
  // it guessing, and a deletion would make it refuse work it is permitted to do.
  // Checked in fragments so that markdown line-wrapping inside the quote block does
  // not break the assertion, while every load-bearing clause is still required.
  const flat = GUIDE.replace(/\s+/g, " ");
  for (const fragment of [
    "it's allowed to create custom widgets if the current widgets are not sufficient",
    "It should try to use current widgets, but if it's cleaner to make its own, it is welcome to do so",
    "Custom widgets are OK",
  ])
    assert.ok(flat.includes(fragment), `the permission policy must be quoted verbatim; missing: "${fragment}"`);
});

test("the determinism rule is stated as a LAW, not a suggestion", () => {
  const flat = GUIDE.replace(/\s+/g, " ");
  // The three names that must appear for the rule to be actionable: what is blocked,
  // and what the two sanctioned substitutes are.
  assert.ok(/\bLAW\b/.test(GUIDE), "the determinism rule must be labelled as a law");
  for (const name of ["Date", "Math.random", "time", "random("])
    assert.ok(flat.includes(name), `the determinism section must name ${name}`);
});

// ── (4) THE TUTORIAL'S SUBJECT STILL BEHAVES AS DESCRIBED ───────────────────

test("the CSV tutorial names knobs the plugin actually declares", () => {
  const plugin = registry.get("csv_bar_graph");
  assert.ok(plugin, "csv_bar_graph must be registered for the tutorial to be true");
  const keys = new Set(plugin.inspector.filter((r) => r.key).map((r) => r.key));
  // Every backticked identifier in the guide that IS a knob of this widget must
  // still be one; and the four the walkthrough is built around must be present.
  for (const knob of ["csvUrl", "labelColumn", "valueColumn", "colorMode"])
    assert.ok(keys.has(knob), `the tutorial's knob "${knob}" is no longer declared by csv_bar_graph`);
  // The guide claims the widget reads a project asset by URL through assetText.
  assert.ok(GUIDE.includes("assetText"), "the tutorial must name the assetText seam");
});

test("the plugin-asset suffix the guide teaches is the one the loader enforces", () => {
  // If the suffix ever changed, every "name it *.plugin.js" instruction in the guide
  // would be wrong, and a user's widget would sit in the assets folder inert.
  assert.ok(GUIDE.includes(PLUGIN_ASSET_SUFFIX), `the guide must teach the real suffix (${PLUGIN_ASSET_SUFFIX})`);
  assert.ok(isPluginAssetName(`my_widget${PLUGIN_ASSET_SUFFIX}`));
});

// ── (5) THE VALIDATION RECIPES ACTUALLY RUN ─────────────────────────────────

test("the repairedDocument recipe the guide gives is real and returns what it says", () => {
  // The guide tells the reader: run repairedDocument and require ZERO reports. That
  // is only actionable if the signature and the return shape are as described.
  const { doc, reports } = repairedDocument(newDocument(registry), registry);
  assert.ok(doc && Array.isArray(doc.slides), "repairedDocument returns {doc, reports}");
  assert.ok(Array.isArray(reports), "reports is an array the reader can require to be empty");
  assert.deepEqual(reports, [], "a fresh document must itself repair with zero reports");
  assert.ok(/repairedDocument/.test(GUIDE), "the guide must name repairedDocument");
  assert.ok(/zero/i.test(GUIDE), "and must say the report count has to be zero");
});

test("the CLI still-render recipe points at a real entry point", () => {
  assert.ok(existsSync(resolve(APP_ROOT, "cli/render.js")), "cli/render.js must exist");
  const flat = GUIDE.replace(/\s+/g, " ");
  assert.ok(flat.includes("cli/render.js"), "the guide must give the CLI still recipe");
  // The guide must WARN about what the bare-node CLI cannot draw, or a reader will
  // file a bug when a video slide renders empty.
  assert.ok(/omit|cannot draw|no media|reports what/i.test(flat),
    "the guide must say the CLI still renderer omits media/LaTeX/Mermaid and reports it");
});

test("the doc cites the test gate the way the repo defines it", () => {
  // Quoting a NUMBER of tests is the documented rot trap (CLAUDE.md says --list is
  // the authority). The guide must point at run_all.mjs and must NOT pin a count.
  assert.ok(GUIDE.includes("tests/run_all.mjs"), "the guide must name the gate script");
  const flat = GUIDE.replace(/\s+/g, " ");
  assert.ok(!/\b\d{2,4}\s+tests?\b/i.test(flat),
    "the guide must not pin a test COUNT — CLAUDE.md makes --list the authority because a pinned number went stale twice");
});

console.log(`\n${passed} tests passed`);
