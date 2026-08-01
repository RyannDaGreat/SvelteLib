/**
 * triangulated_paint_ban_test.js — EAR-CLIPPING IS NOT A PAINT PATH.
 * Run: node src/demo_apps/PowerRP/tests/triangulated_paint_ban_test.js
 *
 * WHY THIS EXISTS (R6-11, the user's "red flag" and then his generalization of it:
 * "Ideally, nothing will ever try to make triangles again, as long as we can have
 * operations on arbitrary topology"). Two abutting ANTIALIASED fills conflate along
 * their shared edge to ~192/255 instead of tiling to 255. So a shape split into N
 * touching pieces shows a crack at every internal edge, on every surface that is not
 * multisampled — which is every surface in this app except the editor viewport
 * (thumbnails, minimap, PNG/PDF export, presenter fades, every exported video frame,
 * the bare-node CLI). The donut fanned into 128 pieces, the fancy arrow into 5, and a
 * default filmstrip's two perforated bands into 480. All three were ear-clipped
 * through `core/outline.js triangulated()`.
 *
 * WHAT IS BANNED, AND WHAT IS NOT — the distinction is the whole point, and getting
 * it wrong in either direction is a bug:
 *   - BANNED: reaching `triangulated()` from a PAINT path. It exists to turn an
 *     arbitrary outline into convex pieces, and there is no longer any reason to
 *     want that: the `path` op takes an SVG `d` with a `fillRule` and has done in all
 *     three backends since 2026-07-23 (c0646a5), so concave, self-intersecting,
 *     multi-subpath and HOLED shapes are each ONE op with ONE gradient frame.
 *   - NOT BANNED: the convex `polygon` op itself. It is legitimate and it stays.
 *     MEASURED (R6-11, agent W2-A): the defect was never the op, it was emitting ONE
 *     SHAPE AS N OPS. A LONE polygon has no neighbour to conflate with, and per-op
 *     bounds is the correct gradient frame for an op that IS a shape. Arrow heads,
 *     line caps, the video play glyphs and the clock hands are each one polygon for
 *     one shape and are correct as they are.
 *   - NOT BANNED: `triangulated()` as a geometry query. It is a pure function over an
 *     outline and a hit test or an area computation may use it freely. Only the route
 *     from an outline to PIXELS is closed.
 *
 * SO THIS IS A SOURCE SCAN, in the shape of tests/native_tooltip_ban_test.js: the
 * property is "this construct is not reachable from here", and only reading the
 * sources can say that. It is deliberately narrow — one import, one call — because a
 * ban that overreaches gets weakened, and a weakened ban is the thing that let the
 * "no evenodd/fillRule anywhere in render_gpu" claim outlive its evidence in four
 * separate files and teach every plugin author written after it to ear-clip.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, relative } from "node:path";
import { triangulated } from "../core/outline.js";

// Paths resolve from THIS FILE, never process.cwd().
const powerRP = resolve(dirname(fileURLToPath(import.meta.url)), "..");

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

/** Directories that hold no source of ours: build output, dependencies, user data, and
 *  the round's scratch area (another agent's Vite cache lives under .frenzy/, which is
 *  the mistake tests/connectivity_seam_test.js made by scanning it). */
const SKIP_DIRS = new Set(["node_modules", "dist", ".vite", ".frenzy", ".git", "projects"]);

/** Query. Every .js/.mjs path under `dir`, recursively, as absolute paths. */
function jsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const p = resolve(dir, entry.name);
    if (entry.isDirectory()) out.push(...jsFiles(p));
    else if (entry.name.endsWith(".js") || entry.name.endsWith(".mjs")) out.push(p);
  }
  return out;
}

/**
 * Pure function. Blanks comment runs, keeping every newline so a reported line number
 * is the line in the REAL file. Collapsing a docblock to one space was tried first and
 * it mis-cited every hit by hundreds of lines — a ban test that points at the wrong
 * line costs more time than the ban saves.
 *
 * The docblocks that EXPLAIN a ban necessarily name the banned construct, which is the
 * trap tests/native_tooltip_ban_test.js documents for `title=`; this is that file's
 * `stripComments`, for JavaScript.
 *
 * @param {string} src - JavaScript source text
 * @returns {string} the same text with `//…` and block comments blanked
 *
 * @example withoutComments("a(); // triangulated(x)")
 * 'a(); '
 * @example withoutComments("keep('//not a comment')")
 * "keep('//not a comment')"
 * @example withoutComments("x\n/[*]\np\n[*]/\ny".replace(/\[\*\]/g, "*")).split("\n").length
 * 5
 */
export function withoutComments(src) {
  let out = "";
  let i = 0;
  let quote = null;
  while (i < src.length) {
    const c = src[i];
    if (quote) {
      if (c === "\\") { out += src.slice(i, i + 2); i += 2; continue; }
      if (c === quote) quote = null;
      out += c; i++; continue;
    }
    if (c === '"' || c === "'" || c === "`") { quote = c; out += c; i++; continue; }
    if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++; // the \n itself falls through and is kept
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end === -1 ? src.length : end + 2;
      out += src.slice(i, stop).replace(/[^\n]/g, " ");
      i = stop;
      continue;
    }
    out += c; i++;
  }
  return out;
}

/**
 * Pure function. Blanks the BODY of every string/template literal (delimiters and
 * newlines kept), so English prose in a quoted sentence is never read as a call.
 *
 * THIS IS A REAL FALSE POSITIVE CLASS, not a hypothetical: the sibling scan for the
 * `polygon(` call matched `plugins/shapeshifter.js`'s Inspector help, which reads
 * "sides on a polygon (three or more…)" — the call regex verbatim, inside a string.
 *
 * Blanking a template literal also blanks any `${…}` inside it, so a call written in
 * an interpolation would be missed. Deliberate: this scan is the layer that makes a
 * re-introduction obvious at review time, and the seam census in
 * tests/widget_fill_seam_test.js is the layer that measures the consequence.
 *
 * @param {string} src - JavaScript source with comments already blanked
 * @returns {string} the same text with literal bodies blanked
 *
 * @example blankLiterals("help: 'ear-clipped (triangulated)'")
 * "help: '                            '"
 * @example blankLiterals('draw(triangulated(pts))')
 * 'draw(triangulated(pts))'
 */
export function blankLiterals(src) {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c !== '"' && c !== "'" && c !== "`") { out += c; i++; continue; }
    let j = i + 1;
    while (j < src.length && src[j] !== c) j += src[j] === "\\" ? 2 : 1;
    out += c + src.slice(i + 1, Math.min(j, src.length)).replace(/[^\n]/g, " ") + (j < src.length ? c : "");
    i = j + 1;
  }
  return out;
}

// A CALL to the ear-clipper: the identifier followed by `(`, bare or as a member
// (`outline.triangulated(`) — the lookbehind admits a leading dot on purpose so a
// qualified call is caught too, and rejects longer identifiers that merely end the
// same way.
const TRIANGULATED_CALL = /(?<![A-Za-z0-9_$])triangulated\s*\(/g;

// THE ONLY PLACES ALLOWED TO NAME IT, each for a stated reason. This is a floor as
// well as an exemption list: a path that stops appearing here is a path that stopped
// exercising the function, which check (3) refuses.
const ALLOWED = new Map([
  ["core/outline.js", "its definition"],
  ["tests/outline_test.js", "the ear-clipper's own unit tests — it is still a correct pure function"],
  ["tests/triangulated_paint_ban_test.js", "this file, which imports it to prove it still exists"],
]);

const sources = jsFiles(powerRP);

test("(1) the ear-clipper still EXISTS — this is a ban on one use, not a deletion", () => {
  assert.ok(
    typeof triangulated === "function",
    "core/outline.js triangulated() is gone. It was never wrong as geometry — a hit test or an area " +
    "computation may use it. Only the route from an outline to PIXELS is closed.",
  );
  assert.equal(triangulated([[0, 0], [10, 0], [10, 10], [0, 10]]).length, 2, "and it still ear-clips a square into two triangles");
});

test("(2) no PAINT path reaches it — every call site is one of the declared exemptions", () => {
  const offenders = [];
  for (const f of sources) {
    const rel = relative(powerRP, f);
    if (ALLOWED.has(rel)) continue;
    const src = blankLiterals(withoutComments(readFileSync(f, "utf8")));
    for (const m of src.matchAll(TRIANGULATED_CALL))
      offenders.push(`${rel}:${src.slice(0, m.index).split("\n").length}`);
  }
  assert.deepEqual(
    offenders, [],
    `${offenders.length} call(s) to triangulated() outside its exemptions:\n  ${offenders.join("\n  ")}\n` +
    "If this is a PAINT path, emit ONE `path` op instead — `path({d: polygonPathD(loop), fill, opacity})` " +
    "for a single outline, `subpathsPathD(loops)` + `fillRule: \"evenodd\"` for a shape with holes. N " +
    "abutting antialiased fills crack at ~192/255 along every shared edge. If it is genuinely a geometry " +
    "query, add it to ALLOWED above WITH ITS REASON.",
  );
});

test("(3) every exemption is LIVE — a stale one would hide the thing it excuses", () => {
  const stale = [];
  for (const [rel, why] of ALLOWED) {
    const src = blankLiterals(withoutComments(readFileSync(resolve(powerRP, rel), "utf8")));
    if (!TRIANGULATED_CALL.test(src) && !/triangulated/.test(src)) stale.push(`${rel} (${why})`);
    TRIANGULATED_CALL.lastIndex = 0;
  }
  assert.deepEqual(
    stale, [],
    `${stale.length} exemption(s) no longer mention triangulated():\n  ${stale.join("\n  ")}\n` +
    "An exemption list that outlives its entries is the same failure mode as a doctest quarantine that " +
    "outlives its bug — it silently widens. Delete the entry.",
  );
});

console.log(`\ntriangulated paint-ban tests: ${passed} passed`);
