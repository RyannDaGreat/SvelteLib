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
  latexVector, pushTransform, popTransform, blurBackdrop, magnifyBackdrop, flattenIR, DRAW_OPS,
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
import {
  irToSVG, vectorCommandToSVG, similarityTransform, viewTransform, xmlEscape,
  roundedRectPathD, pointsAttr, textToSVG, bytesToBase64, groupWrap,
} from "../svg_backend.js";
import { bucketFor } from "../gpu/glyph_atlas.js";
import { deriveRenderTree } from "../../core/derive.js";
import { evaluateState } from "../../core/expressions.js";
import { foldState } from "../../core/document.js";
import { createRegistry } from "../../core/registry.js";
import { registerAll } from "../../plugins/index.js";
import { createCommands } from "../../core/commands.js";
import { particlesPlugin, particleOps } from "../../plugins/particles.js";
import { cameraPlugin } from "../../plugins/camera.js";
import { simulateParticles } from "../../core/particles.js";
import { setParticleTimeOverride } from "../particle_clock.js";

let passed = 0;
// Awaits fn if it returns a promise (the SVG backend is async — irToSVG embeds
// fonts/images through injected seams); sync tests are unaffected. Call sites
// for async tests use `await test(...)` so ordering + the pass count stay exact.
async function test(name, fn) {
  await fn();
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
// ── Round 15.1 LaTeX vector op ───────────────────────────────────────────────
test("latexVector: builder validates, carries dual payload, is a known DRAW_OP", () => {
  const op = latexVector({ ref: "latex:eq:#1a1a2e:1", x: 5, y: 6, w: 40, h: 20, opacity: 0.5,
    glyphs: [{ d: "M0 0L10 10", fill: "#f00" }], viewBox: { minX: 0, minY: -883, w: 3552, h: 1738 } });
  assert.equal(op.op, "latexVector");
  assert.equal(op.ref, "latex:eq:#1a1a2e:1");   // GPU + hybrid raster fallback
  assert.deepEqual(op.glyphs, [{ d: "M0 0L10 10", fill: "#f00" }]); // SVG/PDF vector
  assert.deepEqual(op.viewBox, { minX: 0, minY: -883, w: 3552, h: 1738 });
  assert.deepEqual(op.src, { sx: 0, sy: 0, sw: 1, sh: 1 });
  assert.ok(DRAW_OPS.includes("latexVector"), "backends must know the op (throw otherwise)");
  assert.throws(() => latexVector({ ref: "r", x: 0, y: 0, w: 1, h: 1, glyphs: "no", viewBox: { minX: 0, minY: 0, w: 1, h: 1 } }), /"glyphs" must be an array/);
  assert.throws(() => latexVector({ ref: "r", x: 0, y: 0, w: 1, h: 1, glyphs: [], viewBox: { minX: 0, minY: 0, w: 0, h: 1 } }), /positive w\/h/);
});
test("latexVector → SVG: inline <path> glyphs, viewBox→box <g>, NO <image>, ink fill", () => {
  const op = latexVector({ ref: "latex:eq:1", x: 10, y: 20, w: 100, h: 40,
    glyphs: [{ d: "M0 0L200 0L200 80Z", fill: "#ff0000" }], viewBox: { minX: 0, minY: 0, w: 200, h: 80 } });
  const svg = vectorCommandToSVG(op, { x: 0, y: 0, rotation: 0, scale: 1 });
  assert.ok(svg.includes("<path"), "emits real vector <path> geometry");
  assert.ok(svg.includes('d="M0 0L200 0L200 80Z"'), "the glyph d verbatim (SVG native syntax)");
  assert.ok(svg.includes("rgba(255,0,0,1)"), "ink fill applied");
  assert.ok(!svg.includes("<image"), "NO raster <image> — true vector");
  // viewBox→box map: sx = 100/200 = 0.5, sy = 40/80 = 0.5, translate (10,20)
  assert.ok(svg.includes("translate(10 20)") && svg.includes("scale(0.5 0.5)"), `box→box transform: ${svg}`);
});
test("arrowIR: shaft pullback + independent headLength/headWidth triangle", () => {
  const cmds = arrowPlugin.emit({ from: { x: 0, y: 0 }, to: { x: 100, y: 0 }, stroke: "#000", strokeWidth: 3, headLength: 10, headWidth: 8 });
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
  const state = { items: { c: { type: "arrow", from: { x: 0, y: 0 }, to: { x: "@gone.x", y: 5 }, stroke: "#000", strokeWidth: 3, headLength: 10, headWidth: 8 } } };
  const { state: evaluated, errors } = evaluateState(state, registry);
  assert.ok(errors.size > 0); // the unknown reference is REPORTED
  assert.equal(typeof evaluated.items.c.to.x, "number"); // fallback, not NaN
  assert.deepEqual(arrowPlugin.emit(evaluated.items.c).map((c) => c.op), ["polyline", "polygon"]);
});
test("fancyArrowIR: outline triangulates to convex polygons (the parameterized-geometry path)", () => {
  // Reference params = the Figures-library defaults on a 100px arrow
  // (core/outline.js fancyArrowOutline; area cross-checked in outline_test).
  // `fill` is the body color (Round 17.4 — `stroke` is now the OUTLINE, left
  // unset here since strokeWidth defaults to 0 / undefined → no outline op).
  const s = {
    from: { x: 0, y: 0 }, to: { x: 100, y: 0 },
    tipLength: 15, tipWidth: 30, tipDimple: 5, startWidth: 3, endWidth: 5,
    fill: "#000", opacity: 0.5,
  };
  const cmds = fancyArrowPlugin.emit(s);
  assert.equal(cmds.length, 5); // 7-vertex simple outline → n-2 triangles
  assert.ok(cmds.every((c) => c.op === "polygon" && c.points.length === 3));
  assert.ok(cmds.every((c) => c.opacity === 0.5));
  // The tip vertex survives triangulation verbatim (watertight shared points).
  assert.ok(cmds.some((c) => c.points.some(([x, y]) => x === 100 && y === 0)));
});
test("fancyArrowIR: strokeWidth > 0 additionally emits ONE closed outline polyline (Round 17.4)", () => {
  const s = {
    from: { x: 0, y: 0 }, to: { x: 100, y: 0 },
    tipLength: 15, tipWidth: 30, tipDimple: 5, startWidth: 3, endWidth: 5,
    fill: "#000", stroke: "#fff", strokeWidth: 3, opacity: 1,
  };
  const cmds = fancyArrowPlugin.emit(s);
  assert.equal(cmds.length, 6); // 5 fill triangles + 1 outline polyline
  const outline = cmds[cmds.length - 1];
  assert.equal(outline.op, "polyline");
  assert.equal(outline.width, 3);
  assert.deepEqual(outline.points[0], outline.points[outline.points.length - 1]); // closed loop
});
test("fancyArrowIR: zero-length arrow emits nothing (skia_draw_arrow precedent)", () => {
  assert.deepEqual(fancyArrowPlugin.emit({
    from: { x: 7, y: 7 }, to: { x: 7, y: 7 },
    tipLength: 15, tipWidth: 30, tipDimple: 5, startWidth: 3, endWidth: 5,
    fill: "#000",
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
test("magnifierIR: circle lens geometry from bbox (stroke = migrated rim)", () => {
  // stroke/strokeWidth are the migrated rimColor/rimWidth (manifest rim→stroke).
  const m = magnifierPlugin.emit({ shape: "circle", x: 0, y: 0, w: 160, h: 160, magnification: 2.5, stroke: "#1a1a2e", strokeWidth: 4 })[0];
  assert.equal(m.shape, "circle");
  assert.equal(m.cx, 80);
  assert.equal(m.r, 80);
  assert.equal(m.magnification, 2.5);
  assert.ok(m.rimColor); // circle border feeds the rim slot (byte-identical IR path)
  assert.equal(m.rimWidth, 4);
  assert.equal(m.originX, 80); // no origin → lens center (byte-identical to pre-origin)
  assert.equal(m.originY, 80);
});
test("magnifierIR: BOX lens geometry + stroked border + cornerRadius", () => {
  const m = magnifierPlugin.emit({ shape: "box", x: 0, y: 0, w: 200, h: 120, cornerRadius: 16, magnification: 2, stroke: "#123456", strokeWidth: 3 })[0];
  assert.equal(m.shape, "box");
  assert.equal(m.cx, 100);
  assert.equal(m.cy, 60);
  assert.equal(m.halfW, 100);
  assert.equal(m.halfH, 60);
  assert.equal(m.cornerRadius, 16);
  assert.ok(m.stroke); // box border feeds the stroke slot
  assert.equal(m.strokeWidth, 3);
  assert.equal(m.rimColor, null); // box uses the stroke slot, not the rim slot
});
test("magnifierIR: origin retargets the magnified point (world→local via node world)", () => {
  // Node translated to world x=1000; origin at world (1080, 80) → local (80, 80).
  const world = { x: 1000, y: 0, rotation: 0, scale: 1 };
  const m = magnifierPlugin.emit({ shape: "circle", x: 0, y: 0, w: 160, h: 160, magnification: 2, stroke: "#000", strokeWidth: 2, origin: { x: 1080, y: 80 } }, null, world)[0];
  assert.equal(m.originX, 80);
  assert.equal(m.originY, 80);
  // A different origin moves the op's local origin point.
  const m2 = magnifierPlugin.emit({ shape: "circle", x: 0, y: 0, w: 160, h: 160, magnification: 2, stroke: "#000", strokeWidth: 2, origin: { x: 1020, y: 200 } }, null, world)[0];
  assert.equal(m2.originX, 20);
  assert.equal(m2.originY, 200);
});
test("magnifyBackdrop: supersample flag (default true, false honored)", () => {
  assert.equal(magnifyBackdrop({ cx: 0, cy: 0, r: 50, magnification: 2 }).supersample, true);
  assert.equal(magnifyBackdrop({ cx: 0, cy: 0, r: 50, magnification: 2, supersample: false }).supersample, false);
  assert.equal(magnifyBackdrop({ cx: 0, cy: 0, r: 50, magnification: 2, supersample: 1 }).supersample, true); // normalized to bool
});
test("magnifyBackdrop: shape validation + box params + origin default", () => {
  assert.equal(magnifyBackdrop({ cx: 0, cy: 0, r: 50, magnification: 2 }).shape, "circle");
  assert.equal(magnifyBackdrop({ cx: 5, cy: 8, r: 50, magnification: 2 }).originX, 5); // origin defaults to center
  assert.equal(magnifyBackdrop({ shape: "box", cx: 0, cy: 0, halfW: 80, halfH: 50, cornerRadius: 12, magnification: 2 }).cornerRadius, 12);
  assert.throws(() => magnifyBackdrop({ shape: "hex", cx: 0, cy: 0, r: 1, magnification: 1 }), /shape/);
  assert.throws(() => magnifyBackdrop({ shape: "box", cx: 0, cy: 0, halfW: NaN, halfH: 1, magnification: 1 }), /halfW/);
});
test("magnifierIR: emit passes supersample through (state default true)", () => {
  const base = { shape: "circle", x: 0, y: 0, w: 160, h: 160, magnification: 2.5, stroke: "#000", strokeWidth: 4 };
  assert.equal(magnifierPlugin.emit(base)[0].supersample, true); // absent → default true (plugin defaults)
  assert.equal(magnifierPlugin.emit({ ...base, supersample: false })[0].supersample, false);
  assert.equal(magnifierPlugin.emit({ ...base, supersample: true })[0].supersample, true);
});
test("sceneIR: real registry render tree → z-ordered wrapped IR", () => {
  const registry = createRegistry();
  registerAll(registry, createCommands());
  const state = {
    items: {
      a: { type: "rect", x: 10, y: 20, w: 100, h: 50, z: 1, fill: "#7aa2f7", stroke: "#000", strokeWidth: 2, cornerRadius: 4 },
      b: { type: "circle", x: 0, y: 0, w: 80, h: 80, z: 0, fill: "#f7768e", strokeWidth: 0 },
      c: { type: "arrow", z: 2, from: { x: 0, y: 0 }, to: { x: "@a_cm.x", y: "@a_cm.y" }, stroke: "#000", strokeWidth: 3, headLength: 14, headWidth: 12 },
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
// A minimal assembly-context stub for the pure per-command serializers (the real
// SvgAssembly is exercised end-to-end by irToSVG below + the parity suite). It
// gives a fixed ascent fraction and echoes image/video refs as hrefs.
const stubCtx = {
  ascentFraction: () => 0.8,
  imageHref: (ref) => (ref === "__blank__" ? null : `data:image/png;base64,${ref}`),
  videoHref: (ref) => (ref === "__blank__" ? null : `data:image/png;base64,${ref}`),
};

test("similarityTransform / viewTransform: SVG left-to-right composition", () => {
  assert.equal(similarityTransform({ x: 10, y: 0, rotation: 0, scale: 2 }), "translate(10 0) scale(2)");
  assert.equal(similarityTransform({ x: 0, y: 0, rotation: Math.PI / 2, scale: 1 }), "rotate(90)");
  assert.equal(similarityTransform({ x: 0, y: 0, rotation: 0, scale: 1 }), ""); // identity → no group
  assert.equal(viewTransform({ zoom: 2, panX: 5, panY: 6 }), "translate(5 6) scale(2)");
  assert.equal(viewTransform({ zoom: 1, panX: 0, panY: 0 }), "");
});
test("xmlEscape", () => {
  assert.equal(xmlEscape(`<a & "b">`), "&lt;a &amp; &quot;b&quot;&gt;");
});
test("roundedRectPathD: square vs rounded", () => {
  assert.equal(roundedRectPathD({ x: 0, y: 0, w: 10, h: 5, cornerRadius: 0 }), "M0 0 H10 V5 H0 Z");
  const r = roundedRectPathD({ x: 0, y: 0, w: 10, h: 6, cornerRadius: 2 });
  assert.ok(r.startsWith("M2 0"), r);
  assert.equal((r.match(/A/g) || []).length, 4); // four corner arcs
});
test("pointsAttr / groupWrap", () => {
  assert.equal(pointsAttr([[0, 0], [10, 5]]), "0,0 10,5");
  assert.equal(groupWrap("", "<rect/>"), "<rect/>");
  assert.equal(groupWrap("scale(2)", "<rect/>"), '<g transform="scale(2)"><rect/></g>');
});
test("bytesToBase64: round-trips", () => {
  assert.equal(bytesToBase64(new Uint8Array([0, 0, 0])), "AAAA");
  assert.equal(bytesToBase64(new Uint8Array([77, 97, 110])), "TWFu");
});
test("textToSVG: real selectable <text>, baseline from ascent, family from fonts.js", () => {
  const el = textToSVG(text({ text: "Hi <you>", x: 2, y: 4, size: 40, color: "#000" }), stubCtx);
  assert.match(el, /<text /);
  assert.match(el, /y="36"/);              // 4 + 0.8*40
  assert.match(el, /Hi &lt;you&gt;<\/text>$/); // escaped, selectable content
  assert.match(el, /font-family="system-ui, sans-serif"/); // system default
  const inter = textToSVG(text({ text: "x", x: 0, y: 0, size: 10, color: "#000", font: "inter", bold: true }), stubCtx);
  assert.match(inter, /font-family="&quot;PowerRP Inter&quot;, sans-serif"/);
  assert.match(inter, /font-weight="bold"/);
});
test("vectorCommandToSVG: shapes/image serialize, blank image draws nothing, unknown op throws", () => {
  const W = { x: 0, y: 0, rotation: 0, scale: 1 };
  assert.match(vectorCommandToSVG(rect({ x: 0, y: 0, w: 10, h: 5, fill: "#f00", cornerRadius: 2 }), W, stubCtx),
    /<rect .*rx="2".*fill="rgba\(255,0,0,1\)"/);
  assert.match(vectorCommandToSVG(image({ ref: "PNGB", x: 1, y: 2, w: 3, h: 4 }), W, stubCtx),
    /<image .*href="data:image\/png;base64,PNGB"/);
  assert.equal(vectorCommandToSVG(image({ ref: "__blank__", x: 0, y: 0, w: 1, h: 1 }), W, stubCtx), ""); // blank → nothing
  assert.equal(vectorCommandToSVG(rect({ x: 0, y: 0, w: 1, h: 1 }), W, stubCtx), ""); // no fill/stroke → nothing
  assert.throws(() => vectorCommandToSVG({ op: "warp" }, W, stubCtx), /unknown op/);
});
await test("irToSVG: full scene document (async, self-contained)", async () => {
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
  const svg = await irToSVG(ir, { width: 640, height: 360, view: { zoom: 0.5, panX: 0, panY: 0 }, background: "#ffffff", textAscent: 0.8 });
  assert.ok(svg.startsWith("<svg xmlns"));
  assert.match(svg, /<defs>/);                                       // has a defs block
  assert.match(svg, /<rect x="0" y="0" width="100" height="50" rx="4"/);
  assert.match(svg, /rotate\(28.6479\)/);                            // 0.5 rad
  assert.match(svg, /<text /);                                       // TEXT IS TEXT
  assert.match(svg, /Hello &lt;svg&gt;<\/text>/);                    // selectable + escaped
  assert.match(svg, /font-weight="bold"/);
  assert.match(svg, /<g transform="translate\(0 0\) scale\(0.5\)"|scale\(0.5\)/); // view group (pan 0 collapses)
  assert.match(svg, /<\/svg>$/);
});
await test("irToSVG: image ref that is a URL without a resolver THROWS (no external ref)", async () => {
  await assert.rejects(
    irToSVG([image({ ref: "https://example.com/x.png", x: 0, y: 0, w: 4, h: 4 })],
      { width: 10, height: 10, view: { zoom: 1, panX: 0, panY: 0 } }),
    /self-contained/,
  );
});
await test("irToSVG: video op with no videoFrame resolver THROWS (no silent drop)", async () => {
  await assert.rejects(
    irToSVG([video({ ref: "clip", x: 0, y: 0, w: 4, h: 4 })],
      { width: 10, height: 10, view: { zoom: 1, panX: 0, panY: 0 } }),
    /videoFrame resolver/,
  );
});
await test("irToSVG: blur scene needs a rasterize callback (hybrid rule) — THROWS without one", async () => {
  await assert.rejects(
    irToSVG([rect({ x: 0, y: 0, w: 10, h: 10, fill: "#000" }), blurBackdrop({ radius: 4 })],
      { width: 10, height: 10, view: { zoom: 1, panX: 0, panY: 0 } }),
    /raster region/,
  );
});
await test("irToSVG: hybrid rule embeds ONE <image> for the blur region, vector above", async () => {
  const stubRaster = async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]); // fake PNG bytes
  const svg = await irToSVG(
    [rect({ x: 0, y: 0, w: 40, h: 30, fill: "#7aa2f7" }), blurBackdrop({ radius: 3 }),
      rect({ x: 5, y: 5, w: 10, h: 10, fill: "#0f0" })],
    { width: 40, height: 30, view: { zoom: 1, panX: 0, panY: 0 }, background: "#fff", rasterize: stubRaster },
  );
  assert.equal((svg.match(/<image /g) || []).length, 1); // exactly one raster region
  assert.match(svg, /<rect x="5" y="5" width="10" height="10" fill="rgba\(0,255,0,1\)"/); // the above-blur rect stays vector
});
await test("irToSVG: magnifier lens = clipPath circle + magnify group (vector lens) — CIRCLE OUTPUT BYTE-IDENTITY REGRESSION (pre-shape strings preserved)", async () => {
  const svg = await irToSVG(
    [rect({ x: 0, y: 0, w: 100, h: 100, fill: "#7aa2f7" }),
      magnifyBackdrop({ cx: 50, cy: 50, r: 30, magnification: 2, rimColor: "#000", rimWidth: 4 })],
    { width: 100, height: 100, view: { zoom: 1, panX: 0, panY: 0 } },
  );
  // These exact strings are the PRE-SHAPE circle-lens output (shaped-lens task:
  // "circle output stays byte-identical") — clip circle, magnify-about-center
  // transform (origin defaults to center: C − M·C = C·(1−M) → translate(-50 -50)),
  // and the rimColor/rimWidth ring. Do not loosen these matchers.
  assert.match(svg, /<clipPath id="lensclip1"><circle cx="50" cy="50" r="30"\/><\/clipPath>/);
  assert.match(svg, /clip-path="url\(#lensclip1\)"/);
  assert.match(svg, /translate\(-50 -50\) scale\(2\)/);     // center·(1−m) — the pre-origin form
  assert.match(svg, /<circle cx="50" cy="50" r="30" fill="none" stroke="rgba\(0,0,0,1\)" stroke-width="4"\/>/); // rim
});
await test("irToSVG: BOX lens = rounded-rect clipPath + stroked border (stroke/strokeWidth), rotation on the clip child", async () => {
  const svg = await irToSVG(
    [rect({ x: 0, y: 0, w: 200, h: 200, fill: "#7aa2f7" }),
      pushTransform({ x: 100, y: 100, rotation: Math.PI / 4 }),
      magnifyBackdrop({ shape: "box", cx: 0, cy: 0, halfW: 40, halfH: 25, cornerRadius: 8, magnification: 2, stroke: "#000", strokeWidth: 3 }),
      popTransform()],
    { width: 200, height: 200, view: { zoom: 1, panX: 0, panY: 0 } },
  );
  // Clip = rounded-rect path in the box's LOCAL frame (-40,-25 → 80×50, r 8)
  // with the world transform baked onto the clip child (emitCropSVG convention).
  assert.match(svg, /<clipPath id="lensclip1"><path d="M-32 -25[^"]*" transform="translate\(100 100\) rotate\(45\)"\/><\/clipPath>/);
  assert.match(svg, /clip-path="url\(#lensclip1\)"/);
  assert.match(svg, /scale\(2\)/); // magnify group present
  // Border reads the stroked-box bundle: LOCAL stroke-width under the transform.
  assert.match(svg, /<g transform="translate\(100 100\) rotate\(45\)"><path d="M-32 -25[^"]*" fill="none" stroke="rgba\(0,0,0,1\)" stroke-width="3"\/><\/g>/);
  // NO circle ring for a box lens.
  assert.doesNotMatch(svg, /<circle[^>]*stroke/);
});
await test("irToSVG: lens ORIGIN — magnify transform maps origin → center (translate(C − M·O) scale(M))", async () => {
  const svg = await irToSVG(
    [rect({ x: 0, y: 0, w: 100, h: 100, fill: "#7aa2f7" }),
      magnifyBackdrop({ cx: 50, cy: 50, r: 30, magnification: 2, originX: 10, originY: 20, rimColor: "#000", rimWidth: 4 })],
    { width: 100, height: 100, view: { zoom: 1, panX: 0, panY: 0 } },
  );
  // C − M·O = (50 − 2·10, 50 − 2·20) = (30, 10).
  assert.match(svg, /translate\(30 10\) scale\(2\)/);
  // Region/rim geometry is untouched by the origin (only WHAT is magnified moves).
  assert.match(svg, /<clipPath id="lensclip1"><circle cx="50" cy="50" r="30"\/><\/clipPath>/);
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

test("particlesIR: alive particles emit as ellipse ops (free vector path)", () => {
  // A particle emitter renders as plain ellipse ops — no new IR op — so the
  // GPU (instanced SDF discs) and the vector backends (SVG/PDF <ellipse>) draw
  // it with zero backend changes. Drive the sim at a FIXED time via the plugin's
  // pure particleOps so the test needs no ambient clock.
  const parts = simulateParticles(
    { rate: 20, lifetime: 2, originX: 40, originY: 40, angle: 270, spread: 40, speedMin: 30, speedMax: 60, gravityX: 0, gravityY: 80, sizeMin: 2, sizeMax: 4, fade: 1, shrink: 0.3, seed: 5 },
    1.5,
  );
  assert.ok(parts.length > 0 && parts.length <= 41); // bounded (rate·lifetime+1)
  const ops = particleOps(parts, "#ffcc33", 1);
  assert.equal(ops.length, parts.length);
  assert.ok(ops.every((o) => o.op === "ellipse")); // ONLY ellipse ops (no unknown op)
  assert.deepEqual([...new Set(ops.map((o) => o.op))], ["ellipse"]);
  // Every op is valid, transform-flattenable IR (throws would fail the suite).
  const flat = flattenIR([pushTransform({ x: 200, y: 200 }), ...ops, popTransform()]);
  assert.equal(flat.length, ops.length);
  assert.equal(flat[0].cmd.op, "ellipse");
  assert.deepEqual(flat[0].world, { x: 200, y: 200, rotation: 0, scale: 1 });
});
test("particlesIR: a full scene emits through sceneIR to ellipse commands", () => {
  // The whole pipeline: evaluate → derive → sceneIR, with the ambient clock
  // overridden to a fixed time (deterministic). Proves the node's emit() output
  // survives the scene walker as pushTransform+ellipses. A MINIMAL registry
  // (camera + particles) is built directly — NOT via registerAll/plugins/index.js
  // — so this test is self-sufficient (the index.js roster line is the lead's to
  // add) and immune to unrelated plugins' load state.
  const registry = createRegistry();
  registry.register(cameraPlugin);
  registry.register(particlesPlugin);
  setParticleTimeOverride(1.5);
  const raw = {
    meta: { camera: "cam" },
    slides: [{ id: "s0", name: "S0", delta: {
      items: {
        cam: { ...cameraPlugin.defaults, type: "camera", active: true },
        p1: { ...particlesPlugin.defaults, type: "particles", active: true, x: 100, y: 100 },
      },
    } }],
  };
  const state = evaluateState(foldState(raw, 0, 1), registry).state;
  const nodes = deriveRenderTree(state, registry);
  const ir = sceneIR(nodes);
  setParticleTimeOverride(null);
  // At least one ellipse op appears (the particles); camera emits nothing.
  assert.ok(ir.some((c) => c.op === "ellipse"), "no particle ellipse ops in the scene IR");
  // Balanced transform stack (flattenIR throws on imbalance — the strict check).
  assert.doesNotThrow(() => flattenIR(ir));
});
test("particlesIR: a dead emitter (rate 0) is a ghost — emits nothing", () => {
  const world = { x: 0, y: 0, rotation: 0, scale: 1 };
  assert.deepEqual(particlesPlugin.emit({ ...particlesPlugin.defaults, particleRate: 0 }, null, world), []);
  assert.equal(particlesPlugin.isGhost({ particleRate: 0, particleLifetime: 2 }), true);
});

console.log(`\nrender_gpu tests: ${passed} passed`);
