/**
 * PAINT PATH — the widget-specific geometry suite. Plain node, no framework (the
 * suite convention). The data-driven registry sweeps already cover the universal
 * contracts for this widget the moment it registers — handle_constraints_test (its
 * modifier handles round-trip), negative_size_test (its four sign spellings derive
 * identically), universal_effects_test (the effects bundle is injected),
 * row_kinds_test / tool_groups_test / activation_migration_test / creation_modes_test
 * (its rows, tools, activation and creation mode are well-formed). This file pins
 * what is UNIQUE to plugins/paint_path.js: the bezier path construction, the BREAKS
 * that make one widget several strokes, and its ADOPTION of the universal
 * stroke-trim draw-on (emit contract + the legacy trimStart/trimEnd migration).
 *
 * Run: node src/demo_apps/PowerRP/tests/paint_path_test.js
 */
import assert from "node:assert/strict";
import {
  paintPathPlugin, splitSubpaths, cubicSegments, subpathBezierD, pathBezierD,
  sampleCubic, scaledAnchors, withAnchorInsertedNear, paintPathFromWorldPoints,
  MIN_DRAWN_ANCHORS, CURVE_HANDLE_REACH,
  isCurvePoint, withPointCurve, isBreakPoint, withPointBreak, paintPointFieldDisabled,
} from "../plugins/paint_path.js";
import { applyStrokeTrim } from "../render_gpu/ir.js";
import { STROKE_TRIM_KEYS } from "../core/properties.js";
import { withLegacyKeysRenamed } from "../core/document.js";

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log(`  ok  ${name}`); };

// ── BREAKS: one anchor list, several subpaths ────────────────────────────────
test("splitSubpaths breaks at brk >= 0.5 (never before the first anchor)", () => {
  assert.deepEqual(splitSubpaths([[0, 0, 0, 0, 0], [1, 1, 0, 0, 0]]).length, 1);
  const two = splitSubpaths([[0, 0, 0, 0, 0], [1, 1, 0, 0, 0], [2, 2, 0, 0, 1], [3, 3, 0, 0, 0]]);
  assert.equal(two.length, 2);
  assert.deepEqual(two[1], [[2, 2, 0, 0, 1], [3, 3, 0, 0, 0]]);
  // a brk on the FIRST anchor is not a second subpath — there is no first one yet
  assert.equal(splitSubpaths([[0, 0, 0, 0, 1], [1, 1, 0, 0, 0]]).length, 1);
  // a TWEENING brk flips exactly at the midpoint threshold
  assert.equal(splitSubpaths([[0, 0, 0, 0, 0], [1, 1, 0, 0, 0.49]]).length, 1);
  assert.equal(splitSubpaths([[0, 0, 0, 0, 0], [1, 1, 0, 0, 0.5]]).length, 2);
});

test("a break renders as SEVERAL M commands (separate strokes)", () => {
  const anchors = [[0, 0, 0, 0, 0], [100, 0, 0, 0, 0], [200, 0, 0, 0, 1], [300, 0, 0, 0, 0]];
  const exact = pathBezierD(anchors, false);
  assert.equal((exact.match(/M/g) || []).length, 2, "two subpaths → two M in the exact bezier d");
  // Each subpath becomes its own ContourMeasure contour downstream, so the
  // universal stroke-trim windows them independently — no path-level trim here.
});

// ── BEZIER CONSTRUCTION ──────────────────────────────────────────────────────
test("cubicSegments / subpathBezierD build mirrored-handle cubics", () => {
  assert.deepEqual(cubicSegments([[0, 0, 10, 0, 0], [100, 0, 10, 0, 0]]),
    [[[0, 0], [10, 0], [90, 0], [100, 0]]]); // P1 = a+handle, P2 = b−handle
  assert.equal(subpathBezierD([[0, 0, 10, 0, 0], [100, 0, 10, 0, 0]], false), "M0 0 C10 0 90 0 100 0");
  assert.ok(subpathBezierD([[0, 0, 10, 0, 0], [100, 0, 10, 0, 0]], true).endsWith(" Z"), "closed appends Z");
});

test("sampleCubic is the Bernstein form and hits both endpoints", () => {
  const seg = [[0, 0], [0, 0], [10, 0], [10, 0]];
  const pts = sampleCubic(seg, 4);
  assert.equal(pts.length, 5);
  assert.deepEqual(pts[0], [0, 0]);
  assert.deepEqual(pts[4], [10, 0]);
  assert.ok(pts[2][0] > 0 && pts[2][0] < 10, "the midpoint is strictly between the ends");
});

// ── DRAW-ON: the UNIVERSAL stroke-trim adoption ──────────────────────────────
// paint_path no longer windows the stroke itself — it emits ONE full-length
// stroked `path` op and the universal seam (applyStrokeTrim → paint_skia
// ContourMeasure) cuts it. These tests pin the CONTRACT at the emit boundary;
// the pixel-level draw-on is exercised end-to-end by tests/stroke_trim_probe.js.
test("emit: ONE full-length exact-bezier path op, whatever the trim state", () => {
  const s = { ...paintPathPlugin.defaults, w: 300, h: 200 };
  const full = paintPathPlugin.emit(s);
  assert.equal(full.length, 1);
  assert.equal(full[0].op, "path");
  assert.ok(full[0].d.includes("C"), "the whole path draws exact cubic beziers");
  // A trim in STATE does NOT change the emitted `d` — it is stamped by the seam,
  // not baked into the op here. So the geometry is byte-identical to the full case.
  const withTrim = paintPathPlugin.emit({ ...s, strokeEnd: 0.5 });
  assert.equal(withTrim[0].d, full[0].d, "strokeEnd does not alter the emitted path d (the seam trims it)");
  assert.deepEqual(paintPathPlugin.emit({ ...s, strokeWidth: 0, fill: null }), [], "no stroke and no fill emits nothing");
});

test("the seam trims THIS op: applyStrokeTrim stamps strokeEnd onto the emitted stroke", () => {
  const s = { ...paintPathPlugin.defaults, w: 300, h: 200 };
  const [op] = paintPathPlugin.emit(s);
  assert.equal(op.strokeEnd, undefined, "emit itself carries no trim (absent-is-identity)");
  const [stamped] = applyStrokeTrim({ strokeEnd: 0.5 }, [op]);
  assert.equal(stamped.strokeEnd, 0.5, "the ports seam stamps strokeEnd onto the stroked path op");
});

test("BYTE-EQUIVALENT two-op-fill survival: a trimmed + filled path carries the FULL fill", () => {
  // The 35a393a fix (trim cuts the stroke, never the fill) now rides the one-op
  // form: the op carries the WHOLE-path fill; drawPathOp paints it under the
  // separately-windowed stroke. So the emitted `d` (which the fill uses) is the
  // full path even when a trim is active in state.
  const s = { ...paintPathPlugin.defaults, w: 300, h: 200, closed: true, fill: "#3366ff" };
  const fullFill = paintPathPlugin.emit(s)[0].d;
  const trimmed = paintPathPlugin.emit({ ...s, strokeStart: 0.2, strokeEnd: 0.7 })[0];
  assert.equal(trimmed.fill != null && trimmed.fill.length > 0, true, "the fill survives a trim");
  assert.equal(trimmed.d, fullFill, "the op's path (and thus its fill) is the FULL path under any trim window");
});

test("the STROKE-TRIM rows are adopted in the strokeMaterial section (no private trim rows)", () => {
  const keys = paintPathPlugin.inspector.map((r) => r.key);
  for (const k of STROKE_TRIM_KEYS) {
    assert.ok(keys.includes(k), `inspector has the universal ${k} row`);
    const rowDef = paintPathPlugin.inspector.find((r) => r.key === k);
    assert.equal(rowDef.category, "strokeMaterial", `${k} lands in the Stroke Material section`);
  }
  assert.ok(!keys.includes("trimStart") && !keys.includes("trimEnd"), "the private trimStart/trimEnd rows are gone");
  // Defaults must NOT bake the trim keys (absent-is-identity), nor the old pair.
  for (const k of [...STROKE_TRIM_KEYS, "trimStart", "trimEnd"])
    assert.equal(k in paintPathPlugin.defaults, false, `defaults omit ${k}`);
});

test("LEGACY MIGRATION: trimStart/trimEnd rename to strokeStart/strokeEnd, value verbatim", () => {
  const reg = { get: (t) => { if (t === "paint_path") return paintPathPlugin; throw new Error(`unknown ${t}`); } };
  const doc = { slides: [{ delta: { items: { p: { type: "paint_path", trimStart: 0.1, trimEnd: 0.8, stroke: "#e0af68" } } } }] };
  const { doc: out, renamed } = withLegacyKeysRenamed(doc, reg);
  const item = out.slides[0].delta.items.p;
  assert.equal(item.strokeStart, 0.1, "trimStart migrated to strokeStart, value kept");
  assert.equal(item.strokeEnd, 0.8, "trimEnd migrated to strokeEnd, value kept");
  assert.ok(!("trimStart" in item) && !("trimEnd" in item), "the legacy keys are removed");
  assert.equal(renamed.length, 2, "both renames are REPORTED (loud migration, never silent)");
  // An equation value (a keyframed draw-on = t) survives the rename verbatim.
  const animated = { slides: [{ delta: { items: { p: { type: "paint_path", trimEnd: "t" } } } }] };
  assert.equal(withLegacyKeysRenamed(animated, reg).doc.slides[0].delta.items.p.strokeEnd, "t");
  // Idempotent: an already-migrated doc reports nothing.
  assert.equal(withLegacyKeysRenamed(out, reg).renamed.length, 0);
});

// ── EDITING ──────────────────────────────────────────────────────────────────
test("insertPointAt adds a CORNER anchor on the curve without moving the shape", () => {
  const s = { paintPoints: [[0, 0, 0, 0, 0], [1, 0, 0, 0, 0]], w: 100, h: 100 };
  const ins = paintPathPlugin.insertPointAt(s, 50, 6);
  assert.equal(ins.key, "paintPoints");
  assert.deepEqual(ins.value.list, [[0, 0, 0, 0, 0], [0.5, 0, 0, 0, 0], [1, 0, 0, 0, 0]]);
  assert.equal(paintPathPlugin.insertPointAt({ paintPoints: [[0, 0, 0, 0, 0]], w: 100, h: 100 }, 5, 5), null);
});

test("modifierPoints: a POSITION handle and a mirrored BEZIER handle per anchor, both round-trip", () => {
  const s = { ...paintPathPlugin.defaults, w: 300, h: 200 };
  const ids = paintPathPlugin.modifierPoints(s).map((m) => m.id);
  assert.deepEqual(ids, ["a0", "h0", "a1", "h1", "a2", "h2"]);
  for (const id of ["a1", "h0"]) {
    const mp = paintPathPlugin.modifierPoints(s).find((m) => m.id === id);
    const desired = { x: 137, y: 42 };
    const moved = paintPathPlugin.modifierPoints({ ...s, ...mp.apply(s, desired) }).find((m) => m.id === id);
    assert.ok(Math.hypot(moved.x - desired.x, moved.y - desired.y) < 1e-9, `${id} did not land where it was dragged`);
  }
});

test("isGhost / MIN_DRAWN_ANCHORS: fewer than two anchors in every subpath is a ghost", () => {
  assert.equal(MIN_DRAWN_ANCHORS, 2);
  assert.equal(paintPathPlugin.isGhost({ paintPoints: [] }), true);
  assert.equal(paintPathPlugin.isGhost({ paintPoints: [[0, 0, 0, 0, 0]] }), true);
  assert.equal(paintPathPlugin.isGhost({ paintPoints: [[0, 0, 0, 0, 0], [1, 1, 0, 0, 1]] }), true); // a break → two singletons
  assert.equal(paintPathPlugin.isGhost({ paintPoints: [[0, 0, 0, 0, 0], [1, 1, 0, 0, 0]] }), false);
});

test("paintPathFromWorldPoints fits the box and stores corner anchors (the creation constructor)", () => {
  assert.deepEqual(paintPathFromWorldPoints([[10, 20], [110, 20], [110, 120]], false),
    { x: 10, y: 20, w: 100, h: 100, paintPoints: [[0, 0, 0, 0, 0], [1, 0, 0, 0, 0], [1, 1, 0, 0, 0]], closed: false });
  // a flat chain has zero height and every y at the midline (never NaN)
  assert.deepEqual(paintPathFromWorldPoints([[0, 50], [100, 50]], false).paintPoints, [[0, 0.5, 0, 0, 0], [1, 0.5, 0, 0, 0]]);
});

test("withAnchorInsertedNear inserts into the RIGHT subpath after a break", () => {
  // two horizontal strokes; clicking the SECOND one must insert into the second subpath
  const s = { paintPoints: [[0, 0, 0, 0, 0], [1, 0, 0, 0, 0], [0, 1, 0, 0, 1], [1, 1, 0, 0, 0]], w: 100, h: 100 };
  const out = withAnchorInsertedNear(s, 50, 100); // mid second stroke (y = 100 local)
  assert.equal(out.list.length, 5);
  // the new anchor lands between the two second-subpath anchors (storage index 3)
  assert.deepEqual(out.list[3], [0.5, 1, 0, 0, 0]);
  assert.equal(out.list[2][4], 1, "the break flag stays on the anchor that started the second stroke");
});

// ── CURVE / CORNER STATE (the editing UX, F.16–21) ───────────────────────────
test("LINE STAYS A LINE: a corner emits no bezier handle, so a drag moves the point", () => {
  // Two corners (zero handles). modifierPoints must offer ONLY position handles —
  // no coincident h<i> to accidentally grab and sprout a curve (the F.19 bug).
  const corners = { paintPoints: [[0, 0, 0, 0, 0], [1, 1, 0, 0, 0]], w: 100, h: 100 };
  assert.deepEqual(paintPathPlugin.modifierPoints(corners).map((m) => m.id), ["a0", "a1"]);
  // Give point 0 a handle → its h0 appears (a curve point exposes its bezier handle).
  const oneCurve = { paintPoints: [[0, 0, 0.1, 0, 0], [1, 1, 0, 0, 0]], w: 100, h: 100 };
  assert.deepEqual(paintPathPlugin.modifierPoints(oneCurve).map((m) => m.id), ["a0", "h0", "a1"]);
  // The a0 position handle moves the POINT and keeps the zero handle a zero handle.
  const a0 = paintPathPlugin.modifierPoints(corners).find((m) => m.id === "a0");
  assert.deepEqual(a0.apply(corners, { x: 40, y: 60 }).paintPoints[0], [0.4, 0.6, 0, 0, 0]);
});

test("curve handle declares a TRIANGLE shape and a STEM back to its anchor", () => {
  const s = { paintPoints: [[0.2, 0.3, 0.1, 0, 0]], w: 100, h: 100 };
  const h0 = paintPathPlugin.modifierPoints(s).find((m) => m.id === "h0");
  assert.equal(h0.shape, "triangle");
  assert.deepEqual(h0.stem, { x: 20, y: 30 }); // the anchor, in local units
  const a0 = paintPathPlugin.modifierPoints(s).find((m) => m.id === "a0");
  assert.equal(a0.shape, undefined, "an anchor keeps the default (square) — no shape declared");
  assert.equal(a0.stem, undefined, "an anchor has no stem tether");
});

test("isCurvePoint / withPointCurve: toggle the derivative, keeping the tuple all-number", () => {
  assert.equal(isCurvePoint([0, 0, 0, 0, 0]), false);
  assert.equal(isCurvePoint([0, 0, 0.1, 0, 0]), true);
  assert.equal(isCurvePoint([0, 0, 0, -0.2, 1]), true, "hy alone is enough");
  // OFF zeroes the handle (a sharp corner), preserving x/y/brk.
  assert.deepEqual(withPointCurve([0.4, 0.5, 0.1, 0.2, 1], false), [0.4, 0.5, 0, 0, 1]);
  // ON gives a CORNER a default tangent; an already-curved point is untouched.
  assert.deepEqual(withPointCurve([0.4, 0.5, 0, 0, 0], true), [0.4, 0.5, CURVE_HANDLE_REACH, 0, 0]);
  assert.deepEqual(withPointCurve([0.4, 0.5, 0.3, 0, 1], true), [0.4, 0.5, 0.3, 0, 1]);
  // The result is ALWAYS an all-number tuple (the integer-lerp tween law).
  for (const el of [withPointCurve([0, 0, 0, 0, 0], true), withPointCurve([0, 0, 0.1, 0.2, 1], false)])
    assert.ok(el.every((v) => typeof v === "number"), "curve toggle kept the tuple numeric");
});

test("isBreakPoint / withPointBreak: toggle the new-subpath flag as 0/1", () => {
  assert.equal(isBreakPoint([0, 0, 0, 0, 0]), false);
  assert.equal(isBreakPoint([0, 0, 0, 0, 1]), true);
  assert.deepEqual(withPointBreak([0.2, 0.3, 0.1, 0, 0], true), [0.2, 0.3, 0.1, 0, 1]);
  assert.deepEqual(withPointBreak([0.2, 0.3, 0.1, 0, 1], false), [0.2, 0.3, 0.1, 0, 0]);
  assert.ok(withPointBreak([0, 0, 0, 0, 0], true).every((v) => typeof v === "number"));
});

test("paintPointFieldDisabled: a corner's hx/hy fields are inert, position always live", () => {
  assert.equal(paintPointFieldDisabled([0, 0, 0, 0, 0], "hx"), true);
  assert.equal(paintPointFieldDisabled([0, 0, 0, 0, 0], "hy"), true);
  assert.equal(paintPointFieldDisabled([0, 0, 0.1, 0, 0], "hx"), false, "a curve point's handle is editable");
  assert.equal(paintPointFieldDisabled([0, 0, 0, 0, 0], "x"), false);
  assert.equal(paintPointFieldDisabled([0, 0, 0, 0, 0], "brk"), false);
});

test("the CURVE / BREAK handleToggles round-trip through their own isOn", () => {
  const toggles = Object.fromEntries(paintPathPlugin.handleToggles.map((t) => [t.key, t]));
  const corner = [0.1, 0.2, 0, 0, 0];
  // curve: OFF → ON → the point now reads as a curve
  assert.equal(toggles.curve.isOn(corner), false);
  const curved = toggles.curve.set(corner, true);
  assert.equal(toggles.curve.isOn(curved), true);
  assert.equal(toggles.curve.isOn(toggles.curve.set(curved, false)), false);
  // break: OFF → ON
  assert.equal(toggles.break.isOn(corner), false);
  assert.equal(toggles.break.isOn(toggles.break.set(corner, true)), true);
});

console.log(`\npaint_path_test: ${passed} tests passed`);
