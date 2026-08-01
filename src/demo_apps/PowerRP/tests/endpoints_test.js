/**
 * core/endpoints.js tests — the shared endpoint-pair capability (bare node,
 * no framework — suite conventions). Covers the pure functions, the hooks
 * factory, and the CONTRACT that both arrow plugins consume it (the hooks
 * behave identically across plugins by construction — the one-home rule).
 */

import assert from "node:assert/strict";
import {
  SHAFT_GRAB_PAD, SHAFT_PULLBACK, endpointEditPoints, endpointMoveBy, endpointClosestToward,
  hitsShaft, endpointPairHooks, HEAD_SHAPES, HEAD_SHAPE_LABELS, headModeSplit, headTriangle, headDrawing, arrowHeads,
  dashedSpans, CONNECTOR_DASH_ROWS,
} from "../core/endpoints.js";
import { arrowPlugin } from "../plugins/arrow.js";
import { opHasMaterialStroke } from "../render_gpu/ir.js";
import { fancyArrowPlugin } from "../plugins/fancy_arrow.js";
import { elbowArrowPlugin } from "../plugins/elbow_arrow.js";
import { curvedArrowPlugin } from "../plugins/curved_arrow.js";

let passed = 0;
function test(name, fn) {
  fn();
  console.log(`  ok  ${name}`);
  passed += 1;
}

const STATE = { from: { x: 1, y: 2 }, to: { x: 3, y: 4 } };

// ── pure functions ─────────────────────────────────────────────────────────

test("endpointEditPoints: one handle descriptor per endpoint, in key order", () => {
  assert.deepEqual(endpointEditPoints(STATE), [
    { key: "from", x: 1, y: 2 },
    { key: "to", x: 3, y: 4 },
  ]);
});

test("endpointMoveBy: every free coordinate translates", () => {
  assert.deepEqual(endpointMoveBy({ from: { x: 0, y: 0 }, to: { x: 10, y: 20 } }, 5, 2), [
    [["from", "x"], 5], [["from", "y"], 2], [["to", "x"], 15], [["to", "y"], 22],
  ]);
});

test("endpointMoveBy: equation-bound coordinates stay anchored", () => {
  assert.deepEqual(endpointMoveBy({ from: { x: 0, y: 0 }, to: { x: 10, y: "@c1_tm.y" } }, 5, 2), [
    [["from", "x"], 5], [["from", "y"], 2], [["to", "x"], 15],
  ]);
});

test("endpointMoveBy: fully bound → no pairs (shaft drag is a no-op)", () => {
  assert.deepEqual(endpointMoveBy({ from: { x: "@a.x", y: "@a.y" }, to: { x: "@b.x", y: "@b.y" } }, 5, 2), []);
});

test("endpointClosestToward: each endpoint aims at the other; non-endpoints null", () => {
  assert.deepEqual(endpointClosestToward(STATE, ["from", "x"]), { x: 3, y: 4 });
  assert.deepEqual(endpointClosestToward(STATE, ["to", "y"]), { x: 1, y: 2 });
  assert.equal(endpointClosestToward(STATE, ["width"]), null);
});

test("hitsShaft: radius + SHAFT_GRAB_PAD around the segment, in and out", () => {
  const s = { from: { x: 0, y: 0 }, to: { x: 10, y: 0 } };
  assert.equal(hitsShaft(s, 5, 3, 0), true); // 3 ≤ 0 + pad
  assert.equal(hitsShaft(s, 5, SHAFT_GRAB_PAD + 2, 2), true); // exactly at radius+pad
  assert.equal(hitsShaft(s, 5, 9, 0), false); // 9 > pad
});

// ── hooks factory ──────────────────────────────────────────────────────────

test("endpointPairHooks: hooks delegate to the pure functions", () => {
  const hooks = endpointPairHooks();
  assert.deepEqual(hooks.editPoints({ state: STATE }), endpointEditPoints(STATE));
  assert.deepEqual(hooks.moveBy(STATE, 1, 1), endpointMoveBy(STATE, 1, 1));
  assert.deepEqual(hooks.closestToward(STATE, ["from", "x"]), endpointClosestToward(STATE, ["from", "x"]));
});

// ── plugin wiring (the one-home contract) ──────────────────────────────────

test("arrow + fancy arrow consume the shared hooks with identical behavior", () => {
  const mixed = { from: { x: 0, y: 0 }, to: { x: 10, y: "@c1_tm.y" } };
  for (const plugin of [arrowPlugin, fancyArrowPlugin]) {
    assert.deepEqual(plugin.editPoints({ state: STATE }), endpointEditPoints(STATE), plugin.type);
    assert.deepEqual(plugin.moveBy(mixed, 5, 2), endpointMoveBy(mixed, 5, 2), plugin.type);
    assert.deepEqual(plugin.closestToward(STATE, ["to", "x"]), { x: 1, y: 2 }, plugin.type);
  }
});

test("plugins keep their own hit tests but share the shaft pad", () => {
  // Basic arrow: strokeWidth 3 shaft on y=0; a point 7px off is inside 3+pad, 9px is out.
  const node = { state: { from: { x: 0, y: 0 }, to: { x: 100, y: 0 }, strokeWidth: 3 } };
  assert.equal(arrowPlugin.hitTestWorld(node, 50, 7), true);
  assert.equal(arrowPlugin.hitTestWorld(node, 50, 9), false);
  // Fancy arrow: hairline shaft (widths ~0) still grabbable within the pad.
  const fs = {
    from: { x: 0, y: 0 }, to: { x: 100, y: 0 },
    tipLength: 15, tipWidth: 30, tipDimple: 5, startWidth: 1, endWidth: 1,
  };
  assert.equal(fancyArrowPlugin.hitTestWorld({ state: fs }, 50, 5), true);
  assert.equal(fancyArrowPlugin.hitTestWorld({ state: fs }, 50, 20), false);
});

// ── head SHAPES / head geometry (todo #231: per-end head shapes) ────────────

test("HEAD_SHAPES: derived from the generator table, every shape labelled", () => {
  assert.equal(HEAD_SHAPES[0], "none", "the empty decoration sorts first");
  // The label gate in core/endpoints.js throws at IMPORT if these disagree, so
  // reaching this line already proves it; asserted anyway so the intent is
  // readable here and a future weakening of that gate is caught.
  assert.deepEqual(HEAD_SHAPES.filter((s) => !(s in HEAD_SHAPE_LABELS)), []);
  assert.deepEqual(Object.keys(HEAD_SHAPE_LABELS).filter((s) => !HEAD_SHAPES.includes(s)), []);
});

test("headModeSplit: the retired enum's four values, and null for anything else", () => {
  assert.deepEqual(headModeSplit("none"), { headStart: "none", headEnd: "none" });
  assert.deepEqual(headModeSplit("start"), { headStart: "triangle", headEnd: "none" });
  assert.deepEqual(headModeSplit("end"), { headStart: "none", headEnd: "triangle" });
  assert.deepEqual(headModeSplit("both"), { headStart: "triangle", headEnd: "triangle" });
  assert.equal(headModeSplit("= t"), null, "an equation cannot be split across two ends");
  assert.equal(headModeSplit(undefined), null);
});

test("headDrawing: a typo THROWS rather than silently drawing nothing", () => {
  assert.throws(() => headDrawing("triangel", { x: 1, y: 0 }, { x: 0, y: 0 }, 14, 12), /unknown head shape "triangel"/);
});

test("headDrawing: every shape is drawable, and no two draw the same thing", () => {
  const seen = new Map();
  for (const shape of HEAD_SHAPES) {
    const drawing = headDrawing(shape, { x: 100, y: 0 }, { x: 0, y: 0 }, 30, 12);
    if (shape === "none") { assert.equal(drawing, null); continue; }
    assert.ok(drawing.points || drawing.d, `${shape} draws nothing`);
    assert.ok(Number.isFinite(drawing.pullback) && drawing.pullback >= 0, `${shape} has no usable pullback`);
    // C-16's lesson generalized: the DISTINCTNESS sweep must include every member,
    // so a shape that silently duplicates another is a dead row in the picker.
    const key = JSON.stringify(drawing);
    assert.equal(seen.has(key), false, `${shape} draws identically to ${seen.get(key)}`);
    seen.set(key, shape);
  }
});

test("headDrawing: every shape is PDF-SAFE — no elliptical arc reaches a `d`", () => {
  // render_gpu/ir.js's path() docblock: pdf_backend's svgPathToPdfOps accepts
  // only M L H V C Q T Z and THROWS on A/S. A curve authored with an arc would
  // raster in Skia, export in SVG, and blow up the PDF exporter alone.
  for (const shape of HEAD_SHAPES) {
    const drawing = headDrawing(shape, { x: 100, y: 0 }, { x: 0, y: 0 }, 30, 12);
    if (!drawing?.d) continue;
    assert.deepEqual(drawing.d.match(/[^MLHVCQTZ0-9\s.,-]/g), null, `${shape}: "${drawing.d}" uses a command outside the PDF-safe subset`);
  }
});

test("headDrawing: a hollow head stops the shaft at its BACK, a solid one tucks inside", () => {
  const at = (shape) => headDrawing(shape, { x: 100, y: 0 }, { x: 0, y: 0 }, 30, 12).pullback;
  assert.ok(at("triangle") < 30, "a solid triangle is opaque, so the shaft may end inside it");
  assert.equal(at("triangleOpen"), 30, "a see-through triangle would show the shaft crossing it");
  assert.equal(at("diamondOpen"), 30);
  assert.equal(at("circleOpen"), 12, "the full DIAMETER — which is also what draws a UML lollipop");
  assert.equal(at("open"), 0, "the V's vertex IS the tip; the shaft runs the whole way");
  assert.equal(at("onlyOne"), 0, "ER marks sit ON the line, not at the end of it");
});

test("arrowHeads: end-then-start order, per-end shapes, shaft weight on a hollow glyph", () => {
  const s = { headStart: "diamondOpen", headEnd: "triangle", headLength: 14, headWidth: 12, stroke: "#123456", strokeWidth: 5, opacity: 1 };
  const { ops, pullback } = arrowHeads(s, { tip: { x: 100, y: 0 }, from: { x: 0, y: 0 } }, { tip: { x: 0, y: 0 }, from: { x: 100, y: 0 } });
  assert.equal(ops.length, 2);
  assert.deepEqual(ops[0].points[0], [100, 0], "the END head comes first, as the single-triangle code emitted it");
  assert.equal(ops[0].fill, "#123456");
  assert.equal(ops[1].fill, null, "a hollow glyph has no fill");
  assert.equal(ops[1].stroke, "#123456");
  assert.equal(ops[1].strokeWidth, 5, "a hollow head is drawn with the SHAFT's weight, not a knob of its own");
  assert.equal(pullback.end, 14 * SHAFT_PULLBACK);
  assert.equal(pullback.start, 14);
});

test("headTriangle: tip + two base corners, axis-covariant (rotating the axis rotates the triangle)", () => {
  const tri = headTriangle({ x: 100, y: 0 }, { x: 0, y: 0 }, 14, 12);
  assert.deepEqual(tri[0], [100, 0]); // tip
  assert.equal(tri.length, 3);
  // Base corners sit `len` back along the axis, ±width/2 across it.
  const [, baseA, baseB] = tri;
  assert.ok(Math.abs(baseA[0] - 86) < 1e-9 && Math.abs(baseB[0] - 86) < 1e-9);
  assert.ok(Math.abs(baseA[1] - 6) < 1e-9 && Math.abs(baseB[1] + 6) < 1e-9);
});

test("headTriangle: degenerate coincident tip/from doesn't throw (collapses to a point)", () => {
  const tri = headTriangle({ x: 5, y: 5 }, { x: 5, y: 5 }, 14, 12);
  assert.deepEqual(tri[0], [5, 5]);
});


// ── elbow_arrow / curved_arrow: same shared-hooks contract as arrow/fancy_arrow ─

test("elbow arrow + curved arrow also consume the shared endpoint hooks", () => {
  const mixed = { from: { x: 0, y: 0 }, to: { x: 10, y: "@c1_tm.y" } };
  for (const plugin of [elbowArrowPlugin, curvedArrowPlugin]) {
    assert.deepEqual(plugin.editPoints({ state: STATE }), endpointEditPoints(STATE), plugin.type);
    assert.deepEqual(plugin.moveBy(mixed, 5, 2), endpointMoveBy(mixed, 5, 2), plugin.type);
    assert.deepEqual(plugin.closestToward(STATE, ["to", "x"]), { x: 1, y: 2 }, plugin.type);
  }
});

test("elbow arrow + curved arrow: the default pair IS the retired headMode 'end'", () => {
  for (const plugin of [elbowArrowPlugin, curvedArrowPlugin]) {
    assert.deepEqual(
      { headStart: plugin.defaults.headStart, headEnd: plugin.defaults.headEnd },
      headModeSplit("end"), plugin.type);
    assert.equal("headMode" in plugin.defaults, false, `${plugin.type} still carries the retired enum`);
    const cmds = plugin.emit(plugin.defaults);
    assert.equal(cmds.filter((c) => c.op === "polyline").length, 1, plugin.type);
    assert.equal(cmds.filter((c) => c.op === "polygon").length, 1, plugin.type);
  }
});

test("elbow arrow + curved arrow: two triangles emit two head polygons; two 'none' emit zero", () => {
  for (const plugin of [elbowArrowPlugin, curvedArrowPlugin]) {
    const both = plugin.emit({ ...plugin.defaults, ...headModeSplit("both") });
    assert.equal(both.filter((c) => c.op === "polygon").length, 2, plugin.type);
    const none = plugin.emit({ ...plugin.defaults, ...headModeSplit("none") });
    assert.equal(none.filter((c) => c.op === "polygon").length, 0, plugin.type);
  }
});

test("elbow arrow + curved arrow: each end carries its OWN shape (what headMode could not say)", () => {
  for (const plugin of [elbowArrowPlugin, curvedArrowPlugin]) {
    const cmds = plugin.emit({ ...plugin.defaults, headStart: "triangleOpen", headEnd: "diamond" });
    assert.equal(cmds.filter((c) => c.op === "polygon").length, 1, `${plugin.type}: the solid diamond`);
    assert.equal(cmds.filter((c) => c.op === "path").length, 1, `${plugin.type}: the hollow triangle`);
  }
});

// ── DASH, on the whole connector family (todo #232) ─────────────────────────

test("dashedSpans: arc length, across vertices — a dash TURNS a corner", () => {
  // plugins/line.js's version dashed ONE segment, which is all a line has. An
  // elbow route and a sampled bezier need the pattern to continue around a bend
  // rather than restart at every vertex, which is what generalizing it bought.
  const corner = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }];
  assert.equal(dashedSpans(corner, 12, 4)[0].length, 3, "the first dash carries a vertex with it");
  assert.deepEqual(dashedSpans(corner, 0, 4), [corner], "a non-positive dash length is SOLID, not an infinite loop");
  assert.deepEqual(dashedSpans([{ x: 5, y: 5 }, { x: 5, y: 5 }], 4, 4), [[{ x: 5, y: 5 }, { x: 5, y: 5 }]]);
});

test("EVERY connector can be dashed — the gap todo #232 names", () => {
  // `dashed` lived on `line` ALONE, which has no head, so a dotted arrow (mermaid
  // `-.->`, a UML dependency, an ER non-identifying relationship) could not be
  // drawn at all. The three headed arrows now carry the same three rows.
  for (const plugin of [arrowPlugin, elbowArrowPlugin, curvedArrowPlugin]) {
    const keys = plugin.inspector.map((r) => r.key);
    for (const k of CONNECTOR_DASH_ROWS.map((r) => r.key)) assert.ok(keys.includes(k), `${plugin.type} has no "${k}" row`);
    assert.equal(plugin.defaults.dashed, false, `${plugin.type} must default SOLID`);
    const solid = plugin.emit({ ...plugin.defaults, dashed: false });
    const dashed = plugin.emit({ ...plugin.defaults, dashed: true });
    assert.ok(dashed.length > solid.length, `${plugin.type}: dashing must break the shaft into runs`);
    // The head is untouched by dashing — a dotted line still ends in a solid glyph.
    assert.equal(dashed.filter((c) => c.op === "polygon").length, solid.filter((c) => c.op === "polygon").length, plugin.type);
  }
});

test("dashing is GEOMETRY, so a dashed connector emits no material stroke (it would rasterize both exports)", () => {
  // MEASURED, and the reason dashedSpans is not the `dashes` stroke material:
  // render_gpu/svg_backend.js and pdf_backend.js both route an op with
  // opHasMaterialStroke to RASTER, so a dashed arrow would export as a bitmap.
  for (const plugin of [arrowPlugin, elbowArrowPlugin, curvedArrowPlugin]) {
    for (const cmd of plugin.emit({ ...plugin.defaults, dashed: true }))
      assert.equal(opHasMaterialStroke(cmd), false, `${plugin.type}: ${cmd.op} carries a material stroke`);
  }
});

test("a solid connector is byte-identical with the dash keys ABSENT or false", () => {
  // An old document has no dash keys at all; it must render exactly as before.
  for (const plugin of [arrowPlugin, elbowArrowPlugin, curvedArrowPlugin]) {
    const withKeys = { ...plugin.defaults };
    const without = { ...plugin.defaults };
    delete without.dashed; delete without.dashLength; delete without.dashGap;
    assert.deepEqual(plugin.emit(without), plugin.emit(withKeys), plugin.type);
  }
});

console.log(`\n${passed} endpoints tests passed`);
