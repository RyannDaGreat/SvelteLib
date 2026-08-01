/**
 * EVERY NAMED IMPORT OF A LOCAL MODULE MUST NAME SOMETHING THAT MODULE EXPORTS.
 *
 * `<app>/CLAUDE.md` states of this exact defect: **"the intermediate state is
 * caught by nothing we have."** This is that gate. Its whole justification is one
 * measured sentence from the same passage — a missing named import is SILENT:
 *
 *   > `web/CanvasView.svelte` imported `itemGeometryPairs` after it had been
 *   > un-exported from `web/canvas/dragKinds.js`; the PowerRP build ran to
 *   > completion in 51.6 s, exit 0, with ZERO hits for `not exported` /
 *   > `Missing export` in its output. Rollup binds the name to `undefined` and
 *   > ships it, so the failure surfaces as `X is not a function` in the user's
 *   > hands, on a green build.
 *
 * **A green build is not evidence that the module graph is sound.** Nor is a
 * green test run: a suite that never imports the broken seam passes, and the
 * browser probes fail with a Vite overlay that reads like an app regression.
 *
 * ── WHY NOW: FOUR INCIDENTS, ONE ROUND ──────────────────────────────────────
 * This is not a hypothetical defect class and it is not one agent's mistake.
 *   1. `itemGeometryPairs` — the measurement quoted above.
 *   2. `truncate` moved to one home; the receiver re-imported it from the OLD
 *      home, which no longer exported it. Ledger C-9. Every suite transitively
 *      touching that path died at once.
 *   3. `77aaf50` — HEAD imported `web/canvas/equationBinding.js`, which HEAD did
 *      not contain. Nothing booted for anybody.
 *   4. `LABEL_FRAC_BOUNDS` — `web/LabelDivider.svelte` imported it from
 *      `web/app.svelte.js` after the R6-8.1a producer commit removed that export
 *      while the consumer was still uncommitted. Fixed in 44099da.
 *
 * PROVEN RETROACTIVELY AGAINST TWO OF THEM, in detached worktrees at the exact
 * broken commits — real history, not fixtures invented to fail:
 *   44099da^  -> "web/LabelDivider.svelte: imports { LABEL_FRAC_BOUNDS } from
 *                 './app.svelte.js', which does not export it"
 *   77aaf50^  -> "web/app.svelte.js: imports from './canvas/equationBinding.js',
 *                 which does not resolve to a file"
 * Green at HEAD: 800 source files, 6089 local named bindings.
 *
 * (4) is the instructive one, because the author had explicitly warned that the
 * change must land as ONE commit and had named the failure — and it still
 * happened, from the ordering everyone treats as SAFE. Producer-first is safe
 * when the producer only ADDS; a producer commit that REMOVES an export breaks
 * HEAD exactly as consumer-first does, and does it silently. Nobody watches the
 * safe direction, which is precisely why a gate has to.
 *
 * ── WHAT IT CHECKS, AND WHAT IT DELIBERATELY DOES NOT ───────────────────────
 * Checks: for every local (relative-path) `import { a, b as c } from "./x"` in
 * the app's own source, that `x` resolves AND exports each named binding. It
 * follows `export * from` re-export chains, and reads `<script module>` for
 * `.svelte` files, which is where a component's named exports live.
 *
 * Does NOT check: bare-package imports (not ours), default imports (a `.svelte`
 * component's default always exists), type-only imports (none here), or whether
 * an import is USED — that is a different defect (commit 3c071cd) and Rollup
 * ships an unused import in silence too. Dynamic `import()` is out of scope: its
 * failure is loud at runtime, which is the opposite of this defect.
 *
 * It is a REGEX reader, not a parser. That is a real limitation and it is stated
 * rather than hidden: it can miss an exotic export form, which makes it
 * under-strict (a false GREEN) and never over-strict, because an unrecognised
 * export form in the TARGET would raise a false alarm — so §0 below pins that the
 * reader actually sees the export shapes this codebase uses, on real files. A
 * gate whose parser has silently stopped understanding the code is the same
 * defect class it exists to catch.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const APP = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** The app's own source. `tests/` is included: a broken import there is a red
 *  suite, which is loud — but a broken import in a HELPER a suite imports is not. */
const ROOTS = ["web", "core", "plugins", "render_gpu", "cli", "tests"];
const SOURCE_RE = /\.(js|mjs|svelte)$/;
/** Never walked: build output, dependencies, and scratch space. */
// `dist` is here because the first version scanned web/dist/ — bundled vendor
// output, not our source. It inflated the file count, and a bundler artifact
// cannot be fixed by anyone reading this gate's failure message.
const SKIP_DIRS = new Set(["node_modules", ".frenzy", "dist", "dist-powerrp", ".claude_vlm_checks", ".git", "coverage"]);

/**
 * Pure function. Source with comments blanked, LINE COUNT PRESERVED (ledger
 * C-14). Without this, an import written out inside a docblock — which this
 * codebase does constantly, including in this very file — is read as real code.
 *
 * @param {string} src Source text.
 * @returns {string} The same text with comment bodies blanked.
 *
 * @example stripComments('a\n// b\nc')
 * 'a\n\nc'
 * @example // an import quoted in prose is not an import
 * stripComments('  // import { gone } from "./x.js";').trim()
 * ''
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

/** Query. Every source file under the app's roots, absolute. */
function sourceFiles() {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (SKIP_DIRS.has(name)) continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (SOURCE_RE.test(name)) out.push(p);
    }
  };
  for (const r of ROOTS) if (existsSync(join(APP, r))) walk(join(APP, r));
  return out;
}

/**
 * Pure function. The named bindings a `{...}` import clause binds, by their
 * SOURCE name — `b` in `b as c`, because that is the name the target must export.
 *
 * @param {string} clause The text between the braces.
 * @returns {string[]}
 *
 * @example importedNames('a, b as c')
 * ['a', 'b']
 * @example importedNames('\n  one,\n  two,\n')
 * ['one', 'two']
 */
export function importedNames(clause) {
  return clause.split(",").map((s) => s.trim()).filter(Boolean)
    .map((s) => s.split(/\s+as\s+/)[0].trim()).filter((s) => s && s !== "type");
}

/**
 * Pure function. The named exports a module's source declares, plus the module
 * specifiers it re-exports everything from (`export * from "./x"`), which the
 * caller must resolve transitively.
 *
 * @param {string} src Comment-stripped source text.
 * @returns {{names: Set<string>, star: string[]}}
 *
 * @example exportsOf('export const A = 1;\nexport function b() {}').names.has('b')
 * true
 * @example exportsOf('const x = 1;\nexport { x as y };').names.has('y')
 * true
 * @example exportsOf('export * from "./other.js";').star
 * ['./other.js']
 */
export function exportsOf(src) {
  const names = new Set();
  for (const m of src.matchAll(/\bexport\s+(?:async\s+)?(?:function\*?|class|const|let|var)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  // `export { a, b as c }` — the EXPORTED name is what a consumer may import, so
  // `c` in `b as c`. The opposite end from an import clause, and easy to invert.
  for (const m of src.matchAll(/\bexport\s*\{([^}]*)\}(?!\s*from)/g))
    for (const part of m[1].split(",")) {
      const t = part.trim();
      if (t) names.add((t.includes(" as ") ? t.split(/\s+as\s+/)[1] : t).trim());
    }
  for (const m of src.matchAll(/\bexport\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/g))
    for (const part of m[1].split(",")) {
      const t = part.trim();
      if (t) names.add((t.includes(" as ") ? t.split(/\s+as\s+/)[1] : t).trim());
    }
  const star = [...src.matchAll(/\bexport\s*\*\s*from\s*["']([^"']+)["']/g)].map((m) => m[1]);
  return { names, star };
}

/** Query. Resolve a relative specifier to a real file, or null. */
function resolveSpec(fromFile, spec) {
  const base = resolve(dirname(fromFile), spec);
  for (const c of [base, `${base}.js`, `${base}.mjs`, `${base}.svelte`, join(base, "index.js")])
    if (existsSync(c) && statSync(c).isFile()) return c;
  return null;
}

const cache = new Map();
/** Query. Every name a module exports, following `export * from` chains. */
function allExports(file, seen = new Set()) {
  if (cache.has(file)) return cache.get(file);
  if (seen.has(file)) return new Set();
  seen.add(file);
  const { names, star } = exportsOf(stripComments(readFileSync(file, "utf8")));
  for (const spec of star) {
    const t = resolveSpec(file, spec);
    if (t) for (const n of allExports(t, seen)) names.add(n);
  }
  cache.set(file, names);
  return names;
}

let checks = 0;
const ok = (msg) => { checks += 1; console.log(`  ok   ${msg}`); };

// ── §0 THE READER SEES THIS CODEBASE'S EXPORT SHAPES ────────────────────────
// A regex reader that has quietly stopped understanding the source would make
// §1 pass vacuously — the same defect tests/fabricated_subject_test.js exists
// for, one layer along. So the reader is checked before it is trusted.
//
// DERIVED, NOT A HARDCODED FILE LIST (ledger C-8). The first version named four
// specific files, and one of them was a module three hours old — which made the
// gate unrunnable against the very history it claims to catch, failing with
// "web/labelFrac.js is gone" at a commit that predated it. A hand-written list of
// probe files is a mirror of the tree, and it rots exactly like every other one.
// Instead: assert that each export FORM this codebase actually uses is seen
// somewhere in the corpus, and that the totals are far above zero.
{
  const forms = { declaration: 0, braced: 0, rexported: 0 };
  let modulesWithExports = 0, total = 0;
  for (const f of sourceFiles()) {
    const src = stripComments(readFileSync(f, "utf8"));
    const { names } = exportsOf(src);
    if (names.size) modulesWithExports += 1;
    total += names.size;
    if (/\bexport\s+(?:async\s+)?(?:function\*?|class|const|let|var)\s/.test(src)) forms.declaration += 1;
    if (/\bexport\s*\{[^}]*\}(?!\s*from)/.test(src)) forms.braced += 1;
    if (/\bexport\s*\{[^}]*\}\s*from/.test(src)) forms.rexported += 1;
  }
  // MEASURED, not assumed: these three forms occur in this codebase. `export *`
  // occurs ZERO times — the first version of this block asserted it did, which
  // was writing a gate against an imagined codebase instead of the one in front
  // of me. The star BRANCH of the reader is still exercised, but by a literal
  // below rather than by a corpus count that would have to stay at zero.
  for (const [form, n] of Object.entries(forms))
    assert.ok(n > 0, `the export reader found ZERO modules using the "${form}" form. This codebase uses all three, so that branch of the reader is broken and §1 would pass over anything importing from such a module.`);
  assert.deepEqual(exportsOf('export * from "./other.js";').star, ["./other.js"],
    "the export-star branch is broken. Nothing in this codebase uses `export * from` today, so only this literal exercises it — and the day someone adds one, §1 must follow the chain instead of silently reporting its exports missing.");
  assert.ok(total > 1000 && modulesWithExports > 200,
    `the export reader found only ${total} exports across ${modulesWithExports} modules — far too few for this codebase, so it has gone blind and §1 is vacuous.`);
  ok(`export reader sees ${total} exports in ${modulesWithExports} modules; all three export forms present, star branch unit-checked`);
}

// ── §1 THE CHECK ────────────────────────────────────────────────────────────
const files = sourceFiles();
const bad = [];
let bindings = 0;
for (const file of files) {
  const src = stripComments(readFileSync(file, "utf8"));
  for (const m of src.matchAll(/\bimport\s*\{([^}]*)\}\s*from\s*["'](\.[^"']+)["']/g)) {
    const target = resolveSpec(file, m[2]);
    const rel = file.slice(APP.length + 1);
    if (!target) { bad.push(`${rel}: imports from "${m[2]}", which does not resolve to a file`); continue; }
    const have = allExports(target);
    for (const n of importedNames(m[1])) {
      bindings += 1;
      if (!have.has(n)) bad.push(`${rel}: imports { ${n} } from "${m[2]}", which does not export it`);
    }
  }
}
assert.deepEqual(bad, [],
  `DANGLING NAMED IMPORT(S) — Rollup binds these to \`undefined\` and SHIPS them, so the build stays green and the failure reaches the user as "X is not a function":\n  ${bad.join("\n  ")}`);
ok(`${files.length} source files, ${bindings} local named bindings: every one resolves to a real export`);

// THE IMPORT READER MUST ALSO NOT GO BLIND. §0 pins the EXPORT side; this pins
// the IMPORT side, and it is the half that decides whether §1 asserted anything
// at all. If that regex stops matching, `bad` is empty for the worst possible
// reason and this file reports a confident green over an unchecked codebase.
// The floor is deliberately far below the real count (~2500) so ordinary churn
// never trips it and a regex that has stopped working always does.
assert.ok(bindings > 500,
  `only ${bindings} local named bindings were examined across ${files.length} files. This codebase has thousands, so the IMPORT reader has gone blind and the check above passed while asserting nothing.`);
ok("the import reader is still matching (floor check)");

console.log(`named imports: ${checks} checks passed`);
