/**
 * ONE-RANKING BAN guard — plain node, no framework.
 * Run: node src/demo_apps/PowerRP/tests/one_ranking_ban_test.js
 *
 * WHY THIS EXISTS. Two fuzzy scorers ship in this tree and both are meant to:
 * src/lib/fuzzyMatch.js is the component library's DEFAULT (manifest #28 requires
 * it verbatim — "DEFAULT plain fuzzy matching, pluggable custom sorting/fuzzy
 * algorithms"), and core/fuzzy.js is rp's completion ranker, which the palette,
 * the Asset Explorer, the File Browser, equation autocomplete and the iconify
 * search share. The library cannot reach core/fuzzy.js — src/lib has zero imports
 * outside svelte, deliberately — so the app is supposed to override via
 * SearchableDropdown's `rankFn` prop.
 *
 * It never did. Four mount points took the library default, so the same letters
 * ranked one way in the material picker and another in the command palette —
 * the exact defect web/AssetExplorer.svelte:37-38 had already written down ("a
 * second scorer would mean typing 'vid' ranks differently in two places in one
 * app, and the user learns one of them wrong") while choosing rp's scorer itself.
 * The author saw the hazard, recorded it, and could not see it had happened.
 *
 * That is why this file is a GATE and not a one-time sweep. The manifest's own
 * measurement: seams landed WITH a same-commit sweep reached 163/163 and 8/8
 * adoption; seams landed WITHOUT one reached 3%, 8% and 0%, and none caught up.
 * A fifth SearchableDropdown is one line, and nothing about writing it tells the
 * author a ranking decision is being made by omission.
 *
 * THE TWO BANS:
 *
 *  1. EVERY SearchableDropdown MOUNTED BY THIS APP PASSES `rankFn`. Detected by
 *     the mount's SHAPE — the element and its attribute list — not by a roster of
 *     known files, so a new mount in a new component is caught the day it lands.
 *     Scoped to the app's web/: this is an APP rule (one app, one ranking), not a
 *     correctness rule other demo apps are bound by, exactly as
 *     tests/native_tooltip_ban_test.js scopes its style ban.
 *
 *  2. NO THIRD SCORER. The app's ranking comes from core/fuzzy.js and the
 *     library's from src/lib/fuzzyMatch.js; a THIRD implementation is how this
 *     started. Detected by the shape both share — a case-folded character
 *     comparison driving a subsequence walk — with exactly those two files
 *     exempt. Ledger C-6/C-10: ban the shape, not the name, and pair every
 *     deduplication with a gate, because a tenth copy of one helper appeared
 *     during the very commit that removed the other nine.
 *
 * WHAT IT DOES NOT CLAIM. The two scorers disagree about ORDER, never about what
 * MATCHES: measured over 134 real queries against the material labels, the
 * 101-title retype roster and all 48 command titles, the match SET differed in
 * ZERO cases. Check 3 pins that, because a divergence in the match SET is a
 * different and worse defect than a divergence in order — a different order is a
 * preference, a different result set is a lie.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, relative } from "node:path";
import { rpFuzzyScore } from "../core/fuzzy.js";
import { fuzzyMatch } from "../../../lib/fuzzyMatch.js";

// Paths resolve from THIS FILE, never process.cwd().
const powerRP = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const svelteLib = resolve(powerRP, "../../..");

/** The app's one ranking, and the only file allowed to define the adapter. */
const APP_RANKER = resolve(powerRP, "web/searchRank.js");
/** The two scorer homes. Every other file must import, never reimplement. */
const SCORER_HOMES = [resolve(powerRP, "core/fuzzy.js"), resolve(svelteLib, "src/lib/fuzzyMatch.js")];

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok  ${name}`);
}

/**
 * Pure function. Blanks JavaScript and HTML/Svelte comments, PRESERVING every
 * newline so reported line numbers stay exact.
 *
 * Both halves are load-bearing, per ledger C-14. A comment-blind grep gate over
 * THIS codebase fails in both directions — it explains itself heavily in prose,
 * so an unstripped scan calls a commented example a copy (one sweep read 19 hits
 * where 1 was real) and calls a commented mention a definition (a rename gate
 * that could not fail). This very file quotes `rankFn` and the scorer shape in
 * its own docblock, so without stripping it would fail on its own explanation.
 * And the stripper must blank rather than delete: collapsing a comment to ""
 * shifts every later line number, and a sweep citing wrong lines costs the reader
 * more than the finding saves.
 *
 * @param {string} src - file text
 * @returns {string} the same text, same number of lines, comments blanked
 *
 * @example stripComments('<!-- rankFn -->\nconst a = 1;')
 * '               \nconst a = 1;'
 * @example // code before a line comment survives; the line keeps its length
 * stripComments('const n = 6; // the margin').trimEnd()
 * 'const n = 6;'
 * @example stripComments('const n = 6; // the margin').length
 * 26
 */
export function stripComments(src) {
  const blank = (m) => m.replace(/[^\n]/g, " ");
  return src
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/<!--[\s\S]*?-->/g, blank)
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, (m, p) => p + " ".repeat(m.length - p.length));
}

/**
 * Query. Every .js/.mjs/.svelte file under `dir`, recursively, skipping the four
 * kinds of not-our-source: `node_modules`, `dist` and `deps` (BUILD OUTPUT and
 * vendored bundles — minified mermaid/katex/pdfjs match almost any shape probe),
 * and dot-directories (`.frenzy/` holds whole snapshot trees of this app, stale
 * copies of every file here, so scanning them reports one finding per snapshot).
 *
 * @param {string} dir - absolute directory to walk
 * @returns {string[]} absolute file paths
 *
 * @example // sourceFiles("/…/PowerRP/web").some((p) => p.endsWith("Inspector.svelte")) // true
 * @example // sourceFiles("/…/PowerRP").some((p) => p.includes("/dist/")) // false
 */
export function sourceFiles(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === "dist" || e.name === "deps" || e.name.startsWith(".")) continue;
    const full = resolve(dir, e.name);
    if (e.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(js|mjs|svelte)$/.test(e.name)) out.push(full);
  }
  return out;
}

/**
 * Pure function. The 1-based line numbers of every `<SearchableDropdown …>` mount
 * in `src` that does NOT pass a `rankFn` prop.
 *
 * A mount runs from the opening tag to the first `>` that closes it, so the whole
 * attribute list is examined however many lines it spans — the four real mounts
 * in this app spread over five to nine lines each. Shorthand (`{rankFn}`) counts:
 * it is the same prop.
 *
 * @param {string} src - file text, comments already blanked
 * @returns {number[]} 1-based line numbers of offending mounts
 *
 * @example mountsMissingRankFn('<SearchableDropdown items={a} />')
 * [1]
 * @example mountsMissingRankFn('<SearchableDropdown\n  rankFn={appRankItems}\n  items={a}\n/>')
 * []
 * @example // shorthand is the same prop
 * mountsMissingRankFn('<SearchableDropdown {rankFn} items={a} />')
 * []
 * @example mountsMissingRankFn('<Dropdown items={a} />')
 * []
 */
export function mountsMissingRankFn(src) {
  const lines = [];
  const open = /<SearchableDropdown\b/g;
  let m;
  while ((m = open.exec(src)) !== null) {
    const end = src.indexOf(">", m.index);
    const attrs = src.slice(m.index, end === -1 ? src.length : end);
    if (!/\brankFn\b/.test(attrs)) lines.push(src.slice(0, m.index).split("\n").length);
  }
  return lines;
}

/**
 * Pure function. True when `src` DEFINES a fuzzy subsequence scorer rather than
 * importing one.
 *
 * THE SHAPE, and why this one: every such scorer must fold case to compare a
 * query character against a candidate character. Both shipping implementations
 * do it on an indexed or shifted single character — `queryChars[0].toUpperCase()
 * === candidateChar.toUpperCase()` in core/fuzzy.js, and a `t[ti] !== c` walk over
 * two `toLowerCase()`d strings in src/lib/fuzzyMatch.js. The detector therefore
 * looks for a case fold that is either applied to a subscripted character or
 * paired with a two-cursor walk, which is the irreducible core of the algorithm:
 * a third implementation can rename every identifier and still cannot avoid it.
 *
 * Deliberately NOT keyed on the words "fuzzy", "score" or "match" — the copies
 * this codebase actually grows are renamed, not verbatim (ledger C-6: nobody
 * names a function `fooTB` on purpose; the suffix exists because the good name
 * was taken).
 *
 * @param {string} src - file text, comments already blanked
 * @returns {boolean}
 *
 * TUNED EMPIRICALLY, not guessed, because either half ALONE is useless: over the
 * 823 source files this scans, the fold-compare alone yields 6 false positives
 * (keybindings comparing two chord names, pdf_backend lowercasing a URL scheme)
 * and the consuming walk alone yields 8 (an mp4 encoder, a thumbnail scheduler).
 * Their CONJUNCTION yields exactly the two homes and nothing else.
 *
 * @param {string} src - file text, comments already blanked
 * @returns {boolean}
 *
 * @example // two folded characters compared, plus a query consumed by shift()
 * definesScorer('if (q[0].toUpperCase() === c.toUpperCase()) q.shift();')
 * true
 * @example // comparing two folded strings is NOT a scorer without the walk
 * definesScorer('return a.toLowerCase() === b.toLowerCase();')
 * false
 * @example // nor is a walk without a case fold
 * definesScorer('while (t[i] !== c) i++;')
 * false
 * @example // importing one is exactly what we want, so it must pass
 * definesScorer('import { rpFuzzyScore } from "../core/fuzzy.js";')
 * false
 */
export function definesScorer(src) {
  const FOLD_COMPARE =
    /\.to(?:Lower|Upper)Case\(\)\s*[!=]==?\s*[^;\n]{0,60}\.to(?:Lower|Upper)Case\(\)|\.to(?:Lower|Upper)Case\(\);[\s\S]{0,200}?\.to(?:Lower|Upper)Case\(\);/;
  const CONSUMING_WALK =
    /\.shift\(\)|while\s*\([^)\n]*\[[^\]\n]+\]\s*[!=]==?[^)\n]*\)\s*[a-zA-Z_$][\w$]*\s*\+\+/;
  return FOLD_COMPARE.test(src) && CONSUMING_WALK.test(src);
}

console.log("one-ranking ban:");

// ── 1. EVERY app SearchableDropdown PASSES rankFn ────────────────────────────
test("every SearchableDropdown this app mounts passes rankFn", () => {
  const offenders = [];
  for (const file of sourceFiles(resolve(powerRP, "web"))) {
    const src = stripComments(readFileSync(file, "utf8"));
    for (const line of mountsMissingRankFn(src)) offenders.push(`${relative(powerRP, file)}:${line}`);
  }
  assert.deepEqual(
    offenders,
    [],
    `SearchableDropdown mounted without rankFn — it would silently take the LIBRARY's\n` +
      `scorer, giving this app a second ranking. Pass rankFn={appRankItems} from\n` +
      `web/searchRank.js. Offenders:\n  ${offenders.join("\n  ")}`
  );
});

// A mount really is detectable — a self-check, so the gate cannot pass by
// scanning nothing. C-14's lesson in miniature: a checker checked only against
// what it already handles is not checked.
test("self-check: the detector finds a rankFn-less mount and clears a wired one", () => {
  assert.deepEqual(mountsMissingRankFn("<SearchableDropdown\n  items={a}\n/>"), [1]);
  assert.deepEqual(mountsMissingRankFn("<SearchableDropdown\n  rankFn={appRankItems}\n/>"), []);
  const wired = sourceFiles(resolve(powerRP, "web")).filter((f) =>
    /<SearchableDropdown\b/.test(stripComments(readFileSync(f, "utf8"))));
  assert.ok(wired.length >= 2, `expected the app to mount SearchableDropdown; found ${wired.length} file(s)`);
});

// ── 2. NO THIRD SCORER ───────────────────────────────────────────────────────
test("only the two registered homes define a fuzzy scorer", () => {
  const extra = [];
  for (const file of [...sourceFiles(powerRP), ...sourceFiles(resolve(svelteLib, "src/lib"))]) {
    if (SCORER_HOMES.includes(file) || file === APP_RANKER) continue;
    if (file.startsWith(resolve(powerRP, "tests"))) continue; // suites quote shapes on purpose
    if (definesScorer(stripComments(readFileSync(file, "utf8")))) extra.push(relative(svelteLib, file));
  }
  assert.deepEqual(
    extra,
    [],
    `a THIRD fuzzy scorer. Import one of the two homes instead:\n` +
      `  the app  -> import { rpFuzzyScore } from "<rel>/core/fuzzy.js";\n` +
      `  the lib  -> import { fuzzyMatch } from "<rel>/src/lib/fuzzyMatch.js";\n` +
      `Offenders:\n  ${extra.join("\n  ")}`
  );
});

// ── 3. THE TWO SCORERS AGREE ON WHAT MATCHES ─────────────────────────────────
test("the two scorers never disagree about WHAT matches (only about order)", () => {
  const corpus = [
    "Liquid Glass", "corkboardThumbtack", "brightness_contrast", "Add Elbow Arrow",
    "Add Graph Line", "raycast_dither", "Vector Pattern", "/asset/RobotSim/hero-shot.png",
    "Text Typewriter", "mdi:script-text-outline", "Polygon / Star", "Screw Head (top)"
  ];
  const alphabet = "abcdefghijklmnopqrstuvwxyz./-_ ".split("");
  const queries = [...alphabet];
  for (const a of alphabet) for (const b of alphabet) queries.push(a + b);

  const disagreements = [];
  for (const candidate of corpus) {
    for (const query of queries) {
      const rp = rpFuzzyScore(query, candidate) !== null;
      const lib = fuzzyMatch(query, candidate) !== null;
      if (rp !== lib) disagreements.push(`"${query}" vs "${candidate}": rp=${rp} lib=${lib}`);
    }
  }
  assert.deepEqual(
    disagreements.slice(0, 8),
    [],
    `the two scorers now disagree about what MATCHES, not merely how it ranks.\n` +
      `A different ORDER is a preference; a different result SET means one surface\n` +
      `hides a result another shows. ${disagreements.length} disagreement(s):\n  ` +
      disagreements.slice(0, 8).join("\n  ")
  );
  assert.ok(queries.length * corpus.length > 10000, "corpus too small to be evidence");
});

console.log(`\n${passed} checks passed`);
