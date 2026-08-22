/**
 * Tests for the PER-SUBPATH PAINT MODEL and the arcTo ANGLE CONVENTION —
 * workstream PPTXPAINT's two defect classes. Bare node, no framework. Run:
 *   node src/demo_apps/PowerRP/tests/pptx_subpath_paint_test.js
 *
 * WHY THIS FILE EXISTS. The evaluator has always returned `{d, fill, stroke}`
 * per subpath and `tests/pptx_geometry_test.js` has always pinned that it does
 * — but NOTHING CONSUMED THEM. `plugins/pptx_preset.js` joined every subpath
 * into one `d` and painted one fill + one stroke, which is correct for the 118
 * single-subpath presets and wrong for the other 69 (37% of the table): 95
 * `fill="none"` detail lines were flood-filled, 52 `stroke=false` silhouettes
 * were outlined, and 33 darken/lighten 3D faces were painted flat. The user's
 * report was "a lot of these shapes just look very broken".
 *
 * So the assertions here are deliberately about CONSUMPTION, not availability:
 * a test that the evaluator still returns the flags would have stayed green
 * through the entire lifetime of the bug.
 *
 * THE REFERENCE IS LIBREOFFICE, MEASURED. The shade constants and the paint
 * ORDER below are not read off a spec — ECMA-376 declines to define either —
 * they were extracted from LibreOffice's own headless render of all 187 shapes
 * (`soffice --headless --convert-to pdf`, then reading the vector fills and the
 * raw content-stream operator order out of the PDF). See the docblocks in
 * core/pptx/preset_geometry.js and plugins/pptx_preset.js for the sources.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  presetShapePath, installPresetDefs, shadeSubpathFill, ellipseParametricAngle,
  foldGuides, resolveArg,
} from "../core/pptx/preset_geometry.js";
import { pptxPresetPlugin as P } from "../plugins/pptx_preset.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFS = JSON.parse(readFileSync(
  path.join(__dirname, "..", "core", "pptx", "preset_shape_defs.json"), "utf8")).shapes;
installPresetDefs(DEFS);

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}
function approx(a, b, eps = 1e-6, msg = "") {
  assert.ok(Math.abs(a - b) < eps, `${msg} ${a} !~ ${b} (eps ${eps})`.trim());
}

/** The plugin's emit() for one preset at its own default adjustments, reduced
 *  to the path ops (effects are all-off, so the wrap is pass-through). */
function paintOps(preset, state = {}) {
  const s = { ...P.defaults, preset, adj: {}, w: 200, h: 200, ...state };
  return P.emit(s, null, { scale: 1 }).filter((o) => o.op === "path");
}
/** A parsed paint back to a "#rrggbb" string, for readable assertions. */
function hexOf(paint) {
  if (paint === null || paint === undefined) return null;
  return "#" + paint.slice(0, 3).map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("");
}
const round6 = (v) => Math.round(v * 1e6) / 1e6;
// The arc walker folds guides through the evaluator's OWN functions rather than
// reimplementing them, so it can only disagree with the module under test about
// the arc convention — which is the one thing it is measuring.
const foldGuidesFor = (def, w, h) => foldGuides(def.avLst, {}, def.gdLst, w, h);
const resolveIn = (token, guides) => resolveArg(token, guides);

// ── THE FLAGS ARE CONSUMED ──────────────────────────────────────────────────

test('a fill="none" subpath produces NO fill op (it is a stroke-only detail line)', () => {
  // bentConnector3 is ONE subpath, fill="none", stroke defaulted true: a bare
  // polyline. Under the joined path it was flood-filled into a solid triangle.
  const decl = DEFS.bentConnector3.pathLst;
  assert.equal(decl.length, 1);
  assert.equal(decl[0].fill, "none");

  const ops = paintOps("bentConnector3");
  assert.equal(ops.length, 1, "one subpath, stroke-only -> exactly one op");
  assert.equal(ops[0].fill, null, "a none-filled subpath must carry NO fill");
  assert.notEqual(ops[0].stroke, null, "...but it must still be stroked");
});

test('a stroke=false subpath produces NO stroke op (it is a fill-only silhouette)', () => {
  // can: [norm/stroke=false, lighten/stroke=false, none/stroke=true].
  const ops = paintOps("can");
  const stroked = ops.filter((o) => o.stroke !== null);
  assert.equal(stroked.length, 1, "only the one stroke=true subpath may be stroked");
  const filled = ops.filter((o) => o.fill !== null);
  assert.equal(filled.length, 2, "both fill-bearing subpaths are filled");
  for (const o of filled) assert.equal(o.stroke, null, "a fill-only face carries no outline");
});

test("every one of the 187 presets honours its own declared flags, op-for-op", () => {
  // The whole-table version of the two tests above: for each preset, the op
  // counts must equal the DECLARED counts, so a future evaluator change that
  // drops or invents a subpath is caught here rather than by eye on a sheet.
  let checked = 0;
  for (const name of Object.keys(DEFS)) {
    const { subpaths } = presetShapePath(name, {}, 200, 200, DEFS);
    const wantFills = subpaths.filter((sp) => sp.fill !== "none").length;
    const wantStrokes = subpaths.filter((sp) => sp.stroke).length;
    const ops = paintOps(name);
    assert.equal(ops.filter((o) => o.fill !== null).length, wantFills, `${name}: fill op count`);
    assert.equal(ops.filter((o) => o.stroke !== null).length, wantStrokes, `${name}: stroke op count`);
    checked++;
  }
  assert.equal(checked, 187);
  console.log(`      ${checked}/187 presets: fill/stroke op counts match their declared flags`);
});

test("a zero strokeWidth suppresses every stroke op, on a multi-subpath shape too", () => {
  const ops = paintOps("cube", { strokeWidth: 0 });
  assert.ok(ops.length > 0, "the fills still draw");
  assert.equal(ops.filter((o) => o.stroke !== null).length, 0);
});

// ── THE SHADE FACTORS ───────────────────────────────────────────────────────

test("shadeSubpathFill: the four modifiers match LibreOffice's own output bytes", () => {
  // MEASURED: LibreOffice's PDF of this table, with the widget's #7dcfff fill,
  // writes exactly these colours for cube/bevel/can/actionButtonHome faces.
  assert.equal(shadeSubpathFill("#7dcfff", "norm"), "#7dcfff");
  assert.equal(shadeSubpathFill("#7dcfff", "darken"), "#4b7c99");       // c * 0.6
  assert.equal(shadeSubpathFill("#7dcfff", "darkenLess"), "#64a5cc");   // c * 0.8
  assert.equal(shadeSubpathFill("#7dcfff", "lighten"), "#b1e2ff");      // c + (255-c) * 0.4
  assert.equal(shadeSubpathFill("#7dcfff", "lightenLess"), "#97d8ff");  // c + (255-c) * 0.2
});

test("shadeSubpathFill: truncates rather than rounds (the last code value)", () => {
  // 0xCF * 0.8 = 165.6. LibreOffice writes 0xA5 (165), not 0xA6 (166), because
  // its Color takes a sal_uInt8 and the double->byte conversion truncates.
  // Rounding disagrees on exactly this channel, in two of the four modes.
  assert.equal(shadeSubpathFill("#00cf00", "darkenLess").slice(3, 5), "a5");
  // lightenLess of 0xCF = 207*0.8 + 51 = 216.6 -> 0xD8 truncated, 0xD9 rounded.
  assert.equal(shadeSubpathFill("#00cf00", "lightenLess").slice(3, 5), "d8");
});

test("shadeSubpathFill: alpha survives, non-hex passes through, none/unknown throw", () => {
  assert.equal(shadeSubpathFill("#7dcfff80", "darken"), "#4b7c9980", "alpha is not shaded");
  const gradient = { type: "linear" };
  assert.equal(shadeSubpathFill(gradient, "darken"), gradient, "a non-hex paint is returned by identity");
  // "none" is the ABSENCE of a fill, not a modification of one: silently
  // returning the base colour is exactly the flood-fill defect this fixes.
  assert.throws(() => shadeSubpathFill("#7dcfff", "none"), /must not be filled/);
  assert.throws(() => shadeSubpathFill("#7dcfff", "bogus"), /unknown path fill mode/);
});

test("cube paints three DIFFERENT shades of one widget fill, then its outline", () => {
  const ops = paintOps("cube", { fill: "#7dcfff" });
  assert.equal(ops.length, 4, "3 shaded faces + 1 outline");
  assert.deepEqual(ops.slice(0, 3).map((o) => hexOf(o.fill)),
    ["#7dcfff", "#64a5cc", "#97d8ff"], "norm, darkenLess, lightenLess — LibreOffice's own three");
  assert.equal(ops[3].fill, null, "the last op is the stroke-only outline");
  assert.notEqual(ops[3].stroke, null);
});

test("the shade tracks the widget's fill rather than being baked", () => {
  const ops = paintOps("cube", { fill: "#808080" });
  assert.equal(hexOf(ops[0].fill), "#808080");
  assert.equal(hexOf(ops[1].fill), "#666666", "darkenLess of #808080 = 128*0.8 = 102");
});

// ── THE PAINT ORDER ─────────────────────────────────────────────────────────

test("ALL fills precede ALL strokes (LibreOffice's sort-filled-objects-to-back)", () => {
  for (const name of ["cube", "can", "bevel", "ribbon", "horizontalScroll"]) {
    const kinds = paintOps(name).map((o) => (o.fill !== null ? "F" : "S"));
    const firstStroke = kinds.indexOf("S");
    if (firstStroke === -1) continue;
    assert.ok(!kinds.slice(firstStroke).includes("F"),
      `${name}: a fill follows a stroke (${kinds.join("")})`);
  }
});

test("chartX: the fill declared SECOND is painted FIRST, so the X stays visible", () => {
  // THE TRAP. chartX/chartPlus/chartStar declare their stroke-only diagonals
  // FIRST and the filled square SECOND. In declaration order the square covers
  // the diagonals and the shape renders as a blank box. LibreOffice's raw PDF
  // content stream for chartX emits the blue fill (f*) BEFORE the two strokes
  // (S S) — so the correct order is not the declared one.
  const decl = DEFS.chartX.pathLst;
  assert.equal(decl[0].fill, "none", "the diagonals are declared first");
  assert.equal(decl[1].stroke, false, "the square is declared second");

  const ops = paintOps("chartX");
  assert.equal(ops.length, 2);
  assert.equal(ops[0].stroke, null, "the SQUARE paints first");
  assert.notEqual(ops[0].fill, null);
  assert.equal(ops[1].fill, null, "the DIAGONALS paint second, on top");
  assert.notEqual(ops[1].stroke, null);
  // and the op order is genuinely reversed relative to the declaration
  assert.equal(ops[0].d, presetShapePath("chartX", {}, 200, 200, DEFS).subpaths[1].d);
});

test("every fill op is evenodd — verified against LibreOffice, not assumed", () => {
  // Every fill in LibreOffice's PDF of all 187 shapes carries even_odd=true,
  // including the ring/counter shapes (donut, sun) the rule matters for.
  for (const name of ["donut", "sun", "cube", "frame", "roundRect"])
    for (const o of paintOps(name)) assert.equal(o.fillRule, "evenodd", name);
});

// ── THE ARC ANGLE CONVENTION ────────────────────────────────────────────────

test("ellipseParametricAngle: identity on the axes and on circles, skewed between", () => {
  const deg = (d) => d * 60000;
  approx(ellipseParametricAngle(50, 50, deg(45)), Math.PI / 4, 1e-12, "a circle is unchanged");
  for (const d of [0, 90, 180, 270])
    approx(ellipseParametricAngle(100, 50, deg(d)), (d * Math.PI) / 180, 1e-12, `${d}deg is on an axis`);
  // a 2:1 ellipse at 45deg: tan t = 2 * tan 45 = 2
  approx(ellipseParametricAngle(100, 50, deg(45)), Math.atan2(2, 1), 1e-12);
  // degenerate radii fall back to the raw angle rather than collapsing to 0
  approx(ellipseParametricAngle(0, 50, deg(45)), Math.PI / 4, 1e-12);
});

test("stAng IS the geometric angle: atan2 of (start - centre) returns it back", () => {
  // THE DISCRIMINATING PROPERTY. Under the correct convention the start point
  // is where the ray at stAng crosses the ellipse, so recovering the angle from
  // the solved centre returns stAng exactly. Under the raw-parametric reading
  // it does not, for any non-quadrant angle on a non-circular ellipse.
  const wR = 300, hR = 100, x0 = 100, y0 = 50;
  for (const degrees of [30, 45, 60, 123, 200, 310]) {
    const stAng = degrees * 60000;
    const t = ellipseParametricAngle(wR, hR, stAng);
    const cx = x0 - wR * Math.cos(t), cy = y0 - hR * Math.sin(t);
    const recovered = Math.atan2(y0 - cy, x0 - cx) * (180 / Math.PI);
    const wanted = ((degrees % 360) + 360) % 360;
    const got = ((recovered % 360) + 360) % 360;
    approx(got, wanted, 1e-9, `stAng ${degrees}deg must come back out`);
  }
});

test("curvedRightArrow's arcs are CONCENTRIC — the shape's own two centres", () => {
  // The reported symptom: consecutive arcs that must share a centre resolved
  // 77.4 units apart, and the error compounded into self-intersecting spaghetti.
  // curvedRightArrow is built from arcs about exactly TWO centres; every one of
  // its eight arcs must land on one of them.
  const centres = arcCentres("curvedRightArrow");
  assert.equal(centres.length, 8, "curvedRightArrow draws eight arcs");
  const distinct = [];
  for (const c of centres)
    if (!distinct.some((d) => Math.hypot(d.x - c.x, d.y - c.y) < 1e-6)) distinct.push(c);
  assert.equal(distinct.length, 2,
    `expected 2 concentric centres, got ${distinct.length}: ${JSON.stringify(distinct)}`);
});

test("the correction is INERT on quadrant-only shapes (no silent geometry churn)", () => {
  // leftBrace, can and blockArc use axis angles only, so both conventions agree
  // and their output must be byte-identical to the pre-correction tree. This is
  // what bounds the blast radius of the arc fix to the 8 shapes that needed it.
  for (const name of ["leftBrace", "can", "blockArc"])
    for (const c of arcCentres(name))
      for (const v of [c.x, c.y])
        assert.ok(Number.isFinite(v) && Math.abs(v - Math.round(v * 1e6) / 1e6) < 1e-9, name);
  // the real assertion: every centre is one the RAW convention also produces
  for (const name of ["leftBrace", "can", "blockArc"]) {
    const corrected = arcCentres(name);
    const raw = arcCentres(name, true);
    assert.equal(corrected.length, raw.length, name);
    corrected.forEach((c, i) => {
      approx(c.x, raw[i].x, 1e-9, `${name} arc ${i} cx`);
      approx(c.y, raw[i].y, 1e-9, `${name} arc ${i} cy`);
    });
  }
});

/**
 * Every arc centre one preset's paths resolve, in draw order — walking the
 * commands the same way `emitPathCommands` does. `rawConvention` reproduces the
 * PRE-FIX behaviour (stAng read as a parametric angle) so a test can assert the
 * two conventions agree where they must.
 */
function arcCentres(preset, rawConvention = false) {
  const RAD = Math.PI / (180 * 60000);
  const def = DEFS[preset];
  const W = 200, H = 200;
  const guides = foldGuidesFor(def, W, H);
  const centres = [];
  for (const p of def.pathLst) {
    const pw = p.w ?? W, ph = p.h ?? H;
    const sx = W / pw, sy = H / ph;
    let x = 0, y = 0;
    for (const c of p.commands) {
      const r = (t) => resolveIn(String(t), guides);
      if (c.cmd === "moveTo" || c.cmd === "lnTo" || c.cmd === "cubicBezTo" || c.cmd === "quadBezTo") {
        x = r(c.x) * sx; y = r(c.y) * sy;
      } else if (c.cmd === "arcTo") {
        const wR = r(c.wR) * sx, hR = r(c.hR) * sy, st = r(c.stAng), sw = r(c.swAng);
        const t0 = rawConvention ? st * RAD : ellipseParametricAngle(wR, hR, st);
        const cx = x - wR * Math.cos(t0), cy = y - hR * Math.sin(t0);
        centres.push({ x: round6(cx), y: round6(cy) });
        const t1 = rawConvention ? (st + sw) * RAD : ellipseParametricAngle(wR, hR, st + sw);
        x = cx + wR * Math.cos(t1); y = cy + hR * Math.sin(t1);
      }
    }
  }
  return centres;
}

// ── THE MORPH PAYLOAD ───────────────────────────────────────────────────────

test("morphPaths carries each subpath's OWN paint, and marks only the true ones", () => {
  const s = { ...P.defaults, preset: "cube", adj: {}, w: 200, h: 200 };
  const payload = P.morphPaths(s);
  const paints = payload.subpaths.map((sp) => sp.paint).filter(Boolean);
  assert.ok(paints.length > 0);
  const fills = new Set(paints.map((p) => p.fill));
  assert.ok(fills.size >= 3, `a cube's faces must not all share one fill, got ${[...fills]}`);
  assert.ok(fills.has("#64a5cc"), "the darkenLess face travels with its shaded colour");
  // A stroke-only piece carries NO fill — handing it the widget fill would
  // flood-fill a detail line mid-morph, the defect this workstream removed.
  assert.ok(paints.some((p) => p.fill === null), "the outline piece carries no fill");
});

test("a single-subpath preset's morph payload is UNCHANGED (still state-inked)", () => {
  // The 118 ordinary presets must be byte-identical to before, mark included —
  // render_gpu/ports.js rereads a morph's ink from state only when every piece
  // is marked, and that reread is correct exactly when the ink IS state's.
  const s = { ...P.defaults, preset: "roundRect", adj: {}, w: 200, h: 200 };
  const payload = P.morphPaths(s);
  const marks = payload.subpaths.map((sp) => sp.paint && sp.paint.__statePaint);
  assert.ok(marks.every(Boolean), "every piece of a plain shape is state-inked");
  assert.equal(payload.subpaths[0].paint.fill, s.fill);
});

test("a SHADED shape's payload is deliberately NOT state-inked", () => {
  // The other half of the rule, stated as an assertion because it is a
  // behaviour change: a cube has no single state colour that describes it, so
  // marking it would let ports.js repaint all three faces flat mid-morph.
  const s = { ...P.defaults, preset: "cube", adj: {}, w: 200, h: 200 };
  const marked = P.morphPaths(s).subpaths.map((sp) => sp.paint && sp.paint.__statePaint);
  assert.ok(!marked.every(Boolean), "a shaded shape must not claim its ink is state's");
});

console.log(`\npptx_subpath_paint_test: ${passed} test(s) passed`);
