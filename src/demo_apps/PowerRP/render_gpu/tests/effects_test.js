/**
 * EFFECTS SUBSTRATE tests (manifest Round 12D: drop shadow + bloom + blend
 * mode) — plain node, no framework (core_test.js style).
 * Run: node src/demo_apps/PowerRP/render_gpu/tests/effects_test.js
 *
 * Covers the DOM-free layers: the effectSubtree IR builder, the shared
 * render-half wrapper (render_gpu/effects.js), the property-registry effects
 * bundle, the EFFECT-OFF BYTE-IDENTITY guarantee at the plugin emit level
 * (the Round 12D "every old doc is byte-identical" requirement), the culling
 * margin hook, and PDF STRUCTURAL assertions for the hybrid rule (raster
 * shadow under vector content; /BM blend ExtGStates; the add-blend raster
 * split). Real-GPU pixels are tests/effects_probe.js (browser).
 */

import assert from "node:assert/strict";
import { effectSubtree, BLEND_MODES, rect, ellipse, text, polyline, polygon, pushTransform, popTransform, parseColor } from "../ir.js";
import { effectsOff, applyEffects, effectsCullMargin, paddedPointsBBox } from "../effects.js";
import { PROPS, BUNDLES, bundle, bundleNestedDefaults } from "../../core/properties.js";
import { defaultCanSkip } from "../../core/view.js";
import { irToPDF } from "../pdf_backend.js";
import { rectPlugin } from "../../plugins/rect.js";
import { circlePlugin } from "../../plugins/circle.js";
import { arrowPlugin } from "../../plugins/arrow.js";
import { donutPlugin } from "../../plugins/donut.js";
import { imagePlugin } from "../../plugins/image.js";
import { CHECKER_PNG_DATA_URI } from "../../tests/fixtures/checker_png.js";

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}
async function atest(name, fn) {
  await fn();
  passed++;
  console.log(`  ok  ${name}`);
}

const IDENTITY = { x: 0, y: 0, rotation: 0, scale: 1 };
const SHADOW_ON = { dx: 3, dy: 4, blur: 2, color: "#000000", opacity: 0.5 };

// ── ir.js effectSubtree builder ──────────────────────────────────────────────

test("effectSubtree: margin = 3σ blur spill + shadow offset length", () => {
  const op = effectSubtree({ x: 0, y: 0, w: 10, h: 10, content: [], shadow: SHADOW_ON });
  assert.equal(op.margin, 2 * 3 + 5); // 3σ of blur 2 + hypot(3,4)=5
  const bloomOp = effectSubtree({ x: 0, y: 0, w: 10, h: 10, content: [], bloom: { radius: 5, strength: 1 } });
  assert.equal(bloomOp.margin, 15);
  const blendOp = effectSubtree({ x: 0, y: 0, w: 10, h: 10, content: [], blend: "multiply" });
  assert.equal(blendOp.margin, 0); // blend alone adds no halo
});

test("effectSubtree: normalizes shadow color, clamps negatives, validates blend", () => {
  const op = effectSubtree({ x: 0, y: 0, w: 10, h: 10, content: [], shadow: { ...SHADOW_ON, color: "#ff0000" } });
  assert.deepEqual(op.shadow.color, [1, 0, 0, 1]);
  assert.throws(() => effectSubtree({ x: 0, y: 0, w: 1, h: 1, content: [], blend: "overlay" }), /unknown blend/);
  assert.throws(() => effectSubtree({ x: 0, y: 0, w: 1, h: 1, content: [] }), /no effect is on/);
  assert.throws(() => effectSubtree({ x: 0, y: NaN, w: 1, h: 1, content: [], blend: "add" }), /finite/);
});

test("BLEND_MODES: ir.js and the property registry's blendMode options agree", () => {
  // The registry keeps a literal list (core/ never imports render_gpu/) —
  // this assertion is the declared sync mechanism (see properties.js comment).
  assert.deepEqual(PROPS.blendMode.options, BLEND_MODES);
});

// ── render_gpu/effects.js ────────────────────────────────────────────────────

test("effectsOff: absent/off states are off; any live effect is on", () => {
  assert.equal(effectsOff({}), true);
  assert.equal(effectsOff(bundleNestedDefaults("effects")), true); // the registry defaults ARE off (opacity 0)
  // 14.8: OPACITY is the gate, not blur. A blur-0 shadow with opacity>0 is a
  // VISIBLE hard-edged offset shadow — ON, not off.
  assert.equal(effectsOff({ shadow: { ...SHADOW_ON, blur: 0 } }), false);
  assert.equal(effectsOff({ shadow: { ...SHADOW_ON, opacity: 0 } }), true); // opacity 0 = off, at any blur
  assert.equal(effectsOff({ shadow: SHADOW_ON }), false);
  assert.equal(effectsOff({ bloom: { radius: 10, strength: 0 } }), true);
  assert.equal(effectsOff({ bloom: { radius: 10, strength: 0.5 } }), false);
  assert.equal(effectsOff({ blendMode: "normal" }), true);
  assert.equal(effectsOff({ blendMode: "screen" }), false);
});

test("applyEffects: pass-through is the SAME array (zero-cost identity)", () => {
  const content = [rect({ x: 0, y: 0, w: 5, h: 5, fill: "#fff" })];
  assert.equal(applyEffects(content, {}, IDENTITY, { x: 0, y: 0, w: 5, h: 5 }), content);
});

test("applyEffects: wraps content in ONE effectSubtree carrying the world", () => {
  const content = [rect({ x: 0, y: 0, w: 5, h: 5, fill: "#fff" })];
  const world = { x: 7, y: 8, rotation: 0.5, scale: 2 };
  const out = applyEffects(content, { shadow: SHADOW_ON, blendMode: "multiply" }, world, { x: 0, y: 0, w: 5, h: 5 });
  assert.equal(out.length, 1);
  assert.equal(out[0].op, "effectSubtree");
  assert.equal(out[0].blend, "multiply");
  assert.equal(out[0].bloom, null);
  // content follows the decorate.js absolute-world contract
  assert.deepEqual(out[0].content[0], pushTransform(world));
  assert.equal(out[0].content[1], content[0]);
  assert.deepEqual(out[0].content[2], popTransform());
  assert.throws(() => applyEffects(content, { shadow: SHADOW_ON }, undefined, { x: 0, y: 0, w: 5, h: 5 }), /world/);
});

test("effectsCullMargin: matches the builder's margin; 0 when off", () => {
  assert.equal(effectsCullMargin({}), 0);
  assert.equal(effectsCullMargin({ shadow: SHADOW_ON }), 11);
  assert.equal(
    effectsCullMargin({ shadow: SHADOW_ON }),
    effectSubtree({ x: 0, y: 0, w: 1, h: 1, content: [], shadow: SHADOW_ON }).margin,
  );
  assert.equal(effectsCullMargin({ bloom: { radius: 4, strength: 1 } }), 12);
});

test("paddedPointsBBox: AABB + per-side pad; throws on empty", () => {
  assert.deepEqual(paddedPointsBBox([{ x: 10, y: 20 }, { x: 110, y: 60 }], 5), { x: 5, y: 15, w: 110, h: 50 });
  assert.throws(() => paddedPointsBBox([], 1), /point/);
});

// ── the EFFECT-OFF BYTE-IDENTITY guarantee (Round 12D) ───────────────────────

test("rect/circle/arrow/donut emit with DEFAULT state = plain ops, no effect op", () => {
  for (const plugin of [rectPlugin, circlePlugin, arrowPlugin, donutPlugin]) {
    const ops = plugin.emit(plugin.defaults, null, IDENTITY);
    assert.ok(ops.length > 0, `${plugin.type}: defaults draw something`);
    assert.ok(ops.every((o) => o.op !== "effectSubtree"), `${plugin.type}: defaults emit NO effect op (byte-identity)`);
  }
});

test("rect with a live shadow emits ONE effectSubtree wrapping its plain op", () => {
  const s = { ...rectPlugin.defaults, shadow: SHADOW_ON };
  const ops = rectPlugin.emit(s, null, IDENTITY);
  assert.equal(ops.length, 1);
  assert.equal(ops[0].op, "effectSubtree");
  assert.equal(ops[0].content[1].op, "rect"); // [pushTransform, rect, popTransform]
  assert.deepEqual({ x: ops[0].x, y: ops[0].y, w: ops[0].w, h: ops[0].h }, { x: 0, y: 0, w: s.w, h: s.h });
});

test("arrow with bloom wraps in an endpoint-spanning effect region", () => {
  const s = { ...arrowPlugin.defaults, bloom: { radius: 5, strength: 1 } };
  const ops = arrowPlugin.emit(s, null, IDENTITY);
  assert.equal(ops[0].op, "effectSubtree");
  const pad = Math.max(s.strokeWidth, s.headWidth);
  assert.equal(ops[0].x, Math.min(s.from.x, s.to.x) - pad);
  assert.equal(ops[0].w, Math.abs(s.to.x - s.from.x) + 2 * pad);
});

test("registry: effects bundle rows are complete, categorized, and documented", () => {
  const rows = bundle("effects");
  assert.deepEqual(rows.map((r) => r.key), BUNDLES.effects);
  assert.ok(rows.every((r) => r.category === "effects"));
  assert.ok(rows.every((r) => typeof r.help === "string" && r.help.length > 0));
  const d = bundleNestedDefaults("effects");
  assert.equal(d.shadow.blur, 0);       // effect-off defaults
  assert.equal(d.bloom.strength, 0);
  assert.equal(d.blendMode, "normal");
});

// ── culling: the cullMargin hook extends the AABB ────────────────────────────

test("defaultCanSkip: effects halo keeps a just-offscreen widget rendered", () => {
  const view = { x: 0, y: 0, w: 100, h: 100 };
  const mkNode = (state) => ({
    state, world: { x: 105, y: 0, rotation: 0, scale: 1 },
    plugin: { capabilities: { bbox: true }, cullMargin: effectsCullMargin },
  });
  // 10 units offscreen (bbox 105..115): effects off → skip.
  assert.equal(defaultCanSkip(mkNode({ w: 10, h: 10 }), view), true);
  // shadow halo 11 units → reaches back into view → must NOT skip.
  assert.equal(defaultCanSkip(mkNode({ w: 10, h: 10, shadow: SHADOW_ON }), view), false);
});

// ── PDF hybrid rule (structural; stub raster like pdf_backend_test) ──────────

/** 1×1 transparent PNG raster stub (pdf_backend_test precedent). */
const STUB_PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
let rasterCalls;
const stubRasterize = async (cmds) => { rasterCalls.push(cmds); return STUB_PNG; };
const PDF_OPTS = { width: 200, height: 200, view: { zoom: 1, panX: 0, panY: 0 }, rasterize: stubRasterize };
const pdfText = async (cmds) => {
  rasterCalls = [];
  const bytes = await irToPDF(cmds, PDF_OPTS);
  return Buffer.from(bytes).toString("latin1");
};
const shadowRect = (blend = "normal", bloom = null) => effectSubtree({
  x: 20, y: 20, w: 60, h: 40,
  shadow: SHADOW_ON, bloom, blend,
  content: [pushTransform(IDENTITY), rect({ x: 20, y: 20, w: 60, h: 40, fill: "#7aa2f7" }), popTransform()],
});

await atest("PDF: shadow = raster region UNDER vector content (the hybrid rule's verbatim case)", async () => {
  const pdf = await pdfText([shadowRect()]);
  assert.match(pdf, /\/Im1 Do/);                    // the shadow PNG
  assert.match(pdf, /re\nf/);                       // the rect stays VECTOR
  assert.equal(rasterCalls.length, 1);
  assert.equal(rasterCalls[0][1].shadowOnly, true); // only the shadow rasterized
});

await atest("PDF: shadowed TEXT keeps real text operators (text stays text)", async () => {
  const op = effectSubtree({
    x: 0, y: 0, w: 100, h: 40, shadow: SHADOW_ON,
    content: [pushTransform(IDENTITY), text({ text: "Hi", x: 0, y: 0, size: 24, color: "#000" }), popTransform()],
  });
  const pdf = await pdfText([op]);
  assert.match(pdf, /\/Im1 Do/); // shadow raster
  assert.match(pdf, /Tj/);       // vector text survived
});

await atest("PDF: bloom → the widget becomes ONE raster region (no vector rect)", async () => {
  const op = effectSubtree({
    x: 20, y: 20, w: 60, h: 40, bloom: { radius: 5, strength: 1 },
    content: [pushTransform(IDENTITY), rect({ x: 20, y: 20, w: 60, h: 40, fill: "#7aa2f7" }), popTransform()],
  });
  const pdf = await pdfText([op]);
  assert.match(pdf, /\/Im1 Do/);
  assert.doesNotMatch(pdf, /re\nf/); // rect consumed into the raster
});

await atest("PDF: multiply blend → raster under an exact /BM Multiply ExtGState", async () => {
  const pdf = await pdfText([effectSubtree({
    x: 20, y: 20, w: 60, h: 40, blend: "multiply",
    content: [pushTransform(IDENTITY), rect({ x: 20, y: 20, w: 60, h: 40, fill: "#7aa2f7" }), popTransform()],
  })]);
  assert.match(pdf, /\/BM \/Multiply/);
  assert.match(pdf, /\/GSbm\d+ gs/);
});

await atest("PDF: add blend → the everything-below raster split (the blur precedent)", async () => {
  rasterCalls = [];
  const below = rect({ x: 0, y: 0, w: 100, h: 100, fill: "#9ece6a" });
  const addOp = effectSubtree({
    x: 20, y: 20, w: 60, h: 40, blend: "add",
    content: [pushTransform(IDENTITY), rect({ x: 20, y: 20, w: 60, h: 40, fill: "#7aa2f7" }), popTransform()],
  });
  const above = ellipse({ cx: 150, cy: 150, rx: 20, ry: 20, fill: "#f7768e" });
  const bytes = await irToPDF([below, addOp, above], PDF_OPTS);
  const pdf = Buffer.from(bytes).toString("latin1");
  assert.match(pdf, /\/Im1 Do/);       // the split raster (below + the add widget)
  assert.doesNotMatch(pdf, /re\nf/);   // the below-rect was consumed by the split
  assert.match(pdf, /c\n/);            // the ellipse ABOVE stays vector (bezier ops)
  assert.equal(rasterCalls.length, 1);
  assert.equal(rasterCalls[0].length, 2, "split slice = [below rect, add-effect op]");
});

await atest("PDF: shadowed image content embeds its media (refs walk into effect content)", async () => {
  const op = effectSubtree({
    x: 0, y: 0, w: 32, h: 32, shadow: SHADOW_ON,
    content: [pushTransform(IDENTITY), { ...imagePlugin.emit({ ...imagePlugin.defaults, src: CHECKER_PNG_DATA_URI, w: 32, h: 32 }, null, IDENTITY)[0] }, popTransform()],
  });
  const pdf = await pdfText([op]);
  // ImN = the shadow raster region; ImgN = the content image's own XObject
  // (embedded because refsOfOp walks into effect content).
  assert.match(pdf, /\/Im\d+ Do/);
  assert.match(pdf, /\/Img\d+ Do/);
});

console.log(`${passed} effects tests passed`);
