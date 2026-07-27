/**
 * THE BACKDROP-REGION EXPORT CONTRACT — plain node, no framework
 * (core_test.js / effects_test.js style).
 * Run: node src/demo_apps/PowerRP/render_gpu/tests/backdrop_export_region_test.js
 *
 * ── THE BUG THIS EXISTS TO MAKE IMPOSSIBLE ────────────────────────────────────
 * Backdrop-sampling materials (metaballs, comic halftone, CRT, glass — every
 * `materialBackdrop` / `glassBackdrop` / `blurBackdrop`) exported BLACK from PDF
 * and SVG. Root cause: a sampler does not read the surface it draws on, it
 * RE-RENDERS the content below it into a fresh offscreen and samples that — so it
 * sees only DRAWN ops, never the surface CLEAR. The exporters handed their raster
 * regions the page background as the clear ALONE, so a material over empty page
 * sampled pure transparency. Measured over a light page: the sampled region's mean
 * was rgb(26,18,25) with 92% of its opaque pixels near-black, against the editor's
 * rgb(220,204,184). The editor never had the bug because its frame recipe
 * (web/cameraFrame.js cameraFrameIR) emits the background as a real rect op AND
 * passes it as the clear.
 *
 * So this suite pins the exporters' half of the contract, for BOTH backends:
 *
 *   1. regionOverBackground's own behavior (background → drawn rect; transparent
 *      and absent backgrounds left alone).
 *   2. EVERY raster region a backend mints over an opaque region background gets
 *      that background as a DRAWN op — the blur split, the general raster-op
 *      fallback, and the deep-lens fallback.
 *   3. An EFFECT region keeps its TRANSPARENT background undisturbed (its alpha is
 *      what composites the widget onto the page; an opaque rect would wreck it).
 *   4. A backdrop-sampling op is rasterized with the WHOLE below-content of its
 *      region, so the sampler has scene content to sample and not just the
 *      background.
 *   5. PDF and SVG hand the rasterizer the SAME command list for the same scene —
 *      the two exporters cannot drift apart on any of the above.
 */

import assert from "node:assert/strict";
import { rect, ellipse, blurBackdrop, materialBackdrop, magnifyBackdrop, effectSubtree, parseColor, pushTransform, popTransform } from "../ir.js";
import { irToPDF, regionOverBackground } from "../pdf_backend.js";
import { irToSVG } from "../svg_backend.js";

let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`  ok  ${name}`); }
async function atest(name, fn) { await fn(); passed++; console.log(`  ok  ${name}`); }

const IDENTITY = { x: 0, y: 0, rotation: 0, scale: 1 };
const PAGE_BG = "#f4f4f0";
const PAGE = { width: 200, height: 150, view: { zoom: 1, panX: 0, panY: 0 }, background: PAGE_BG };

// The 1x1 stub PNG every exporter suite uses (verbatim from pdf_backend_test.js /
// effects_test.js — the structural assertions ask WHETHER a raster region was
// emitted and with WHICH commands, never what the pixels are).
const STUB_PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));

let rasterCalls = [];
/** Command (records the call). The injected raster hook both backends share. */
async function rasterize(ir, view, w, h, background) {
  rasterCalls.push({ ir, view, w, h, background });
  return STUB_PNG;
}

/** Query→build. Shared page content the samplers sit over. */
const content = () => [
  rect({ x: 10, y: 10, w: 60, h: 40, fill: "#7aa2f7" }),
  ellipse({ cx: 150, cy: 100, rx: 30, ry: 20, fill: "#f7768e" }),
];

/** Pure function. Is `cmd` a full-cover background rect painted in `rgba`?
 * @example // backgroundRectOf({op: "rect", fill: [1, 0, 0, 1]}, [1, 0, 0, 1]) // true
 */
function isBackgroundRect(cmd, rgba) {
  return cmd?.op === "rect" && Array.isArray(cmd.fill) && cmd.fill.every((v, i) => v === rgba[i]);
}

// ── 1. regionOverBackground ──────────────────────────────────────────────────

test("regionOverBackground: an opaque background becomes a DRAWN rect over srcRect", () => {
  const src = { x: 2, y: 1, w: 4, h: 3 };
  const out = regionOverBackground([rect({ x: 0, y: 0, w: 1, h: 1, fill: "#000" })], src, "#ff0000");
  assert.equal(out.length, 2);
  assert.deepEqual({ op: out[0].op, x: out[0].x, y: out[0].y, w: out[0].w, h: out[0].h }, { op: "rect", ...src });
  assert.deepEqual(out[0].fill, [1, 0, 0, 1]);
});

test("regionOverBackground: absent or transparent background leaves commands untouched", () => {
  const cmds = [rect({ x: 0, y: 0, w: 1, h: 1, fill: "#000" })];
  assert.equal(regionOverBackground(cmds, { x: 0, y: 0, w: 1, h: 1 }, null), cmds);
  assert.equal(regionOverBackground(cmds, { x: 0, y: 0, w: 1, h: 1 }, undefined), cmds);
  assert.equal(regionOverBackground(cmds, { x: 0, y: 0, w: 1, h: 1 }, [0, 0, 0, 0]), cmds);
});

test("regionOverBackground: a paint-object background resolves to the SAME solid the clear uses", () => {
  const paint = { type: "solid", solid: "#00ff00" };
  const out = regionOverBackground([], { x: 0, y: 0, w: 1, h: 1 }, paint);
  assert.deepEqual(out[0].fill, parseColor(paint));
});

// ── 2. every opaque raster region gets the background as a DRAWN op ──────────

const OPAQUE_REGION_SCENES = {
  // blurBackdrop: the region's LAST blur claims everything below as one raster.
  blur_split: [...content(), blurBackdrop({ radius: 4 })],
  // materialBackdrop: no vector form ⇒ the general raster-op fallback.
  material_op: [...content(), materialBackdrop({ material: "comic", cx: 100, cy: 75, halfW: 50, halfH: 40 })],
  // A lens beyond the re-emit cap falls back to a raster of its source square.
  deep_lens: [...content(),
    magnifyBackdrop({ shape: "circle", cx: 60, cy: 60, r: 30, magnification: 2 }),
    magnifyBackdrop({ shape: "circle", cx: 120, cy: 80, r: 25, magnification: 2 })],
};

for (const [name, commands] of Object.entries(OPAQUE_REGION_SCENES)) {
  await atest(`PDF ${name}: every raster region is drawn OVER the page background (sampler-visible)`, async () => {
    rasterCalls = [];
    await irToPDF(commands, { ...PAGE, rasterize });
    assert.ok(rasterCalls.length >= 1, `${name} produced no raster region`);
    const rgba = parseColor(PAGE_BG);
    for (const call of rasterCalls) {
      assert.ok(isBackgroundRect(call.ir[0], rgba), `${name}: a raster region's first op is not the page-background rect — a backdrop sampler inside it would sample transparency and export BLACK`);
      assert.deepEqual(parseColor(call.background), rgba, `${name}: the region background must ALSO stay the surface clear (belt and braces, the editor's convention)`);
    }
  });

  await atest(`SVG ${name}: same contract, same background rect`, async () => {
    rasterCalls = [];
    await irToSVG(commands, { ...PAGE, rasterize });
    assert.ok(rasterCalls.length >= 1, `${name} produced no raster region`);
    const rgba = parseColor(PAGE_BG);
    for (const call of rasterCalls)
      assert.ok(isBackgroundRect(call.ir[0], rgba), `${name}: an SVG raster region is missing the page-background rect`);
  });
}

// ── 3. effect regions keep their transparent background ──────────────────────

await atest("BOTH: an EFFECT region rasters over TRANSPARENT with no background rect prepended", async () => {
  const scene = [...content(), effectSubtree({
    x: 40, y: 30, w: 80, h: 60, bloom: { radius: 5, strength: 1 },
    content: [pushTransform(IDENTITY), rect({ x: 40, y: 30, w: 80, h: 60, fill: "#ffd166" }), popTransform()],
  })];
  for (const [label, run] of [["PDF", irToPDF], ["SVG", irToSVG]]) {
    rasterCalls = [];
    await run(scene, { ...PAGE, rasterize });
    const effectRasters = rasterCalls.filter(({ ir }) => ir.some((c) => c.op === "effectSubtree"));
    assert.ok(effectRasters.length >= 1, `${label}: the bloom effect produced no raster region`);
    for (const call of effectRasters) {
      assert.deepEqual(call.background, [0, 0, 0, 0], `${label}: an effect region must raster over transparency`);
      assert.equal(call.ir[0].op, "pushTransform", `${label}: an opaque background rect leaked into an effect region — it would destroy the alpha that composites the widget onto the page`);
    }
  }
});

// ── 4. a sampler is rasterized with the whole below-content of its region ────

await atest("BOTH: a backdrop-sampling op's raster carries the content BELOW it, not just the op", async () => {
  const scene = [...content(), materialBackdrop({ material: "comic", cx: 100, cy: 75, halfW: 50, halfH: 40 })];
  for (const [label, run] of [["PDF", irToPDF], ["SVG", irToSVG]]) {
    rasterCalls = [];
    await run(scene, { ...PAGE, rasterize });
    assert.equal(rasterCalls.length, 1, `${label}: expected exactly one raster region for the material op`);
    const ops = rasterCalls[0].ir.map((c) => c.op);
    assert.ok(ops.includes("rect") && ops.includes("ellipse"), `${label}: the material's raster is missing the below-content (${JSON.stringify(ops)}) — the sampler would have nothing to sample`);
    assert.equal(ops[ops.length - 1], "materialBackdrop", `${label}: the op itself must be LAST so the sampler applies to everything before it`);
  }
});

// ── 5. the two backends cannot drift ─────────────────────────────────────────

await atest("PARITY: PDF and SVG hand the rasterizer IDENTICAL command lists per region", async () => {
  for (const [name, commands] of Object.entries(OPAQUE_REGION_SCENES)) {
    rasterCalls = [];
    await irToPDF(commands, { ...PAGE, rasterize });
    const pdfOps = rasterCalls.map(({ ir }) => ir.map((c) => c.op).join(","));
    rasterCalls = [];
    await irToSVG(commands, { ...PAGE, rasterize });
    const svgOps = rasterCalls.map(({ ir }) => ir.map((c) => c.op).join(","));
    assert.deepEqual(svgOps, pdfOps, `${name}: the two exporters rasterize DIFFERENT commands — one of them is wrong`);
  }
});

console.log(`\n${passed} backdrop-region export checks passed`);
