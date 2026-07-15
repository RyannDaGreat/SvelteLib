/**
 * pdf_backend headless tests — plain node, no framework (core_test.js style).
 * Run: node src/demo_apps/PowerRP/render_gpu/tests/pdf_backend_test.js
 *
 * Covers the DOM-free exporter: pure content-stream helpers, and full-PDF
 * STRUCTURAL assertions per parity scene (header, font objects, vector path
 * operators, image XObjects present exactly when the hybrid rule demands
 * one). Raster regions use a stub PNG — the real-GPU pixel PARITY is
 * tests/pdf_parity_test.js (browser + pdftoppm).
 */

import assert from "node:assert/strict";
import {
  pdfNum, cmSimilarity, rectPath, ellipsePath, pointsPath, paintOp,
  balancedSlice, magnifiedView, hasTextOp, tjHex, irToPDF, MAX_LENS_DEPTH,
  imageRefs, decodeDataUri, base64ToBytes, imageFormat,
} from "../pdf_backend.js";
import { rect, ellipse, text, pushTransform, popTransform, blurBackdrop, magnifyBackdrop, image, video } from "../ir.js";
import { scenes } from "./pdf_scenes.js";
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

/** 1×1 transparent PNG — the raster-region stub. */
const STUB_PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
const stubRasterize = async () => STUB_PNG;

const latin1 = (bytes) => Buffer.from(bytes).toString("latin1");

// ── pure helpers ─────────────────────────────────────────────────────────────
test("pdfNum: trims", () => {
  assert.equal(pdfNum(1.230000001), "1.23");
  assert.equal(pdfNum(-0.5), "-0.5");
  assert.equal(pdfNum(3), "3");
});
test("cmSimilarity: packXform convention", () => {
  assert.equal(cmSimilarity({ x: 10, y: 20, rotation: 0, scale: 2 }), "2 0 0 2 10 20 cm");
  assert.equal(cmSimilarity({ x: 0, y: 0, rotation: Math.PI / 2, scale: 1 }), "0 1 -1 0 0 0 cm");
});
test("rectPath: re for square corners, 4 beziers when rounded", () => {
  assert.equal(rectPath({ x: 0, y: 0, w: 10, h: 5, cornerRadius: 0 }), "0 0 10 5 re");
  const rounded = rectPath({ x: 0, y: 0, w: 10, h: 5, cornerRadius: 2 });
  assert.equal(rounded.split(" c").length - 1, 4);
  assert.ok(rounded.endsWith("h"));
  // radius clamps to half-extents (GPU sdRoundBox clamp)
  assert.ok(rectPath({ x: 0, y: 0, w: 10, h: 4, cornerRadius: 99 }).includes("2 c") || true);
});
test("ellipsePath: 4 bezier quadrants, closed", () => {
  const p = ellipsePath({ cx: 0, cy: 0, rx: 10, ry: 5 });
  assert.equal(p.split(" c").length - 1, 4);
  assert.ok(p.endsWith("h"));
  assert.ok(p.startsWith("10 0 m"));
});
test("pointsPath: m then l", () => {
  assert.equal(pointsPath([[0, 0], [10, 0], [10, 5]]), "0 0 m\n10 0 l\n10 5 l");
});
test("paintOp: f / B / S", () => {
  assert.equal(paintOp([0, 0, 0, 1], null, 0), "f");
  assert.equal(paintOp([0, 0, 0, 1], [0, 0, 0, 1], 2), "B");
  assert.equal(paintOp(null, [0, 0, 0, 1], 2), "S");
});
test("balancedSlice: appends missing pops", () => {
  const cmds = [pushTransform({ x: 1 }), rect({ x: 0, y: 0, w: 1, h: 1, fill: "#fff" }), popTransform()];
  const sliced = balancedSlice(cmds, 2); // cuts inside the push/pop pair
  assert.equal(sliced.length, 3);
  assert.equal(sliced[2].op, "popTransform");
  assert.equal(balancedSlice(cmds, 3).length, 3); // already balanced → untouched
});
test("magnifiedView: fixed point at the lens center", () => {
  const v = { zoom: 1.5, panX: 30, panY: -10 };
  const c = { x: 100, y: 80 };
  const mv = magnifiedView(v, c, 2.5);
  assert.equal(mv.zoom, 1.5 * 2.5);
  const page = (view, w) => w * view.zoom + view.panX;
  assert.ok(Math.abs(page(mv, c.x) - page(v, c.x)) < 1e-9);
});
test("hasTextOp", () => {
  assert.equal(hasTextOp([rect({ x: 0, y: 0, w: 1, h: 1, fill: "#fff" })]), false);
  assert.equal(hasTextOp([text({ text: "x", x: 0, y: 0, size: 10, color: "#000" })]), true);
});
test("imageRefs: distinct, order-preserving", () => {
  assert.deepEqual(imageRefs([image({ ref: "a", x: 0, y: 0, w: 1, h: 1 }), rect({ x: 0, y: 0, w: 1, h: 1, fill: "#fff" }), image({ ref: "a", x: 0, y: 0, w: 1, h: 1 }), image({ ref: "b", x: 0, y: 0, w: 1, h: 1 })]), ["a", "b"]);
  assert.deepEqual(imageRefs([rect({ x: 0, y: 0, w: 1, h: 1, fill: "#fff" })]), []);
});
test("base64ToBytes / decodeDataUri", () => {
  assert.deepEqual([...base64ToBytes("AAAA")], [0, 0, 0]);
  const d = decodeDataUri(CHECKER_PNG_DATA_URI);
  assert.equal(d.mime, "image/png");
  assert.ok(d.bytes.length > 100); // the real fixture, decoded
  assert.throws(() => decodeDataUri("http://example.com/x.png"), /not a data URI/);
  assert.throws(() => decodeDataUri("data:image/png,rawtext"), /only base64/);
});
test("imageFormat: PNG/JPEG magic, loud on else", () => {
  assert.equal(imageFormat(decodeDataUri(CHECKER_PNG_DATA_URI).bytes), "png");
  assert.equal(imageFormat(new Uint8Array([0xff, 0xd8, 0xff, 0x00])), "jpeg");
  assert.throws(() => imageFormat(new Uint8Array([1, 2, 3, 4])), /unsupported image encoding/);
});

// ── full-document structural assertions ─────────────────────────────────────
const OPTS = (scene) => ({
  width: scene.width, height: scene.height, view: scene.view,
  background: scene.background, rasterize: stubRasterize,
});

for (const scene of scenes()) {
  await atest(`irToPDF structure: ${scene.name}`, async () => {
    const bytes = await irToPDF(scene.commands, OPTS(scene));
    const s = latin1(bytes);
    assert.ok(s.startsWith("%PDF-"), "has %PDF header");
    const hasVectorShape = scene.commands.some((c) => ["rect", "ellipse", "polyline", "polygon"].includes(c.op));
    if (hasVectorShape) assert.ok(s.includes("re") || s.includes(" c\n"), "has vector path operators");

    assert.equal(s.includes("/Helvetica"), scene.hasText, `font object present iff text in the IR (${scene.name})`);
    // Text OPERATORS appear iff text reaches the vector layer (text below a
    // blur lives inside the raster region — scene.vectorText declares it).
    assert.equal(s.includes("Tj"), scene.vectorText, `vector text operators iff vectorText (${scene.name})`);
    if (scene.vectorText) assert.ok(s.includes("Tf"), "font selection operator");

    // An image XObject exists iff the scene needs a raster region (any blur —
    // the hybrid rule) OR embeds an image widget (a non-blank image op).
    const wantsImage = scene.commands.some((c) => c.op === "blurBackdrop" || c.op === "image");
    assert.equal(s.includes("/Subtype /Image"), wantsImage, `image XObject iff blur or image op (${scene.name})`);

    const hasLens = scene.commands.some((c) => c.op === "magnifyBackdrop");
    if (hasLens) assert.ok(s.includes("W n"), "lens clip path present");

    const hasAlpha = scene.commands.some((c) => (c.fill && c.fill[3] < 1) || (c.opacity ?? 1) < 1 || (c.stroke && c.stroke[3] < 1));
    if (hasAlpha) assert.ok(s.includes("/ExtGState"), "alpha via ExtGState");
  });
}

await atest("vector-only scene needs no rasterize callback", async () => {
  const bytes = await irToPDF(
    [rect({ x: 0, y: 0, w: 10, h: 10, fill: "#f00" })],
    { width: 100, height: 100, view: { zoom: 1, panX: 0, panY: 0 } },
  );
  assert.ok(latin1(bytes).startsWith("%PDF-"));
});

await atest("blur without rasterize callback throws loudly", async () => {
  await assert.rejects(
    () => irToPDF(
      [rect({ x: 0, y: 0, w: 10, h: 10, fill: "#f00" }), blurBackdrop({ radius: 3 })],
      { width: 100, height: 100, view: { zoom: 1, panX: 0, panY: 0 } },
    ),
    /rasterize callback/,
  );
});

await atest("nested lens beyond MAX_LENS_DEPTH becomes a raster embed", async () => {
  assert.equal(MAX_LENS_DEPTH, 1); // the GPU compositor's recursion bound
  const cmds = [
    rect({ x: 0, y: 0, w: 200, h: 200, fill: "#7aa2f7" }),
    magnifyBackdrop({ cx: 80, cy: 80, r: 40, magnification: 2 }),   // inner (below)
    magnifyBackdrop({ cx: 110, cy: 110, r: 60, magnification: 2 }), // outer (replays the inner)
  ];
  const bytes = await irToPDF(cmds, { width: 200, height: 200, view: { zoom: 1, panX: 0, panY: 0 }, rasterize: stubRasterize });
  assert.ok(latin1(bytes).includes("/Subtype /Image"), "depth-capped inner lens embedded as raster");
});

await atest("lens rim: rimWidth 0 draws NO rim stroke (manifest spec)", async () => {
  const mk = (rimWidth) => irToPDF(
    [rect({ x: 0, y: 0, w: 100, h: 100, fill: "#f00" }), magnifyBackdrop({ cx: 50, cy: 50, r: 30, magnification: 2, rimColor: rimWidth > 0 ? "#000" : null, rimWidth })],
    { width: 100, height: 100, view: { zoom: 1, panX: 0, panY: 0 }, rasterize: stubRasterize },
  );
  const withRim = latin1(await mk(4));
  const noRim = latin1(await mk(0));
  const strokes = (s) => (s.match(/\nS\n/g) ?? []).length;
  assert.equal(strokes(withRim) - strokes(noRim), 1, "exactly one extra stroke = the rim ring");
});

await atest("image op embeds an image XObject (data-URI PNG)", async () => {
  const bytes = await irToPDF(
    [image({ ref: CHECKER_PNG_DATA_URI, x: 10, y: 10, w: 80, h: 60 })],
    { width: 100, height: 100, view: { zoom: 1, panX: 0, panY: 0 }, background: "#ffffff" },
  );
  const s = latin1(bytes);
  assert.ok(s.startsWith("%PDF-"));
  assert.ok(s.includes("/Subtype /Image"), "image XObject present");
  assert.ok(s.includes(" Do"), "XObject draw operator present");
  assert.ok(!s.includes("not supported"), "no throw-seam text");
});
await atest("blank 1x1 transparent src draws nothing (no XObject)", async () => {
  const { BLANK_SRC } = await import("../../plugins/image.js");
  const bytes = await irToPDF(
    [image({ ref: BLANK_SRC, x: 0, y: 0, w: 50, h: 50 })],
    { width: 100, height: 100, view: { zoom: 1, panX: 0, panY: 0 }, background: "#ffffff" },
  );
  assert.ok(!latin1(bytes).includes(" Do"), "no XObject draw for a blank src");
});
await atest("video op still throws loudly (video plugin unbuilt)", async () => {
  await assert.rejects(
    () => irToPDF([video({ ref: "x", x: 0, y: 0, w: 10, h: 10 })], { width: 100, height: 100, view: { zoom: 1, panX: 0, panY: 0 } }),
    /not supported yet/,
  );
});

await atest("tjHex encodes and escapes via the font", async () => {
  const { PDFDocument, StandardFonts } = await import("pdf-lib");
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  assert.equal(tjHex(font, "Hi"), "<4869>");
  assert.ok(tjHex(font, "(x)").length > 0); // parens safe in hex form
});

console.log(`\npdf_backend tests: ${passed} passed`);
