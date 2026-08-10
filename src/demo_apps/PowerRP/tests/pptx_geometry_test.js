/**
 * Tests for the DrawingML geometry evaluator (core/pptx/preset_geometry.js).
 * Bare node, no framework (SvelteLib has none). Run:
 *   node src/demo_apps/PowerRP/tests/pptx_geometry_test.js
 *
 * Requires the vendored preset table to exist first:
 *   node src/demo_apps/PowerRP/tests/pptx_dev/vendor_preset_shapes.mjs
 *
 * Assertions are NUMERIC (sampled coordinates within a tolerance), not just
 * "the call didn't throw" -- per the mission brief, a geometry evaluator
 * that produces plausible-looking-but-wrong numbers is a worse failure mode
 * than one that visibly crashes.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  presetShapePath, custGeomPath, evaluateFormula, foldGuides, resolveArg,
  arcToSvgSegments, installPresetDefs,
} from "../core/pptx/preset_geometry.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defsPath = path.join(__dirname, "..", "core", "pptx", "preset_shape_defs.json");
const raw = JSON.parse(readFileSync(defsPath, "utf8"));
installPresetDefs(raw.shapes);

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}
function approx(a, b, eps = 1e-6, msg = "") {
  assert.ok(Math.abs(a - b) < eps, `${msg} ${a} !~ ${b} (eps ${eps})`.trim());
}
/** Parses one SVG path `d` string's coordinate pairs out for numeric
 * assertions, ignoring command letters. ONLY safe on paths with no `A` (arc)
 * commands -- an arc's two flag digits (large-arc, sweep) are bare integers
 * indistinguishable from coordinates once command context is discarded, so
 * this would misalign every number after the first arc. Use `parseCommands`
 * for anything that may contain an arc. */
function extractNumbers(d) {
  return d.match(/-?\d+(?:\.\d+)?(?:e-?\d+)?/g).map(Number);
}
/** Parses one SVG path `d` string into `{cmd, args: number[]}` tokens,
 * command-aware (unlike `extractNumbers`, which flattens every number
 * including arc flags -- ambiguous once an `A` command is present). Handles
 * the letters this module emits: M, L, C, Q, A, Z. */
function parseCommands(d) {
  const out = [];
  const re = /([MLCQAZ])\s*([^MLCQAZ]*)/g;
  let m;
  while ((m = re.exec(d))) {
    const args = (m[2].match(/-?\d+(?:\.\d+)?(?:e-?\d+)?/g) || []).map(Number);
    out.push({ cmd: m[1], args });
  }
  return out;
}
/** Bounding box of every real endpoint/control point in a path -- ARC-SAFE
 * (walks commands so an `A` command's 3 leading non-coordinate numbers --
 * rx, ry, x-axis-rotation -- and 2 flag digits are excluded, only its final
 * endpoint pair counts). Sufficient for the shapes tested here: none uses a
 * rotated ellipse (x-axis-rotation is always 0 per this module's own
 * contract), so no arc's true extremum falls strictly between its endpoints
 * in a way this coarser bbox would miss for a circular arc swept <= 90deg
 * per segment, which is what every tested shape uses. */
function bboxOf(d) {
  const xs = [], ys = [];
  for (const { cmd, args } of parseCommands(d)) {
    if (cmd === "Z") continue;
    if (cmd === "A") {
      // args = [rx, ry, xRot, largeArc, sweep, ex, ey] -- only ex,ey are a point.
      xs.push(args[5]); ys.push(args[6]);
    } else {
      for (let i = 0; i < args.length; i += 2) { xs.push(args[i]); ys.push(args[i + 1]); }
    }
  }
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

console.log(`pptx_geometry_test: loaded ${Object.keys(raw.shapes).length} preset shapes from ${defsPath}`);
console.log(`  vendored from ${raw._source.url} @ ${raw._source.gitRef} (${raw._source.license})`);

// ── formula evaluator unit tests ────────────────────────────────────────────

test("evaluateFormula: all 17 operators, including Office deviations", () => {
  const g = new Map([["w", 100], ["h", 60], ["adj", 30000]]);
  assert.equal(evaluateFormula("val 16667", g), 16667);
  assert.equal(evaluateFormula("+- 10 5 3", g), 12);
  assert.equal(evaluateFormula("+/ 10 6 2", g), 8);
  assert.equal(evaluateFormula("*/ w 1 2", g), 50);
  assert.equal(evaluateFormula("?: 1 5 9", g), 5);
  assert.equal(evaluateFormula("?: -1 5 9", g), 9);
  assert.equal(evaluateFormula("abs -7", g), 7);
  assert.equal(evaluateFormula("min 3 9", g), 3);
  assert.equal(evaluateFormula("max 3 9", g), 9);
  assert.equal(evaluateFormula("pin 0 adj 50000", g), 30000);
  assert.equal(evaluateFormula("pin 0 adj 20000", g), 20000); // clamped high
  assert.equal(evaluateFormula("pin 40000 adj 50000", g), 40000); // clamped low
  // Office deviation: sqrt absolutes its input (ECMA text says sqrt(x)).
  approx(evaluateFormula("sqrt -16", g), 4);
  approx(evaluateFormula("sqrt 16", g), 4);
  // trig args in 60,000ths of a degree; sin 90deg = 1, cos 0deg = 1.
  approx(evaluateFormula("sin 100 5400000", g), 100);
  approx(evaluateFormula("cos 100 0", g), 100);
  approx(evaluateFormula("tan 100 2700000", g), 100); // 45deg (2,700,000 = 45 * 60,000)
  // Office deviation: at2 is true atan2(y,x), not arctan(y/x) -- quadrant-aware.
  approx(evaluateFormula("at2 -1 0", g), 10800000); // atan2(0,-1) = 180deg
  approx(evaluateFormula("at2 0 1", g), 5400000); // atan2(1,0) = 90deg
  assert.equal(evaluateFormula("at2 0 0", g), 0); // the (0,0) special case
  // cat2/sat2: point on an ellipse of half-axis x toward atan2(z,y).
  approx(evaluateFormula("cat2 50 1 0", g), 50); // atan2(0,1)=0deg -> cos=1
  approx(evaluateFormula("sat2 50 0 1", g), 50); // atan2(1,0)=90deg -> sin=1
  // Office deviation: mod is 3D vector magnitude, NOT arithmetic modulo.
  approx(evaluateFormula("mod 3 4 0", g), 5); // 3-4-5 triangle
  approx(evaluateFormula("mod 3 4 12", g), 13); // sqrt(9+16+144) = 13
});

test("evaluateFormula: throws on unknown operator", () => {
  assert.throws(() => evaluateFormula("frobnicate 1 2", new Map()), /unknown formula operator/);
});

test("evaluateFormula: throws on wrong argument count", () => {
  assert.throws(() => evaluateFormula("pin 1 2", new Map()), /expects 3 argument/);
});

test("resolveArg: literal, guide lookup, and the NcdM angle-multiple shorthand", () => {
  assert.equal(resolveArg("100", new Map()), 100);
  assert.equal(resolveArg("-5400000", new Map()), -5400000);
  assert.equal(resolveArg("hc", new Map([["hc", 42]])), 42);
  assert.equal(resolveArg("3cd4", new Map()), 16200000); // 3 * cd4 = 270deg
  assert.throws(() => resolveArg("bogusGuide", new Map()), /unresolved guide reference/);
});

test("foldGuides: sequential fold, reassignment, adjustment overrides", () => {
  // Guides fold IN ORDER and a later same-named <gd> reassigns (gear6's real
  // shape -- see below -- exercises this for real; this is the minimal case).
  const g = foldGuides({}, {}, [["a", "val 5"], ["a", "+- a 3 0"]], 100, 100);
  assert.equal(g.get("a"), 8);
  // avLst default, then instance override layered on top.
  const g2 = foldGuides({ adj: 16667 }, { adj: 30000 }, [["x", "*/ w adj 100000"]], 100, 100);
  assert.equal(g2.get("x"), 30);
  // unknown adjustment name throws rather than silently inserting it.
  assert.throws(() => foldGuides({ adj: 1 }, { nope: 5 }, [], 10, 10), /does not exist on this shape's avLst/);
});

test("arcToSvgSegments: quarter turn, exact half turn, full-turn split", () => {
  // Pen starts at (50,0), stAng=0 -> center solves to (0,0) (cx = x0 - wR*cos(0) = 0).
  // A 90deg CW sweep from angle 0 ends at angle 90deg: (cx+wR*cos(90), cy+hR*sin(90)) = (0, 50).
  const quarter = arcToSvgSegments(50, 0, 50, 50, 0, 5400000); // 90deg CW from angle 0
  assert.equal(quarter.segments.length, 1);
  assert.match(quarter.segments[0], /^A 50,50 0 0,1 /); // not large-arc, sweep=CW
  approx(quarter.endX, 0); approx(quarter.endY, 50);

  // Pen starts at (100,50), stAng=0 -> center (50,50). 180deg sweep ends at angle 180: (0,50).
  const half = arcToSvgSegments(100, 50, 50, 50, 0, 10800000); // exactly 180deg
  assert.equal(half.segments.length, 1);
  assert.match(half.segments[0], /^A 50,50 0 0,1 /); // |swAng|>180 is FALSE at exactly 180
  approx(half.endX, 0, 1e-6); approx(half.endY, 50, 1e-6);

  const full = arcToSvgSegments(100, 50, 50, 50, 0, 21600000); // 360deg, must split
  assert.equal(full.segments.length, 2);
  approx(full.endX, 100, 1e-6); approx(full.endY, 50, 1e-6); // back where it started

  // negative swAng (counter-clockwise, a real observed value per the research doc)
  const ccw = arcToSvgSegments(50, 0, 50, 50, 0, -5400000);
  assert.match(ccw.segments[0], /^A 50,50 0 0,0 /); // sweep-flag 0 = CCW
});

// ── preset shapes: rect / roundRect / ellipse / star5 / pie / gear6 ────────

test("presetShapePath('rect'): exact 4-corner path", () => {
  const { subpaths, textRect } = presetShapePath("rect", {}, 120, 80);
  assert.equal(subpaths.length, 1);
  assert.equal(subpaths[0].d, "M 0,0 L 120,0 L 120,80 L 0,80 Z");
  assert.equal(subpaths[0].fill, "norm");
  assert.equal(subpaths[0].stroke, true);
  assert.deepEqual(textRect, { x: 0, y: 0, w: 120, h: 80 });
});

test("presetShapePath('roundRect'): default + adjusted radius, numeric corner-arc endpoints", () => {
  const w = 200, h = 100;
  // Default adj = 16667 (avLst). ss = min(200,100) = 100. radius x1 = ss*adj/100000 = 16.667.
  const def = presetShapePath("roundRect", {}, w, h);
  assert.equal(def.subpaths.length, 1);
  const d0 = def.subpaths[0].d;
  assert.match(d0, /^M 0,16\.667 A 16\.667,16\.667 0 0,1 /);
  const cmds0 = parseCommands(d0);
  assert.equal(cmds0.map((c) => c.cmd).join(""), "MALALALAZ", "4 rounded corners: move, then 4x (arc, line)");
  const [moveTo, arc1, lnTo1, arc2] = cmds0;
  approx(moveTo.args[0], 0, 0.001); approx(moveTo.args[1], 16.667, 0.001); // start point (left edge, below the corner)
  approx(arc1.args[0], 16.667, 0.001); approx(arc1.args[1], 16.667, 0.001); // arc 1's rx,ry
  approx(arc1.args[5], 16.667, 0.001); approx(arc1.args[6], 0, 0.001); // arc 1's endpoint (top edge, right of the corner)
  approx(lnTo1.args[0], 183.333, 0.001); approx(lnTo1.args[1], 0, 0.001); // lnTo to top-right corner's start
  approx(arc2.args[5], 200, 0.001); approx(arc2.args[6], 16.667, 0.001); // arc 2's endpoint (right edge, top-right rounded corner)

  // Adjusted to max (adj=50000 -> radius = ss/2 = 50): a full stadium/pill shape.
  const adjusted = presetShapePath("roundRect", { adj: 50000 }, w, h);
  const d1 = adjusted.subpaths[0].d;
  assert.match(d1, /^M 0,50 A 50,50 0 0,1 /);
  const b = bboxOf(d1);
  approx(b.minX, 0, 0.01); approx(b.maxX, 200, 0.01);
  approx(b.minY, 0, 0.01); approx(b.maxY, 100, 0.01);
});

test("presetShapePath('ellipse'): 4 quarter-arcs, bbox exactly w x h", () => {
  const w = 140, h = 90;
  const { subpaths } = presetShapePath("ellipse", {}, w, h);
  assert.equal(subpaths.length, 1);
  const d = subpaths[0].d;
  const arcCount = (d.match(/A /g) || []).length;
  assert.equal(arcCount, 4, "ellipse must be exactly 4 quarter-arcs");
  assert.match(d, /^M 0,45 /); // left-middle start point: (0, h/2)
  const b = bboxOf(d);
  approx(b.minX, 0, 1e-6); approx(b.maxX, w, 1e-6);
  approx(b.minY, 0, 1e-6); approx(b.maxY, h, 1e-6);
});

test("presetShapePath('star5'): 10 path points, alternating outer/inner radii", () => {
  const w = 100, h = 100;
  const { subpaths } = presetShapePath("star5", {}, w, h);
  const d = subpaths[0].d;
  const nums = extractNumbers(d);
  const points = [];
  for (let i = 0; i < nums.length; i += 2) points.push({ x: nums[i], y: nums[i + 1] });
  assert.equal(points.length, 10, "a 5-pointed star traces 10 vertices (5 outer tips + 5 inner notches)");
  // The path starts at an OUTER tip (x1,y1 in the preset's own gdLst -- see the
  // vendored definition) and alternates outer/inner from there, so even
  // indices are the 5 outer tips and odd indices the 5 inner notches.
  // star5's own avLst (hf=105146, vf=110557) scales the star SLIGHTLY
  // non-uniformly and shifts its vertical center (svc != vc) -- so this
  // asserts against the star's OWN centroid rather than assuming the naive
  // bbox center (50,50) is the radial center, which it measurably is not.
  const centroid = {
    x: points.reduce((s, p) => s + p.x, 0) / points.length,
    y: points.reduce((s, p) => s + p.y, 0) / points.length,
  };
  const radii = points.map((p) => Math.hypot(p.x - centroid.x, p.y - centroid.y));
  const outer = radii.filter((_, i) => i % 2 === 0); // outer tips
  const inner = radii.filter((_, i) => i % 2 === 1); // inner notches
  const outerAvg = outer.reduce((a, b) => a + b, 0) / outer.length;
  const innerAvg = inner.reduce((a, b) => a + b, 0) / inner.length;
  assert.ok(outerAvg > innerAvg * 1.5, `outer radius (${outerAvg}) must be substantially larger than inner (${innerAvg})`);
  // Each of the 5 outer tips is noticeably farther from the centroid than
  // EVERY inner notch (a looser, still-meaningful per-point check that
  // tolerates star5's own built-in asymmetry rather than demanding perfect
  // radial equidistance, which this preset's avLst deliberately breaks).
  const maxInner = Math.max(...inner);
  for (const r of outer) assert.ok(r > maxInner, `outer point radius ${r} must exceed every inner radius (max ${maxInner})`);
  // Sanity on scale: the star's horizontal extent should span nearly the
  // full 100-wide box (hf=105146% means the tips are pulled slightly OUTSIDE
  // the nominal w -- confirmed against the vendored avLst, not assumed).
  const xs = points.map((p) => p.x);
  assert.ok(Math.max(...xs) - Math.min(...xs) > w * 0.95, "star5 must span nearly the full shape width");
});

test("presetShapePath('pie'): sweep-angle handling, including a >180deg case", () => {
  // adj1=0 (start angle 0), adj2=16200000 (end angle 270deg) is the SHAPE'S
  // OWN avLst DEFAULT -- a >180deg sweep out of the box, which must set the
  // SVG large-arc flag.
  const wideDefault = presetShapePath("pie", {}, 100, 100);
  const dWide = wideDefault.subpaths[0].d;
  assert.match(dWide, /A 50,50 0 1,1 /, "270deg sweep must set the large-arc flag");

  // A narrow, explicit <180deg case: 0 -> 90deg (5400000).
  const narrow = presetShapePath("pie", { adj1: 0, adj2: 5400000 }, 100, 100);
  const dNarrow = narrow.subpaths[0].d;
  assert.match(dNarrow, /A 50,50 0 0,1 /, "90deg sweep must NOT set the large-arc flag");
  // pie starts at (r, vc) = (100, 50) when adj1=0, sweeps to (hc, vc)=(50,50) center via lnTo, then closes.
  const moveTo = parseCommands(dNarrow)[0];
  approx(moveTo.args[0], 100); approx(moveTo.args[1], 50); // moveTo start
});

test("presetShapePath('gear6'): a shape exercising mod/at2/?:/pin formulas together", () => {
  // gear6's gdLst is 97 entries deep and chains pin -> at2 -> cos/sin -> mod
  // -> */ repeatedly (see the vendored JSON) -- this is the "does the whole
  // formula language compose correctly across ~100 sequential guides"
  // regression the mission brief asks for, not just a per-operator unit test.
  const { subpaths, textRect } = presetShapePath("gear6", {}, 100, 100);
  assert.equal(subpaths.length, 1);
  const d = subpaths[0].d;
  assert.ok(d.startsWith("M "), "gear6 path must start with a moveTo");
  assert.ok(d.trim().endsWith("Z"), "gear6 path must be closed");
  const b = bboxOf(d);
  // A gear inscribed near a 100x100 box: plausible bbox, not degenerate.
  assert.ok(b.maxX - b.minX > 60 && b.maxX - b.minX <= 100.5, `gear6 width ${b.maxX - b.minX} implausible`);
  assert.ok(b.maxY - b.minY > 60 && b.maxY - b.minY <= 100.5, `gear6 height ${b.maxY - b.minY} implausible`);
  assert.ok(textRect === null || (textRect.w > 0 && textRect.h > 0));
});

// ── custGeomPath: the real freeform from the user's deck (slide16, "Freeform 11") ──
//
// Extracted verbatim from .frenzy/r10/primary_unzipped/ppt/slides/slide16.xml's
// <a:custGeom> block (research_10's "the deck's only custGeom shape"): a
// 3-point open polyline (moveTo, lnTo, lnTo -- no <a:close/>), with every
// coordinate routed through gdLst guides named connsiteX0/Y0/X1/Y1/X2/Y2
// rather than authored as bare literals in the path itself (PowerPoint's own
// "connection site" gdLst convention for a hand-drawn freeform). Shape ext
// (cx=4238625, cy=2505075) exactly matches the path's own declared w/h, so
// the scale factor is 1:1 -- this test still passes w/h explicitly (rather
// than reusing the path's own w/h) to exercise the scaling path, matching
// how a real slide shape (whose xfrm ext can differ from the path's local
// w/h) would call this function.

const SLIDE16_FREEFORM_CUSTGEOM = {
  gdLst: [
    ["connsiteX0", "*/ 0 w 4238625"],
    ["connsiteY0", "*/ 2505075 h 2505075"],
    ["connsiteX1", "*/ 0 w 4238625"],
    ["connsiteY1", "*/ 0 h 2505075"],
    ["connsiteX2", "*/ 4238625 w 4238625"],
    ["connsiteY2", "*/ 0 h 2505075"],
  ],
  rect: { l: "l", t: "t", r: "r", b: "b" },
  pathLst: [
    {
      w: 4238625, h: 2505075,
      commands: [
        { cmd: "moveTo", x: "connsiteX0", y: "connsiteY0" },
        { cmd: "lnTo", x: "connsiteX1", y: "connsiteY1" },
        { cmd: "lnTo", x: "connsiteX2", y: "connsiteY2" },
      ],
    },
  ],
};

test("custGeomPath: real slide16 freeform -- non-empty, plausible bbox, matches the authored 3-point polyline", () => {
  const w = 4238625, h = 2505075; // the shape's own xfrm ext -- identical to the path's local w/h (1:1 scale)
  const { subpaths, textRect } = custGeomPath(SLIDE16_FREEFORM_CUSTGEOM, w, h);
  assert.equal(subpaths.length, 1);
  const d = subpaths[0].d;
  assert.equal(d, "M 0,2505075 L 0,0 L 4238625,0", "no <a:close/> in the source -- this is deliberately an OPEN polyline, not closed");
  const b = bboxOf(d);
  approx(b.minX, 0); approx(b.maxX, 4238625);
  approx(b.minY, 0); approx(b.maxY, 2505075);
  assert.deepEqual(textRect, { x: 0, y: 0, w: 4238625, h: 2505075 });
});

test("custGeomPath: independent per-path w/h scaling (a path authored smaller than the shape box)", () => {
  // Same 3-point shape authored in a 10x10 local space, scaled into a 100x50 box.
  const custGeom = {
    pathLst: [{
      w: 10, h: 10,
      commands: [
        { cmd: "moveTo", x: 0, y: 10 },
        { cmd: "lnTo", x: 0, y: 0 },
        { cmd: "lnTo", x: 10, y: 0 },
      ],
    }],
  };
  const { subpaths } = custGeomPath(custGeom, 100, 50);
  assert.equal(subpaths[0].d, "M 0,50 L 0,0 L 100,0");
});

test("custGeomPath: throws on empty pathLst", () => {
  assert.throws(() => custGeomPath({ pathLst: [] }, 10, 10), /no pathLst/);
});

// ── loud failure on malformed / unknown input ───────────────────────────────

test("presetShapePath: unknown preset name throws", () => {
  assert.throws(() => presetShapePath("thisIsNotARealPreset", {}, 10, 10), /unknown preset shape/);
});

test("presetShapePath / custGeomPath: unknown path command throws with a useful message", () => {
  const custGeom = { pathLst: [{ w: 10, h: 10, commands: [{ cmd: "teleportTo", x: 0, y: 0 }] }] };
  assert.throws(() => custGeomPath(custGeom, 10, 10), /unknown path command "teleportTo"/);
});

test("evaluateFormula: missing guide reference throws with a useful message (not silent 0/NaN)", () => {
  assert.throws(
    () => evaluateFormula("*/ w undeclaredGuide 2", new Map([["w", 100]])),
    /unresolved guide reference "undeclaredGuide"/
  );
});

test("emitPathCommands (via presetShapePath): degenerate zero-size path throws rather than dividing by zero", () => {
  const custGeom = { pathLst: [{ w: 0, h: 10, commands: [{ cmd: "moveTo", x: 0, y: 0 }] }] };
  assert.throws(() => custGeomPath(custGeom, 10, 10), /degenerate path coordinate space/);
});

// ── coverage sweep: every vendored preset shape must at least COMPILE ──────
// (numeric correctness for the six above; this sweep is breadth -- every
// preset's OWN avLst defaults must fold and emit without throwing).

test("coverage sweep: every vendored preset shape compiles with its own default adjustments", () => {
  const names = Object.keys(raw.shapes);
  const failures = [];
  for (const name of names) {
    try {
      const { subpaths } = presetShapePath(name, {}, 100, 100);
      if (subpaths.length === 0) failures.push({ name, error: "produced zero subpaths" });
      for (const sp of subpaths) {
        if (typeof sp.d !== "string" || sp.d.length === 0) failures.push({ name, error: "empty path data" });
      }
    } catch (err) {
      failures.push({ name, error: err.message });
    }
  }
  console.log(`  coverage: ${names.length - failures.length}/${names.length} preset shapes compiled to non-empty SVG path data at their own default adjustments`);
  if (failures.length > 0) {
    console.log("  preset shapes that FAILED to compile (coverage report, not hidden):");
    for (const f of failures) console.log(`    - ${f.name}: ${f.error}`);
  }
  // This sweep REPORTS failures (visible above) rather than asserting zero --
  // the mission brief explicitly asks for a coverage report, not a hard gate,
  // since some presets may use guide/adjustment shapes not yet observed in
  // the six hand-picked shapes above. See the final summary line for the count.
  globalThis.__pptxCoverageFailures = failures;
});

console.log(`\npptx_geometry_test: ${passed} test(s) passed`);
const failures = globalThis.__pptxCoverageFailures ?? [];
console.log(`pptx_geometry_test: coverage sweep -- ${Object.keys(raw.shapes).length - failures.length}/${Object.keys(raw.shapes).length} preset shapes compile cleanly`);
if (failures.length > 0) {
  console.log(`pptx_geometry_test: ${failures.length} preset shape(s) did not compile -- see list above`);
}
