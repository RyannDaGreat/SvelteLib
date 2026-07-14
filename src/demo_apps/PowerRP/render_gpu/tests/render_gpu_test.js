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
import { rectIR, circleIR, arrowIR, textIR, videoIR, blurIR, magnifierIR, sceneIR } from "../ports.js";
import { irToSVG, commandToSVG, svgTransform, xmlEscape } from "../svg_backend.js";
import { deriveRenderTree, resolveBinding } from "../../core/derive.js";
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
  const r = rectIR({ w: 240, h: 140, fill: "#7aa2f7", stroke: "#1a1a2e", strokeWidth: 2, cornerRadius: 8, opacity: 0.5 })[0];
  assert.equal(r.op, "rect");
  assert.equal(r.opacity, 0.5);
  assert.ok(r.stroke);
  const zeroStroke = rectIR({ w: 1, h: 1, fill: "#fff", stroke: "#000", strokeWidth: 0 })[0];
  assert.equal(zeroStroke.stroke, null); // strokeWidth 0 ⇒ no stroke emitted
  const c = circleIR({ w: 140, h: 100, fill: "#f7768e", strokeWidth: 0 })[0];
  assert.equal(c.op, "ellipse");
  assert.equal(c.rx, 70);
  assert.equal(c.ry, 50);
});
test("arrowIR: shaft pullback + head triangle", () => {
  const cmds = arrowIR(
    { from: { x: 0, y: 0 }, to: { x: 100, y: 0 }, color: "#000", width: 3, headSize: 10 },
    (b) => (b?.item === undefined ? b : null),
  );
  assert.deepEqual(cmds.map((c) => c.op), ["polyline", "polygon"]);
  approxArr(cmds[0].points[1], [100 - 10 * 0.6, 0]); // shaft stops 0.6*head short
  assert.equal(cmds[1].points.length, 3);
  approxArr(cmds[1].points[0], [100, 0]); // tip at the endpoint
});
test("arrowIR: missing binding → no commands (matches plugin)", () => {
  assert.deepEqual(arrowIR({ from: { x: 0, y: 0 }, to: { item: "gone", anchor: "cm" } }, () => null), []);
});
test("blurIR: zero blur emits nothing", () => {
  assert.deepEqual(blurIR({ blur: 0 }), []);
  assert.equal(blurIR({ blur: 6 })[0].radius, 6);
});
test("magnifierIR: lens geometry from bbox", () => {
  const m = magnifierIR({ x: 0, y: 0, w: 160, h: 160, magnification: 2.5, rimColor: "#1a1a2e", rimWidth: 4 })[0];
  assert.equal(m.cx, 80);
  assert.equal(m.r, 80);
  assert.equal(m.magnification, 2.5);
  assert.ok(m.rimColor);
});
test("sceneIR: real registry render tree → z-ordered wrapped IR", () => {
  const registry = createRegistry();
  registerAll(registry, createCommands());
  const state = {
    items: {
      a: { type: "rect", x: 10, y: 20, w: 100, h: 50, z: 1, fill: "#7aa2f7", stroke: "#000", strokeWidth: 2, cornerRadius: 4 },
      b: { type: "circle", x: 0, y: 0, w: 80, h: 80, z: 0, fill: "#f7768e", strokeWidth: 0 },
      c: { type: "arrow", z: 2, from: { x: 0, y: 0 }, to: { item: "a", anchor: "cm" }, color: "#000", width: 3, headSize: 14 },
    },
  };
  const nodes = deriveRenderTree(state, registry);
  const nodesById = Object.fromEntries(nodes.map((n) => [n.id, n]));
  const ir = sceneIR(nodes, (bd, tx, ty) => resolveBinding(bd, nodesById, tx, ty));
  // circle (z0) first, rect (z1), then the arrow's two world-space commands
  assert.deepEqual(ir.map((c) => c.op),
    ["pushTransform", "ellipse", "popTransform", "pushTransform", "rect", "popTransform", "polyline", "polygon"]);
  assert.equal(ir[3].x, 10); // rect's world transform carries the item position
  const flat = flattenIR(ir);
  assert.equal(flat.length, 4);
  // the arrow's head lands on the rect center (60, 45)
  approxArr(flat[3].cmd.points[0], [60, 45]);
});
test("sceneIR: loud on unknown widget type", () => {
  assert.throws(
    () => sceneIR([{ type: "hologram", state: {}, world: { x: 0, y: 0, rotation: 0, scale: 1 } }], () => null),
    /no IR emitter/,
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
  const ir = sceneIR(nodes, () => null);
  const svg = irToSVG(ir, { width: 640, height: 360, view: { zoom: 0.5, panX: 0, panY: 0 }, background: "#ffffff" });
  assert.ok(svg.startsWith("<svg xmlns"));
  assert.match(svg, /<rect x="0" y="0" width="100" height="50" rx="4"/);
  assert.match(svg, /rotate\(28.6479\)/); // 0.5 rad
  assert.match(svg, /Hello &lt;svg&gt;/);
  assert.match(svg, /font-weight="bold"/);
  assert.match(svg, /<\/svg>$/);
});

console.log(`\nrender_gpu tests: ${passed} passed`);
