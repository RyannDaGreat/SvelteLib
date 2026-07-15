/**
 * render_gpu headless tests — plain node, no framework (core_test.js style).
 * Run: node src/demo_apps/PowerRP/render_gpu/tests/render_gpu_test.js
 * Covers the DOM-free half of the prototype: IR builders/validation/colors,
 * transform flattening, widget ports, and the SVG serializer. The GPU half
 * is exercised by bench/run_bench.mjs (real browser).
 */

import assert from "node:assert/strict";
import {
  parseColor, rgbaToCss, rect, ellipse, polyline, polygon, text, image, video,
  pushTransform, popTransform, blurBackdrop, magnifyBackdrop, flattenIR,
} from "../ir.js";
import { videoIR, sceneIR } from "../ports.js";
import { rectPlugin } from "../../plugins/rect.js";
import { circlePlugin } from "../../plugins/circle.js";
import { imagePlugin, BLANK_SRC } from "../../plugins/image.js";
import { getImage, imageStatus, truncate } from "../gpu/image_registry.js";
import { arrowPlugin } from "../../plugins/arrow.js";
import { fancyArrowPlugin } from "../../plugins/fancy_arrow.js";
import { blurPlugin } from "../../plugins/blur.js";
import { magnifierPlugin } from "../../plugins/magnifier.js";
import { irToSVG, commandToSVG, svgTransform, xmlEscape } from "../svg_backend.js";
import { lensRenderView, deviceRectThroughViews, intersectRects } from "../gpu/compositor.js";
import { bucketFor } from "../gpu/glyph_atlas.js";
import { benchScene, hash01 } from "../bench/scene.js";
import { deriveRenderTree } from "../../core/derive.js";
import { evaluateState } from "../../core/expressions.js";
import { createRegistry } from "../../core/registry.js";
import { registerAll } from "../../plugins/index.js";
import { createCommands } from "../../core/commands.js";

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}
function approxArr(a, b, eps = 1e-6) {
  assert.equal(a.length, b.length, `${a} !~ ${b}`);
  a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) < eps, `${a} !~ ${b} @ ${i}`));
}

// ── colors ──────────────────────────────────────────────────────────────────
test("parseColor: hex forms", () => {
  approxArr(parseColor("#ff0000"), [1, 0, 0, 1]);
  approxArr(parseColor("#0f8"), [0, 1, 0x88 / 255, 1]);
  approxArr(parseColor("#11223344"), [0x11 / 255, 0x22 / 255, 0x33 / 255, 0x44 / 255]);
});
test("parseColor: rgb()/rgba()/arrays", () => {
  approxArr(parseColor("rgba(255, 0, 0, 0.5)"), [1, 0, 0, 0.5]);
  approxArr(parseColor("rgb(0,128,255)"), [0, 128 / 255, 1, 1]);
  approxArr(parseColor([0.1, 0.2, 0.3]), [0.1, 0.2, 0.3, 1]);
});
test("parseColor: loud on garbage", () => {
  assert.throws(() => parseColor("cornflowerblue"), /unsupported color/);
  assert.throws(() => parseColor(42), /unsupported color/);
  assert.throws(() => parseColor([1]), /bad array length/);
});
test("rgbaToCss roundtrip", () => {
  assert.equal(rgbaToCss([1, 0, 0, 1]), "rgba(255,0,0,1)");
  assert.equal(rgbaToCss(parseColor("#7aa2f7")), "rgba(122,162,247,1)");
});

// ── IR builders ─────────────────────────────────────────────────────────────
test("rect: normalizes colors + clamps radius", () => {
  const r = rect({ x: 1, y: 2, w: 3, h: 4, fill: "#fff", cornerRadius: -5 });
  assert.equal(r.cornerRadius, 0);
  approxArr(r.fill, [1, 1, 1, 1]);
  assert.equal(r.stroke, null);
});
test("builders: loud on non-finite geometry", () => {
  assert.throws(() => rect({ x: NaN, y: 0, w: 1, h: 1, fill: "#fff" }), /finite number/);
  assert.throws(() => ellipse({ cx: 0, cy: 0, rx: Infinity, ry: 1, fill: "#fff" }), /finite number/);
  assert.throws(() => text({ text: 5, x: 0, y: 0, size: 12, color: "#000" }), /must be a string/);
  assert.throws(() => polyline({ points: [[0, 0]], width: 1, color: "#000" }), /need >= 2 points/);
  assert.throws(() => polygon({ points: [[0, 0], [1, 1]], fill: "#000" }), /need >= 3 points/);
  assert.throws(() => magnifyBackdrop({ cx: 0, cy: 0, r: 1, magnification: 0 }), /magnification/);
  assert.throws(() => image({ ref: 7, x: 0, y: 0, w: 1, h: 1 }), /must be a string/);
});

// ── flattenIR ───────────────────────────────────────────────────────────────
test("flattenIR: identity world for bare commands", () => {
  const flat = flattenIR([rect({ x: 0, y: 0, w: 1, h: 1, fill: "#fff" })]);
  assert.deepEqual(flat[0].world, { x: 0, y: 0, rotation: 0, scale: 1 });
});
test("flattenIR: composes nested similarity transforms", () => {
  const flat = flattenIR([
    pushTransform({ x: 10, y: 0, scale: 2 }),
    pushTransform({ x: 5, y: 0 }), // inner: world x = 10 + 2*5 = 20, scale 2
    rect({ x: 0, y: 0, w: 1, h: 1, fill: "#fff" }),
    popTransform(),
    rect({ x: 0, y: 0, w: 1, h: 1, fill: "#fff" }),
    popTransform(),
  ]);
  assert.deepEqual(flat[0].world, { x: 20, y: 0, rotation: 0, scale: 2 });
  assert.deepEqual(flat[1].world, { x: 10, y: 0, rotation: 0, scale: 2 });
});
test("flattenIR: loud on unbalanced stack", () => {
  assert.throws(() => flattenIR([popTransform()]), /without matching push/);
  assert.throws(() => flattenIR([pushTransform({ x: 1 })]), /unclosed/);
});

// ── ports ───────────────────────────────────────────────────────────────────
test("rectIR/circleIR mirror plugin geometry", () => {
  const r = rectPlugin.emit({ w: 240, h: 140, fill: "#7aa2f7", stroke: "#1a1a2e", strokeWidth: 2, cornerRadius: 8, opacity: 0.5 })[0];
  assert.equal(r.op, "rect");
  assert.equal(r.opacity, 0.5);
  assert.ok(r.stroke);
  const zeroStroke = rectPlugin.emit({ w: 1, h: 1, fill: "#fff", stroke: "#000", strokeWidth: 0 })[0];
  assert.equal(zeroStroke.stroke, null); // strokeWidth 0 ⇒ no stroke emitted
  const c = circlePlugin.emit({ w: 140, h: 100, fill: "#f7768e", strokeWidth: 0 })[0];
  assert.equal(c.op, "ellipse");
  assert.equal(c.rx, 70);
  assert.equal(c.ry, 50);
});
test("imageIR: emit is a textured quad by src ref; empty src emits nothing", () => {
  const cmd = imagePlugin.emit({ src: "data:image/png;base64,AAAA", w: 200, h: 150, opacity: 0.5 })[0];
  assert.equal(cmd.op, "image");
  assert.equal(cmd.ref, "data:image/png;base64,AAAA"); // ref IS the source string (both backends resolve it)
  assert.equal(cmd.w, 200);
  assert.equal(cmd.opacity, 0.5);
  assert.deepEqual(imagePlugin.emit({ src: "", w: 10, h: 10 }), []);     // broken widget → nothing
  assert.deepEqual(imagePlugin.emit({ w: 10, h: 10 }), []);              // missing src → nothing
  // Capabilities that make backdrop stacking + culling work for free.
  assert.equal(imagePlugin.capabilities.bbox, true);
  assert.equal(imagePlugin.capabilities.backdrop, false);
  assert.ok(imagePlugin.defaults.src.startsWith("data:image/png")); // blank default = valid item
  assert.equal(BLANK_SRC, imagePlugin.defaults.src);
});
test("image_registry: DOM-free queries (an undecoded src is quiet + null)", () => {
  assert.equal(imageStatus("nope://never-requested"), "unloaded");
  assert.equal(getImage("nope://never-requested"), null); // not ready → draw nothing (async rule)
  assert.equal(truncate("short"), "short");
  assert.match(truncate("data:image/png;base64," + "A".repeat(200)), /…\(\d+ chars\)$/);
});
test("arrowIR: shaft pullback + independent headLength/headWidth triangle", () => {
  const cmds = arrowPlugin.emit({ from: { x: 0, y: 0 }, to: { x: 100, y: 0 }, color: "#000", width: 3, headLength: 10, headWidth: 8 });
  assert.deepEqual(cmds.map((c) => c.op), ["polyline", "polygon"]);
  approxArr(cmds[0].points[1], [100 - 10 * 0.6, 0]); // shaft stops 0.6*headLength short
  assert.equal(cmds[1].points.length, 3);
  approxArr(cmds[1].points[0], [100, 0]); // tip at the endpoint
  approxArr(cmds[1].points[1], [90, 4]); // base corner: headLength back, +headWidth/2 across
  approxArr(cmds[1].points[2], [90, -4]); // base corner: -headWidth/2 — width independent of length
});
test("arrowIR: dangling reference falls back loudly upstream, still draws", () => {
  // Post-UNIFICATION semantics: a reference to a missing item is an ERROR
  // reported by evaluateState (with a numeric fallback) — never a silently
  // skipped arrow and never NaN geometry reaching the IR.
  const registry = createRegistry();
  registerAll(registry, createCommands());
  const state = { items: { c: { type: "arrow", from: { x: 0, y: 0 }, to: { x: "@gone.x", y: 5 }, color: "#000", width: 3, headLength: 10, headWidth: 8 } } };
  const { state: evaluated, errors } = evaluateState(state, registry);
  assert.ok(errors.size > 0); // the unknown reference is REPORTED
  assert.equal(typeof evaluated.items.c.to.x, "number"); // fallback, not NaN
  assert.deepEqual(arrowPlugin.emit(evaluated.items.c).map((c) => c.op), ["polyline", "polygon"]);
});
test("fancyArrowIR: outline triangulates to convex polygons (the parameterized-geometry path)", () => {
  // Reference params = the Figures-library defaults on a 100px arrow
  // (core/outline.js fancyArrowOutline; area cross-checked in outline_test).
  const s = {
    from: { x: 0, y: 0 }, to: { x: 100, y: 0 },
    tipLength: 15, tipWidth: 30, tipDimple: 5, startWidth: 3, endWidth: 5,
    color: "#000", opacity: 0.5,
  };
  const cmds = fancyArrowPlugin.emit(s);
  assert.equal(cmds.length, 5); // 7-vertex simple outline → n-2 triangles
  assert.ok(cmds.every((c) => c.op === "polygon" && c.points.length === 3));
  assert.ok(cmds.every((c) => c.opacity === 0.5));
  // The tip vertex survives triangulation verbatim (watertight shared points).
  assert.ok(cmds.some((c) => c.points.some(([x, y]) => x === 100 && y === 0)));
});
test("fancyArrowIR: zero-length arrow emits nothing (skia_draw_arrow precedent)", () => {
  assert.deepEqual(fancyArrowPlugin.emit({
    from: { x: 7, y: 7 }, to: { x: 7, y: 7 },
    tipLength: 15, tipWidth: 30, tipDimple: 5, startWidth: 3, endWidth: 5,
    color: "#000",
  }), []);
});
test("fancyArrow hit test: concavity-aware (dimple notch is a miss, head is a hit)", () => {
  const node = { state: {
    from: { x: 0, y: 0 }, to: { x: 100, y: 0 },
    tipLength: 15, tipWidth: 30, tipDimple: 5, startWidth: 3, endWidth: 5,
  } };
  assert.equal(fancyArrowPlugin.hitTestWorld(node, 86, 13), true); // inside the head
  assert.equal(fancyArrowPlugin.hitTestWorld(node, 86, 8), false); // in the notch, past shaft grab
  assert.equal(fancyArrowPlugin.hitTestWorld(node, 50, 6), true); // padded shaft grab (+5 slack)
});
test("videoIR: the future video plugin's emit body", () => {
  const v = videoIR({ ref: "clip1", w: 320, h: 180 })[0];
  assert.equal(v.op, "video");
  assert.equal(v.ref, "clip1");
});
test("blurIR: zero blur emits nothing", () => {
  assert.deepEqual(blurPlugin.emit({ blur: 0 }), []);
  assert.equal(blurPlugin.emit({ blur: 6 })[0].radius, 6);
});
test("magnifierIR: lens geometry from bbox", () => {
  const m = magnifierPlugin.emit({ x: 0, y: 0, w: 160, h: 160, magnification: 2.5, rimColor: "#1a1a2e", rimWidth: 4 })[0];
  assert.equal(m.cx, 80);
  assert.equal(m.r, 80);
  assert.equal(m.magnification, 2.5);
  assert.ok(m.rimColor);
});
test("magnifyBackdrop: supersample flag (default true, false honored)", () => {
  assert.equal(magnifyBackdrop({ cx: 0, cy: 0, r: 50, magnification: 2 }).supersample, true);
  assert.equal(magnifyBackdrop({ cx: 0, cy: 0, r: 50, magnification: 2, supersample: false }).supersample, false);
  assert.equal(magnifyBackdrop({ cx: 0, cy: 0, r: 50, magnification: 2, supersample: 1 }).supersample, true); // normalized to bool
});
test("magnifierIR: emit passes supersample through (state default true)", () => {
  const base = { x: 0, y: 0, w: 160, h: 160, magnification: 2.5, rimColor: "#000", rimWidth: 4 };
  assert.equal(magnifierPlugin.emit(base)[0].supersample, true); // absent → default true (plugin defaults)
  assert.equal(magnifierPlugin.emit({ ...base, supersample: false })[0].supersample, false);
  assert.equal(magnifierPlugin.emit({ ...base, supersample: true })[0].supersample, true);
});
test("lensRenderView: lens center is the fixed point of the magnified view", () => {
  const view = { zoom: 1.5, panX: 40, panY: -12, dpr: 2 };
  const center = { x: 123, y: 77 };
  const lens = lensRenderView(view, center, 2.5);
  assert.equal(lens.zoom, 1.5 * 2.5);
  assert.equal(lens.dpr, view.dpr);
  const dev = (v, w) => [(w.x * v.zoom + v.panX) * v.dpr, (w.y * v.zoom + v.panY) * v.dpr];
  approxArr(dev(lens, center), dev(view, center)); // center pinned to the same device px
  // A point r away from center lands M× farther from it (that IS magnification)
  const off = { x: center.x + 10, y: center.y };
  assert.ok(Math.abs((dev(lens, off)[0] - dev(lens, center)[0]) - 2.5 * (dev(view, off)[0] - dev(view, center)[0])) < 1e-9);
});
test("deviceRectThroughViews + intersectRects: scissor carry math", () => {
  assert.deepEqual(
    deviceRectThroughViews({ x: 0, y: 0, w: 100, h: 100 }, { zoom: 1, panX: 0, panY: 0, dpr: 1 }, { zoom: 2, panX: 0, panY: 0, dpr: 1 }),
    { x: 0, y: 0, w: 200, h: 200 },
  );
  // Round-trip: mapping to a view and back is the identity
  const from = { zoom: 1.25, panX: 7, panY: -3, dpr: 2 };
  const to = { zoom: 5, panX: -100, panY: 40, dpr: 2 };
  const rect = { x: 10, y: 20, w: 30, h: 40 };
  const back = deviceRectThroughViews(deviceRectThroughViews(rect, from, to), to, from);
  approxArr([back.x, back.y, back.w, back.h], [rect.x, rect.y, rect.w, rect.h], 1e-9);
  assert.deepEqual(intersectRects({ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 5, w: 10, h: 10 }), { x: 5, y: 5, w: 5, h: 5 });
  assert.equal(intersectRects({ x: 0, y: 0, w: 4, h: 4 }, { x: 8, y: 0, w: 2, h: 2 }).w, 0); // disjoint → zero-area
});
test("sceneIR: real registry render tree → z-ordered wrapped IR", () => {
  const registry = createRegistry();
  registerAll(registry, createCommands());
  const state = {
    items: {
      a: { type: "rect", x: 10, y: 20, w: 100, h: 50, z: 1, fill: "#7aa2f7", stroke: "#000", strokeWidth: 2, cornerRadius: 4 },
      b: { type: "circle", x: 0, y: 0, w: 80, h: 80, z: 0, fill: "#f7768e", strokeWidth: 0 },
      c: { type: "arrow", z: 2, from: { x: 0, y: 0 }, to: { x: "@a_cm.x", y: "@a_cm.y" }, color: "#000", width: 3, headLength: 14, headWidth: 12 },
    },
  };
  // The real pipeline: fold → EVALUATE (equations become numbers) → derive → emit.
  const nodes = deriveRenderTree(evaluateState(state, registry).state, registry);
  const ir = sceneIR(nodes);
  // circle (z0) first, rect (z1), then the arrow (identity world — uniform wrap)
  assert.deepEqual(ir.map((c) => c.op),
    ["pushTransform", "ellipse", "popTransform", "pushTransform", "rect", "popTransform", "pushTransform", "polyline", "polygon", "popTransform"]);
  assert.equal(ir[3].x, 10); // rect's world transform carries the item position
  const flat = flattenIR(ir);
  assert.equal(flat.length, 4);
  // the arrow's head lands on the rect center (60, 45)
  approxArr(flat[3].cmd.points[0], [60, 45]);
});
test("sceneIR: loud on a plugin without emit()", () => {
  assert.throws(
    () => sceneIR([{ type: "hologram", plugin: {}, state: {}, world: { x: 0, y: 0, rotation: 0, scale: 1 } }]),
    /no emit/,
  );
});

// ── SVG backend ─────────────────────────────────────────────────────────────
test("svgTransform: composes view + world", () => {
  assert.equal(svgTransform({ x: 10, y: 0, rotation: 0, scale: 2 }, { zoom: 1, panX: 0, panY: 0 }), "translate(10 0) scale(2)");
  assert.equal(svgTransform({ x: 0, y: 0, rotation: Math.PI / 2, scale: 1 }, { zoom: 1, panX: 0, panY: 0 }), "rotate(90)");
  assert.equal(svgTransform({ x: 0, y: 0, rotation: 0, scale: 1 }, { zoom: 2, panX: 5, panY: 6 }), "translate(5 6) scale(2)");
});
test("xmlEscape", () => {
  assert.equal(xmlEscape(`<a & "b">`), "&lt;a &amp; &quot;b&quot;&gt;");
});
test("commandToSVG: shapes serialize, unknown op throws", () => {
  const view = { zoom: 1, panX: 0, panY: 0 };
  const r = commandToSVG({ cmd: rect({ x: 0, y: 0, w: 10, h: 5, fill: "#f00", cornerRadius: 2 }), world: { x: 0, y: 0, rotation: 0, scale: 1 } }, view);
  assert.match(r, /<rect .*rx="2".*fill="rgba\(255,0,0,1\)"/);
  assert.throws(() => commandToSVG({ cmd: { op: "warp" }, world: { x: 0, y: 0, rotation: 0, scale: 1 } }, view), /unknown op/);
});
test("irToSVG: full scene document", () => {
  const registry = createRegistry();
  registerAll(registry, createCommands());
  const state = {
    items: {
      a: { type: "rect", x: 10, y: 20, w: 100, h: 50, z: 0, rotation: 0.5, fill: "#7aa2f7", stroke: "#000", strokeWidth: 2, cornerRadius: 4 },
      t: { type: "text", x: 5, y: 5, z: 1, text: "Hello <svg>", size: 36, color: "#1a1a2e", bold: true },
    },
  };
  const nodes = deriveRenderTree(state, registry);
  const ir = sceneIR(nodes);
  const svg = irToSVG(ir, { width: 640, height: 360, view: { zoom: 0.5, panX: 0, panY: 0 }, background: "#ffffff" });
  assert.ok(svg.startsWith("<svg xmlns"));
  assert.match(svg, /<rect x="0" y="0" width="100" height="50" rx="4"/);
  assert.match(svg, /rotate\(28.6479\)/); // 0.5 rad
  assert.match(svg, /Hello &lt;svg&gt;/);
  assert.match(svg, /font-weight="bold"/);
  assert.match(svg, /<\/svg>$/);
});

// ── benchmark scene (must stay DOM-free + deterministic) ───────────────────
test("hash01: deterministic, in [0,1)", () => {
  assert.equal(hash01(7, 3), hash01(7, 3));
  assert.notEqual(hash01(7, 3), hash01(8, 3));
  for (let i = 0; i < 50; i++) {
    const v = hash01(i, i % 5);
    assert.ok(v >= 0 && v < 1, `${v} out of range`);
  }
});
test("benchScene: structure is stable, flattens + serializes", () => {
  const ir = benchScene(1.25, { n: 10, effects: true });
  assert.equal(ir.filter((c) => c.op === "rect").length, 10);
  assert.equal(ir.filter((c) => c.op === "blurBackdrop").length, 1);
  assert.equal(ir.filter((c) => c.op === "magnifyBackdrop").length, 1);
  assert.equal(flattenIR(ir).length > 0, true); // balanced transform stack
  const svg = irToSVG(ir, { width: 800, height: 450, view: { zoom: 0.5, panX: 0, panY: 0 } });
  assert.match(svg, /<polygon/); // arrowheads made it through the vector backend
});

test("bucketFor: ceil lattice below the exact regime, exact size above, capacity clamp", () => {
  // Small text: half-octave lattice, CEILed — quads only ever minify (scale
  // ∈ [0.707, 1]); magnification is what read as pixelation (text-crispness
  // task, pixel-proofed vs native rasterization).
  assert.equal(bucketFor(36), Math.pow(2, 5.5)); // 45.25... — next half-octave UP
  assert.equal(bucketFor(37), Math.pow(2, 5.5)); // same bucket (that's the point)
  assert.equal(bucketFor(32), 32); // exact lattice sizes stay put
  assert.ok(bucketFor(100) >= 100); // ceil invariant: raster ≥ display, never below
  // Large text: EXACT display size (0.1px-rounded) — scale-1.0 quads.
  assert.equal(bucketFor(288.44), 288.4);
  assert.equal(bucketFor(576), 576);
  // Clamps: invisible floor, page-capacity ceiling.
  assert.equal(bucketFor(1), 4);
  assert.equal(bucketFor(9999), 724);
});

console.log(`\nrender_gpu tests: ${passed} passed`);
