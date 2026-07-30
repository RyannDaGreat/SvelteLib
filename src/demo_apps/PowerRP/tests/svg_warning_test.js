/**
 * SVG FLATTEN-WARNING VISIBILITY guard — plain node, no framework.
 * Run: node src/demo_apps/PowerRP/tests/svg_warning_test.js
 *
 * WHY THIS EXISTS. core/svg_paths.js renders several SVG features WRONG rather
 * than not at all: `mask` is a non-rendering tag, so an element carrying `mask=`
 * is drawn UNMASKED; `clip-path`, `filter`, inline `style=` and radial
 * gradients degrade the same way. (Arcs USED to be on this list; they now bake
 * to cubics — arcToCubics — and are covered by the arc tests at the bottom.) Each added a `warnings` string — which only ever
 * reached console.error through reportOnce. The USER saw plausible-looking art
 * that was simply wrong, with no signal at all; that is how a shipped built-in
 * cursor drew four squares instead of a disc for who knows how long. A malformed
 * SVG got a proper in-widget errorAffordance; a MIS-rendered one got nothing.
 *
 * WHAT IT PROVES:
 *   (1) every punt names the FEATURE **and the ELEMENT** carrying it (a bare
 *       "mask is unsupported" is not actionable in a 40-element document);
 *   (2) the adapter hands warnings back to callers (svgToIRWithWarnings) instead
 *       of swallowing them, and svgToIR stays the ops-only view for the cursor
 *       widget (its committed assets have nowhere to show a notice);
 *   (3) the SVG widget's emit APPENDS the notice band to the art — the degraded
 *       art still renders (the band annotates, it does not replace);
 *   (4) a CLEAN SVG emits NOTHING extra — byte-for-byte the pre-affordance ops;
 *   (5) a MALFORMED SVG still gets the full-box red errorAffordance instead
 *       (the two affordances never mix);
 *   (6) warningLabel/warningAffordance behave as their doctests claim.
 */

import assert from "node:assert/strict";
import { flattenSvgTree, transformPathD as transformPathDRef, arcToCubics } from "../core/svg_paths.js";
import { parseSvgToTree, svgToIR, svgToIRWithWarnings } from "../render_gpu/gpu/svg_raster.js";
import { svgPlugin, warningAffordance, warningLabel, errorAffordance } from "../plugins/svg.js";

const BOX = 200; // the widget box these checks emit into
const IDENTITY_WORLD = { x: 0, y: 0, rotation: 0, scale: 1 };

const CLEAN = '<svg viewBox="0 0 48 48"><rect x="4" y="4" width="40" height="40" rx="8" fill="#7aa2f7"/></svg>';
const MASKED = '<svg viewBox="0 0 48 48"><defs><mask id="m"><rect width="24" height="48" fill="#fff"/></mask></defs><circle cx="24" cy="24" r="20" fill="#7aa2f7" mask="url(#m)"/></svg>';
const CLIPPED = '<svg viewBox="0 0 8 8"><rect width="8" height="8" fill="#000" clip-path="url(#c)"/></svg>';
const FILTERED = '<svg viewBox="0 0 8 8"><rect width="8" height="8" fill="#000" filter="url(#f)"/></svg>';
const STYLED = '<svg viewBox="0 0 8 8"><rect width="8" height="8" style="fill:#f00"/></svg>';
const RADIAL = '<svg viewBox="0 0 8 8"><radialGradient id="r"><stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/></radialGradient><rect width="8" height="8" fill="url(#r)"/></svg>';
const TEXTUAL = '<svg viewBox="0 0 8 8"><text x="0" y="8">hi</text></svg>';

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

/** Query. The flatten warnings for an SVG source at the standard box. */
function warningsFor(src) {
  return flattenSvgTree(parseSvgToTree(src), BOX, BOX, {}).warnings;
}

/** Query. The SVG widget's emitted ops for a source (identity world, no border). */
function emitFor(src) {
  const state = { ...svgPlugin.defaults, svgSrc: src, x: 0, y: 0, w: BOX, h: BOX };
  return svgPlugin.emit(state, null, IDENTITY_WORLD);
}

// ── (1) every punt names the feature AND the element ──────────────────────────

test("mask / clip-path / filter / inline style= punts name the ELEMENT they are on", () => {
  assert.deepEqual(warningsFor(MASKED), ["svg: <circle> mask= is unsupported (v1) — the element is rendered without it"]);
  assert.deepEqual(warningsFor(CLIPPED), ["svg: <rect> clip-path= is unsupported (v1) — the element is rendered without it"]);
  assert.deepEqual(warningsFor(FILTERED), ["svg: <rect> filter= is unsupported (v1) — the element is rendered without it"]);
  assert.deepEqual(warningsFor(STYLED), ["svg: <rect> inline style= is ignored (v1 reads presentation attributes only)"]);
});

test("an unsupported ELEMENT and an approximated gradient warn too", () => {
  assert.deepEqual(warningsFor(TEXTUAL), ["svg: <text> is unsupported in v1 (skipped)"]);
  assert.match(warningsFor(RADIAL)[0], /gradient "r" \(radialGradient\) approximated as its first-stop solid/);
});

test("a masked element really is drawn UNMASKED (the wrong art the band now flags)", () => {
  // The whole point of the affordance: the geometry is emitted in full, with the
  // mask silently dropped. If this ever becomes real masking, the warning goes.
  assert.equal(flattenSvgTree(parseSvgToTree(MASKED), BOX, BOX, {}).ops.length, 1);
});

// ── (2) the adapter hands warnings back; svgToIR stays the ops-only view ──────

test("svgToIRWithWarnings returns {ops, warnings}; svgToIR returns just the ops", () => {
  const full = svgToIRWithWarnings(MASKED, BOX, BOX, {});
  assert.ok(Array.isArray(full.ops) && full.ops.length > 0);
  assert.equal(full.warnings.length, 1);
  assert.deepEqual(svgToIR(MASKED, BOX, BOX, {}), full.ops);
  assert.deepEqual(svgToIRWithWarnings(CLEAN, BOX, BOX, {}).warnings, []);
});

// ── (3)(4)(5) what the widget actually emits ─────────────────────────────────

test("a DEGRADED SVG keeps its art and gains the notice band", () => {
  const clean = emitFor(CLEAN);
  const degraded = emitFor(MASKED);
  const band = degraded.slice(-2);
  assert.equal(band[0].op, "rect");
  assert.equal(band[1].op, "text");
  assert.match(band[1].text, /^Unsupported: <circle> mask=/);
  // The art is STILL there: the path ops precede the band.
  assert.ok(degraded.filter((o) => o.op === "path").length > 0, "the degraded art was dropped");
  // The band is the ONLY addition (same op count as the clean emit + 2).
  assert.equal(degraded.length, clean.length + 2);
});

test("the band hugs the BOTTOM edge and stays inside the box", () => {
  const [box] = warningAffordance(BOX, BOX, ["svg: x"]);
  assert.ok(box.y > 0 && box.y < BOX, `band top ${box.y} not inside the box`);
  assert.equal(box.y + box.h, BOX, "band does not end exactly at the bottom edge");
  assert.equal(box.w, BOX);
  // A tiny widget gets a proportional band, not a fixed one that swallows it.
  const small = warningAffordance(32, 32, ["svg: x"])[0];
  assert.ok(small.h < 32 / 2, `a 32-unit box got a ${small.h}-unit band`);
});

test("a CLEAN SVG emits no band at all (nothing to see when nothing is wrong)", () => {
  const ops = emitFor(CLEAN);
  assert.ok(!ops.some((o) => o.op === "text"), "a clean SVG emitted a notice text op");
  assert.ok(!ops.some((o) => o.op === "rect"), "a clean SVG emitted a notice rect op");
});

test("a MALFORMED SVG still gets the red error affordance, not the band", () => {
  const ops = emitFor("<svg><g></svg>");
  assert.deepEqual(ops.map((o) => o.op), errorAffordance(BOX, BOX, "x").map((o) => o.op));
  assert.match(ops[1].text, /^SVG error: /);
});

// ── (6) the pure helpers ─────────────────────────────────────────────────────

test("warningLabel / warningAffordance doctests", () => {
  assert.equal(warningLabel([]), "");
  assert.equal(warningLabel(["svg: <text> is unsupported in v1 (skipped)"]), "Unsupported: <text> is unsupported in v1 (skipped)");
  assert.equal(warningLabel(["svg: a", "svg: b", "svg: c"]), "Unsupported: a; b (+1 more)");
  const aff = warningAffordance(200, 100, ["svg: <text> unsupported"]);
  assert.equal(aff.length, 2);
  assert.equal(aff[0].op, "rect");
  assert.equal(aff[0].y, 76);
});

// ── arcs: supported (baked to cubics), NOT a warning ─────────────────────────
// Real-world icon sets (tabler, mdi, simple-icons, logos) lean on `A` commands;
// arcToCubics keeps downstream PDF-safe, so an arc must flatten silently.

const ARCED = '<svg viewBox="0 0 24 24"><path fill="#f00" d="M4 6a8 3 0 1 0 16 0A8 3 0 1 0 4 6"/></svg>';

test("an A/a arc path flattens with ZERO warnings and an arc-free d", () => {
  const { ops, warnings } = flattenSvgTree(parseSvgToTree(ARCED), BOX, BOX, {});
  assert.equal(warnings.length, 0);
  assert.equal(ops.length, 1);
  assert.equal(/[Aa]/.test(ops[0].d), false, "no arc command survives the bake");
  assert.equal(ops[0].d.includes("C"), true, "arcs became cubics");
});

test("transformPathD: arc endpoint exactness, zero-radius line, crammed flags throw", () => {
  const id = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  const d = transformPathDRef("M0 0A5 5 0 0 1 10 0", id);
  assert.equal(/[Aa]/.test(d), false);
  assert.equal(d.endsWith("10 0"), true, "final cubic lands EXACTLY on the authored endpoint");
  assert.equal(transformPathDRef("M0 0A0 5 0 0 1 10 0", id), "M0 0L10 0", "zero radius → line (spec F.6.6)");
  assert.throws(() => transformPathDRef("M0 0A5 5 0 0130 0", id), /crammed/i, "crammed flag syntax fails loudly");
});

test("arcToCubics: slice count and degenerate endpoints match the docblock", () => {
  assert.equal(arcToCubics(0, 0, 5, 5, 0, 0, 1, 10, 0).length, 2, "semicircle → two 90° slices");
  assert.equal(arcToCubics(0, 0, 5, 5, 0, 1, 1, 5, 5).length, 3, "large-arc 270° → three slices");
  assert.deepEqual(arcToCubics(3, 4, 5, 5, 0, 0, 1, 3, 4), [], "identical endpoints → omitted per spec");
});

console.log(`\n${passed} SVG flatten-warning visibility tests passed.`);
