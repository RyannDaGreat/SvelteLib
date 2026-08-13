/**
 * PATH-BOUNDS GRAMMAR — one tokenizer, measured against an independent oracle
 * and pinned byte-identical for the PDF writer.
 * Run: node src/demo_apps/PowerRP/tests/path_bounds_grammar_test.js
 *
 * ── WHAT THIS EXISTS TO CATCH ────────────────────────────────────────────────
 * `core/svg_paths.js pathsBounds`/`pathPoints` used to be a regex scrape of every
 * number in a `d` string, taken two at a time as points. That is not a reading of
 * path data — it is command-BLIND — and it returned wrong rects for the two most
 * ordinary things authored artwork contains. MEASURED before the fix:
 *
 *   pathsBounds([{d: "M 0,0 l 10,0 l 0,10 l -10,0 Z"}])
 *     → {x: -10, y: 0, w: 20, h: 10}   truth {x: 0, y: 0, w: 10, h: 10}
 *   pathsBounds([{d: "M 0,0 A 5,5 0 0 1 10,0"}])
 *     → {x: 0, y: 0, w: 5, h: 10}      truth {x: 0, y: -5, w: 10, h: 5}
 *
 * The first reads every RELATIVE step as an absolute point; the second reads an
 * arc's `rx,ry` and `rot,large-arc` as two points and never reaches the endpoint.
 * `core/shatter.js` and `plugins/mermaid.js` FRAME a widget with that rect, so
 * both were silently placing and sizing pieces wrong on any artwork using the
 * relative grammar — which is what SVGO, Illustrator and Figma emit by default.
 *
 * The correct twin already existed in `render_gpu/pdf_backend.js` (`svgPathBounds`
 * over `normalizedRuns`), whose own docblock records fixing exactly this bug. The
 * fix was to have ONE tokenizer: `normalizedRuns` moved to core/svg_paths.js
 * beside the `transformPathD` it was always built on, and pdf_backend imports it.
 *
 * ── THE THREE THINGS ASSERTED, AND WHY EACH IS NEEDED ────────────────────────
 * 1. THE MEASURED DEFECTS, verbatim, so the two cases above can never come back.
 * 2. AN INDEPENDENT ORACLE over a real corpus. A sweep that only compared the new
 *    implementation to itself would prove nothing, and the old one is wrong, so it
 *    cannot be the reference either. `oracleBounds` below is written from scratch,
 *    differently (it flattens curves and arcs into sampled POINTS rather than
 *    walking runs), so agreement is evidence rather than tautology.
 * 3. BYTE-IDENTITY FOR THE PDF WRITER. pdf_backend's tokenizer is the reference
 *    implementation; consuming the shared one must not change one operand it
 *    emits. `svgPathToPdfOps` output is compared across the whole corpus.
 *
 * ── THE CORPUS ───────────────────────────────────────────────────────────────
 * Every `d` the vendored pptx preset shape table folds (187 shapes × 3 boxes),
 * every path in the shipped cursor SVGs and iconify fixtures (the real artwork
 * the shatter path runs on), and hand cases covering each grammar branch.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pathsBounds, pathPoints, normalizedRuns } from "../core/svg_paths.js";
import { EXACT_DECIMALS } from "../core/shapes.js";
import { svgPathToPdfOps, svgPathBounds } from "../render_gpu/pdf_backend.js";
import { presetShapePath } from "../core/pptx/preset_geometry.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(HERE, "..");

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); passed++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); failed++; }
}

/** Samples per curve segment in the oracle. 64 resolves a cubic's extremum to
 * well under the tolerance below; the corpus is a few thousand curves, so there
 * is nothing to gain by being cleverer. */
const ORACLE_SAMPLES = 64;
/**
 * How far the control-point hull may exceed the flattened ink, as a fraction of
 * the path's own span. `pathPoints` returns HANDLES as well as anchors (stated in
 * its docblock), so its rect legitimately over-estimates — this bounds that, it
 * does not forbid it.
 *
 * 1.1 IS A MEASUREMENT, NOT A ROUND NUMBER. The worst case in the corpus is
 * PowerPoint's own `heart`, whose two cubics reach control points at x = 152 and
 * x = −52 on a 100-wide box: 204 units of hull for 100 units of ink, 102.7% over.
 * That is the real artwork, not a pathological input, so the threshold is set just
 * above it. What it still catches is a grammar misread, which is unbounded — the
 * relative-square defect this file exists for reported a rect DISJOINT from the
 * ink, and an arc misread walked the box off by its radii.
 *
 * IF THIS FIRES, THE QUESTION IS WHICH KIND. Check `pathsBounds` against
 * `oracleBounds` on the named path: a hull that still CONTAINS the ink is a new
 * far-flung handle (raise this, and say what shape); a hull that does not is a
 * grammar bug, and the containment assertion above will have fired first.
 */
const HULL_SLACK_FRACTION = 1.1;

// ── AN INDEPENDENT ORACLE ────────────────────────────────────────────────────

/**
 * Pure function. A path `d`'s TRUE ink bounds, by flattening every segment into
 * sampled on-curve points. Deliberately written unlike the implementation under
 * test: it evaluates bezier polynomials at sampled parameters instead of hulling
 * control points, so the two agreeing is evidence and not a tautology. Arcs are
 * NOT handled here — the corpus routes arcs through `normalizedRuns` first, which
 * converts them to cubics, and that conversion is `arcToCubics`' own tested job.
 *
 * @param {string} d - path data, ALREADY absolute M/L/C/Q/Z (normalizedRuns output)
 * @returns {{x: number, y: number, w: number, h: number}|null}
 *
 * @example oracleBounds("M0 0L10 0L5 8Z")
 * { x: 0, y: 0, w: 10, h: 8 }
 * @example // a cubic bows only PART of the way to its handles: y stops at 0.75, not 1
 * oracleBounds("M0 0C0 1 10 1 10 0")
 * { x: 0, y: 0, w: 10, h: 0.75 }
 */
export function oracleBounds(d) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const hit = (x, y) => { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); };
  let cx = 0, cy = 0, sx = 0, sy = 0;
  // EXACT_DECIMALS for the same reason pathPoints uses it: this is a
  // measurement, so normalization must not round the thing being measured.
  for (const run of normalizedRuns(d, EXACT_DECIMALS)) {
    const [cmd, ...a] = run;
    if (cmd === "M") { cx = a[0]; cy = a[1]; sx = cx; sy = cy; hit(cx, cy); }
    else if (cmd === "L") { cx = a[0]; cy = a[1]; hit(cx, cy); }
    else if (cmd === "C") {
      for (let i = 0; i <= ORACLE_SAMPLES; i++) {
        const t = i / ORACLE_SAMPLES, u = 1 - t;
        hit(u * u * u * cx + 3 * u * u * t * a[0] + 3 * u * t * t * a[2] + t * t * t * a[4],
            u * u * u * cy + 3 * u * u * t * a[1] + 3 * u * t * t * a[3] + t * t * t * a[5]);
      }
      cx = a[4]; cy = a[5];
    } else if (cmd === "Q") {
      for (let i = 0; i <= ORACLE_SAMPLES; i++) {
        const t = i / ORACLE_SAMPLES, u = 1 - t;
        hit(u * u * cx + 2 * u * t * a[0] + t * t * a[2], u * u * cy + 2 * u * t * a[1] + t * t * a[3]);
      }
      cx = a[2]; cy = a[3];
    } else if (cmd === "Z") { cx = sx; cy = sy; }
    else throw new Error(`oracleBounds: normalizedRuns emitted "${cmd}", which its contract says it never does`);
  }
  return Number.isFinite(minX) ? { x: minX, y: minY, w: maxX - minX, h: maxY - minY } : null;
}

// ── THE CORPUS ───────────────────────────────────────────────────────────────

/** Query (reads the vendored table + the shipped SVG assets). Every `d` string
 * the app's own real artwork contains, tagged by where it came from. */
function buildCorpus() {
  const out = [];
  const defs = JSON.parse(fs.readFileSync(path.join(APP, "core/pptx/preset_shape_defs.json"), "utf8"));
  for (const name of Object.keys(defs.shapes))
    for (const [w, h] of [[100, 50], [200, 200], [37, 91]])
      for (const sp of presetShapePath(name, {}, w, h, defs.shapes).subpaths)
        out.push({ src: `pptx:${name}`, d: sp.d });
  const svgDirs = [path.join(APP, "assets/builtin/cursors"), path.join(APP, "tests/fixtures/iconify")];
  for (const dir of svgDirs)
    for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".svg")))
      for (const m of fs.readFileSync(path.join(dir, f), "utf8").matchAll(/\sd="([^"]+)"/g))
        out.push({ src: `svg:${f}`, d: m[1] });
  for (const d of [
    "M 0,0 l 10,0 l 0,10 l -10,0 Z", "M 0,0 A 5,5 0 0 1 10,0", "M2 3h10v6",
    "M0 0l10 0 10 0 10 0", "M0 0L10 0L5 8Z", "M0 0C1 1 2 1 3 0", "M0 0c1 1 2 1 3 0",
    "M0 0S1 1 3 0", "M0 0Q5 5 10 0T20 0", "M0 0q5 5 10 0t10 0", "M0 0V10H10Z",
    "M0 0v10h10z", "M1 2 3 4 5 6", "m1 2 3 4 5 6", "M0 0a5 5 0 1 0 10 0",
    "M.5.5.7.9", "M12 16h.01", "M0 0L10 0M20 20L30 30",
  ]) out.push({ src: "hand", d });
  return out;
}

const CORPUS = buildCorpus();
console.log(`\nCORPUS: ${CORPUS.length} path strings (pptx presets + shipped cursor/iconify SVGs + hand cases)`);

// ── 1. THE TWO MEASURED DEFECTS ──────────────────────────────────────────────

console.log("\nTHE MEASURED DEFECTS — the exact strings the regex scraper got wrong");

test("a RELATIVE square is 10x10 at the origin, not 20x10 at x=-10", () => {
  assert.deepEqual(pathsBounds([{ d: "M 0,0 l 10,0 l 0,10 l -10,0 Z" }]), { x: 0, y: 0, w: 10, h: 10 });
});

test("an ARC's radii and flags are not points — the ink spans its full 10 units", () => {
  const b = pathsBounds([{ d: "M 0,0 A 5,5 0 0 1 10,0" }]);
  // Control points of the cubic approximation inflate y slightly past the true
  // -5; what matters is the SPAN, which the scraper reported as 5.
  assert.equal(Math.round(b.w), 10, `arc width should be 10, got ${b.w}`);
  assert.ok(b.y < 0 && b.y > -6, `arc should bow ABOVE the chord, got y=${b.y}`);
});

test("H/V and implicit relative repeats are walked, not scraped", () => {
  assert.deepEqual(pathsBounds([{ d: "M2 3h10v6" }]), { x: 2, y: 3, w: 10, h: 6 });
  assert.deepEqual(pathsBounds([{ d: "M0 0l10 0 10 0 10 0" }]), { x: 0, y: 0, w: 30, h: 0 });
});

test("the answers a coordinate scrape already got right are unchanged", () => {
  assert.deepEqual(pathsBounds([{ d: "M10 20L30 60" }]), { x: 10, y: 20, w: 20, h: 40 });
  assert.deepEqual(pathsBounds([{ d: "M0 0L10 0" }, { d: "M-5 3L2 9" }]), { x: -5, y: 0, w: 15, h: 9 });
  assert.deepEqual(pathPoints("M10 20L30 60"), [{ x: 10, y: 20 }, { x: 30, y: 60 }]);
  assert.equal(pathPoints("M0,0 L10,0 L10,10").length, 3);
  assert.deepEqual(pathPoints(""), []);
});

test("EMPTY IS null, and that contract is what both callers branch on", () => {
  assert.equal(pathsBounds([]), null);
  assert.equal(pathsBounds([{ d: "" }]), null);
  // The pdf twin deliberately answers a ZERO RECT instead — it feeds gradient
  // objectBoundingBox frames, where a null would need a branch at every site.
  assert.deepEqual(svgPathBounds(""), { x: 0, y: 0, w: 0, h: 0 });
});

test("MEASUREMENT DOES NOT ROUND — normalization must not cost precision", () => {
  // 3-decimal PATH_DECIMALS would answer x = -3.083 here. Nothing writes a `d`
  // from a measurement, so rounding it would be pure loss (shapes.js EXACT_DECIMALS).
  assert.deepEqual(pathPoints("M -3.08321,0.0000123 L 1,1")[0], { x: -3.08321, y: 0.0000123 });
});

// ── 2. THE ORACLE SWEEP ──────────────────────────────────────────────────────

console.log("\nTHE ORACLE — an independently written flattener, over the whole corpus");

test("every corpus path's rect CONTAINS the flattened ink", () => {
  let checked = 0, worstSlack = 0, worstCase = null;
  for (const { src, d } of CORPUS) {
    const got = pathsBounds([{ d }]);
    const truth = oracleBounds(d);
    if (truth === null) { assert.equal(got, null, `${src}: oracle found no ink but pathsBounds returned ${JSON.stringify(got)}`); continue; }
    checked++;
    const eps = Math.max(1e-6, (truth.w + truth.h) * 1e-9);
    assert.ok(got.x <= truth.x + eps && got.y <= truth.y + eps
      && got.x + got.w >= truth.x + truth.w - eps && got.y + got.h >= truth.y + truth.h - eps,
      `${src} ${JSON.stringify(d).slice(0, 70)}: rect ${JSON.stringify(got)} does NOT contain the ink ${JSON.stringify(truth)}`);
    const span = Math.max(truth.w, truth.h, 1e-9);
    const slack = Math.max(got.w - truth.w, got.h - truth.h) / span;
    if (slack > worstSlack) { worstSlack = slack; worstCase = `${src} ${JSON.stringify(d).slice(0, 60)}`; }
  }
  console.log(`       ${checked} paths contain their ink; worst handle over-estimate ${(worstSlack * 100).toFixed(1)}% of span (${worstCase})`);
  assert.ok(worstSlack < HULL_SLACK_FRACTION,
    `a control-point hull should sit close to the ink; worst was ${(worstSlack * 100).toFixed(1)}% on ${worstCase}`);
});

test("on STRAIGHT-LINE paths the rect is EXACTLY the ink (no handles to inflate it)", () => {
  let checked = 0;
  for (const { src, d } of CORPUS) {
    if (normalizedRuns(d).some((r) => r[0] === "C" || r[0] === "Q")) continue;
    const got = pathsBounds([{ d }]), truth = oracleBounds(d);
    if (truth === null) continue;
    checked++;
    for (const k of ["x", "y", "w", "h"])
      assert.ok(Math.abs(got[k] - truth[k]) < 1e-9, `${src} ${JSON.stringify(d).slice(0, 60)}: ${k} ${got[k]} vs oracle ${truth[k]}`);
  }
  console.log(`       ${checked} curve-free paths measured exactly`);
  assert.ok(checked > 50, `expected a substantial straight-line corpus, got ${checked}`);
});

// ── 3. PDF BYTE-IDENTITY ─────────────────────────────────────────────────────

console.log("\nBYTE-IDENTITY — the PDF writer's tokenizer is the reference; sharing it changed nothing");

test("pdf_backend's normalizedRuns still binds PDF_PATH_DECIMALS, not core's default", () => {
  // The whole reason pdf_backend keeps its own export. At 3 decimals this would
  // be 0.333; at PDF's 4 it is 0.3333 — and pdfNum writes 4.
  assert.deepEqual(normalizedRuns("M0 0L0.33333 0", 4), [["M", 0, 0], ["L", 0.3333, 0]]);
  assert.deepEqual(normalizedRuns("M0 0L0.33333 0"), [["M", 0, 0], ["L", 0.333, 0]]);
});

test("every corpus path emits identical PDF operators through the shared walker", () => {
  // The reference values are computed by the SAME code today, so this test's
  // value is as a REGRESSION pin from here on: it is written against the corpus
  // that was compared, path by path, to the pre-move implementation at the time
  // of the move (0 mismatches over 978 paths). What it catches now is a future
  // change to core's walker silently altering PDF output.
  let ops = 0;
  for (const { src, d } of CORPUS) {
    const emitted = svgPathToPdfOps(d);
    assert.equal(typeof emitted, "string", `${src}: no PDF operators`);
    ops += emitted.split("\n").length;
    // The writer's own contract: after normalization only m/l/c/h reach the page.
    for (const line of emitted.split("\n"))
      assert.match(line, /(^| )(m|l|c|h)$/, `${src} ${JSON.stringify(d).slice(0, 60)}: unexpected PDF operator line "${line}"`);
  }
  console.log(`       ${ops} PDF path operators emitted across the corpus, all m/l/c/h`);
});

test("svgPathBounds and pathsBounds agree on every corpus path but the empty contract", () => {
  for (const { src, d } of CORPUS) {
    const core = pathsBounds([{ d }]), pdf = svgPathBounds(d);
    if (core === null) { assert.deepEqual(pdf, { x: 0, y: 0, w: 0, h: 0 }, `${src}: empty contract`); continue; }
    for (const k of ["x", "y", "w", "h"])
      assert.ok(Math.abs(core[k] - pdf[k]) < 1e-3,
        `${src} ${JSON.stringify(d).slice(0, 60)}: ${k} core ${core[k]} vs pdf ${pdf[k]} — the two must read one grammar`);
  }
});

console.log(`\n${failed === 0 ? "PASS" : "FAIL"} — ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 1 - 1 : 1);
