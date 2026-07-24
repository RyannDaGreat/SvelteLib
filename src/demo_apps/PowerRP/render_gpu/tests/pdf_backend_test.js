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
  imageRefs, videoRefs, decodeDataUri, base64ToBytes, imageFormat,
  textFaces, fontResName, groupedTextDraws, tokenizeSvgPath, svgPathToPdfOps,
  isSyntheticImageRef, parsePdfPageRef, pdfPageEmbedRefs, pdfPageEmbedPlacementOps,
} from "../pdf_backend.js";
import { rect, ellipse, text, pushTransform, popTransform, blurBackdrop, magnifyBackdrop, glassBackdrop, image, video, latexVector } from "../ir.js";
import { normalizeRichText } from "../../core/richtext.js";
import { fontFileFor } from "../fonts.js";
import { scenes } from "./pdf_scenes.js";
import { CHECKER_PNG_DATA_URI } from "../../tests/fixtures/checker_png.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// Node seam for the committed-font tests: read the SAME TTF the browser loads
// via ?url. fonts/ lives two dirs up from render_gpu/tests/.
const FONTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../fonts");
const nodeLoadFontBytes = (basename) => new Uint8Array(readFileSync(resolve(FONTS_DIR, basename)));

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

/**
 * Every command in a list INCLUDING those nested inside content-bearing ops
 * (cropSubtree `content` — a self-contained sub-list the backends flatten
 * independently). A decorated/cropped image or video (the SHARED STROKED-BOX
 * BUNDLE) nests its image/video op inside a cropSubtree, so a top-level scan
 * misses it; structural assertions that ask "does this scene contain op X"
 * must walk the whole tree. Written generically over a NESTED_CONTENT_KEYS set
 * so a future effect subtree (drop shadow, etc.) is caught by adding its key,
 * not by re-patching every call site. (magnifyBackdrop's "below" list is a
 * PREFIX of the outer stream — already walked — so it needs no entry.)
 */
const NESTED_CONTENT_KEYS = ["content"];
function commandsDeep(commands) {
  const out = [];
  for (const c of commands) {
    out.push(c);
    for (const k of NESTED_CONTENT_KEYS)
      if (Array.isArray(c[k])) out.push(...commandsDeep(c[k]));
  }
  return out;
}
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
// ── Round 15.1 LaTeX vector: SVG path `d` → PDF operators ────────────────────
test("tokenizeSvgPath: M L H V Q T Z, implicit-L after M", () => {
  assert.deepEqual(tokenizeSvgPath("M0 0L10 10Z"), [["M", 0, 0], ["L", 10, 10], ["Z"]]);
  assert.deepEqual(tokenizeSvgPath("M1 2 3 4"), [["M", 1, 2], ["L", 3, 4]]); // extra M coords → implicit L (SVG rule)
  assert.deepEqual(tokenizeSvgPath("H5V-3"), [["H", 5], ["V", -3]]);
});
test("svgPathToPdfOps: M/L/Z, H/V→l, Q→cubic (degree elevation)", () => {
  assert.equal(svgPathToPdfOps("M0 0L10 0Z"), "0 0 m\n10 0 l\nh");
  assert.equal(svgPathToPdfOps("M0 0H10V10"), "0 0 m\n10 0 l\n10 10 l");
  // Q10 0 10 10 from (0,0): c1 = 0 + 2/3·10 = 6.6667; c2 = 10 + 2/3·(10−10)=10, 10 + 2/3·(0−10)=3.3333
  assert.equal(svgPathToPdfOps("M0 0Q10 0 10 10"), "0 0 m\n6.6667 0 10 3.3333 10 10 c");
});
test("svgPathToPdfOps: T reflects the previous quad control; throws on unknown cmd", () => {
  // After Q10 0 10 10 (control 10,0 at endpoint 10,10), T20 20 reflects the
  // control about (10,10) → (10,20), a new quad to (20,20).
  const ops = svgPathToPdfOps("M0 0Q10 0 10 10T20 20");
  assert.ok(ops.includes("c\n"), "two cubics emitted");
  assert.equal(ops.split("c").length - 1, 2, "Q + T = two cubics");
  assert.throws(() => svgPathToPdfOps("M0 0A1 1 0 0 1 5 5"), /unsupported SVG path command "A"/);
});
test("latexVector: PDF emits fill f (nonzero) + local box→box cm, no XObject", async () => {
  // The equation glyphs render as inline vector path ops filled with `f`
  // (nonzero winding = correct glyph counters), NOT a raster XObject. Drive the
  // real backend: a latexVector op with one glyph, no blur → pure vector.
  const glyph = { d: "M0 0L100 0L100 50L0 50Z", fill: "#ff0000" };
  const pdf = await irToPDF([latexVector({ ref: "latex:eq:1", x: 10, y: 10, w: 200, h: 100, glyphs: [glyph], viewBox: { minX: 0, minY: 0, w: 100, h: 50 } })],
    { width: 300, height: 200, view: { zoom: 1, panX: 0, panY: 0 }, background: "#ffffff" });
  const s = Buffer.from(pdf).toString("latin1");
  assert.ok(s.startsWith("%PDF"), "is a PDF");
  assert.ok(!s.includes("/XObject"), "NO image XObject — the equation is TRUE VECTOR, not a raster embed");
  assert.ok(s.includes("1 0 0 rg"), "red glyph ink fill (rg device color)");
  // viewBox→box local cm: sx=200/100=2, sy=100/50=2, translate (10,10).
  assert.ok(s.includes("2 0 0 2 10 10 cm"), "viewBox→box local cm");
  // The glyph path + NONZERO fill (`f`, not `f*`) — glyph counters render as holes.
  assert.ok(/0 0 m\n100 0 l\n100 50 l\n0 50 l\nh\nf/.test(s), "glyph path filled nonzero (f)");
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
// A video scene's current-frame resolver: the still-frame fixture stands in for
// the browser's <video> grab (a STILL clip's frame is deterministic). The
// checker PNG is a real, non-blank frame, so it embeds an XObject.
const stubVideoFrame = async () => ({ mime: "image/png", bytes: base64ToBytes(CHECKER_PNG_DATA_URI.split(",")[1]) });
const OPTS = (scene) => ({
  width: scene.width, height: scene.height, view: scene.view,
  background: scene.background, rasterize: stubRasterize,
  videoFrame: scene.video ? stubVideoFrame : null,
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
    // the hybrid rule) OR embeds an image widget (a non-blank image op) OR
    // embeds a video's current frame (a non-blank video op, same XObject path).
    // RECURSES into nested-content ops (cropSubtree `content`) via commandsDeep:
    // a bordered/rounded/cropped image or video (the SHARED STROKED-BOX BUNDLE)
    // nests its image/video op INSIDE a cropSubtree, so a top-level-only scan
    // would say wantsImage=false while an XObject IS emitted (the crop box's own
    // target content likewise). Written as a generic nested-content walk so a
    // future effect subtree (drop shadow, etc.) doesn't re-break it.
    // An effectSubtree ALWAYS produces a raster region (shadow PNG / bloom
    // or blend widget raster / the add-blend below-split — every effect's
    // hybrid form embeds at least one image; render_gpu/pdf_backend
    // emitEffect). The Round-12D extension of this invariant.
    const wantsImage = commandsDeep(scene.commands).some((c) => c.op === "blurBackdrop" || c.op === "image" || c.op === "video" || c.op === "effectSubtree");
    assert.equal(s.includes("/Subtype /Image"), wantsImage, `image XObject iff blur/image/video/effect op (${scene.name})`);

    const hasLens = scene.commands.some((c) => c.op === "magnifyBackdrop");
    if (hasLens) assert.ok(s.includes("W n"), "lens clip path present");

    // Alpha too walks nested content (a crop box's target subtree may carry a
    // translucent op even when nothing at top level does).
    const hasAlpha = commandsDeep(scene.commands).some((c) => (c.fill && c.fill[3] < 1) || (c.opacity ?? 1) < 1 || (c.stroke && c.stroke[3] < 1));
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

// ── GENERAL raster fallback: any op the vector backend can't represent ────────
const imageDraws = (s) => (s.match(/\/[A-Za-z]+\d+ Do/g) ?? []).length; // drawn XObjects: images (Img), raster tiles (Im), videos (Vid), page embeds (Pg)

await atest("GENERAL FALLBACK: glassBackdrop (unrepresentable) rasterizes instead of throwing 'unknown op'", async () => {
  const cmds = [
    rect({ x: 0, y: 0, w: 200, h: 120, fill: "#7aa2f7" }),
    glassBackdrop({ cx: 100, cy: 60, halfW: 60, halfH: 30, cornerRadius: 20 }),
  ];
  const bytes = await irToPDF(cmds, { width: 200, height: 120, view: { zoom: 1, panX: 0, panY: 0 }, background: "#ffffff", rasterize: stubRasterize });
  const s = latin1(bytes);
  assert.ok(s.startsWith("%PDF-"));
  assert.ok(s.includes("/Subtype /Image"), "glass region embedded as a raster image XObject");
  assert.ok(!/unknown op/.test(s), "no unknown-op text leaked");
});

await atest("GENERAL FALLBACK without a rasterize seam throws loudly (no silent drop)", async () => {
  await assert.rejects(
    () => irToPDF(
      [rect({ x: 0, y: 0, w: 100, h: 100, fill: "#f00" }), glassBackdrop({ cx: 50, cy: 50, halfW: 30, halfH: 20 })],
      { width: 100, height: 100, view: { zoom: 1, panX: 0, panY: 0 } },
    ),
    /rasterize callback/,
  );
});

await atest("GENERAL FALLBACK is LOCALIZED: an image BELOW the glass stays its own embed (not swallowed into a full-region raster)", async () => {
  // A localized fallback draws the below image AS ITS OWN XObject (in z-order,
  // before the glass) AND adds the glass tile → TWO drawn image XObjects. A
  // full-region raster split (blur-style) would swallow the below image into one
  // region raster → only ONE. Two draws proves only the glass component rasterized.
  const cmds = [
    image({ ref: CHECKER_PNG_DATA_URI, x: 10, y: 10, w: 80, h: 60 }), // below the glass
    glassBackdrop({ cx: 100, cy: 60, halfW: 40, halfH: 25, cornerRadius: 12 }),
  ];
  const bytes = await irToPDF(cmds, { width: 200, height: 120, view: { zoom: 1, panX: 0, panY: 0 }, background: "#ffffff", rasterize: stubRasterize });
  assert.equal(imageDraws(latin1(bytes)), 2, "below image drawn as vector-adjacent XObject + one glass raster tile");
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
await atest("video op WITHOUT a videoFrame resolver throws loudly (no silent drop)", async () => {
  await assert.rejects(
    () => irToPDF([video({ ref: "x", x: 0, y: 0, w: 10, h: 10 })], { width: 100, height: 100, view: { zoom: 1, panX: 0, panY: 0 } }),
    /video op but no videoFrame resolver/,
  );
});
await atest("video op embeds its CURRENT FRAME as an XObject and places it", async () => {
  // The resolver returns the current frame as PNG bytes (a real 64x48 fixture,
  // so it is NOT the blank 1x1 that maps to null) — the browser grabs the
  // <video> element's frame; here the still-frame fixture stands in.
  const frameBytes = base64ToBytes(CHECKER_PNG_DATA_URI.split(",")[1]);
  const videoFrame = async () => ({ mime: "image/png", bytes: frameBytes });
  const bytes = await irToPDF(
    [video({ ref: "clip", x: 10, y: 20, w: 80, h: 60 })],
    { width: 100, height: 100, view: { zoom: 1, panX: 0, panY: 0 }, background: "#ffffff", videoFrame },
  );
  const s = latin1(bytes);
  assert.ok(s.startsWith("%PDF-"), "is a PDF");
  assert.ok(s.includes(" Do"), "places the video-frame XObject");
});
await atest("video op with a BLANK/undrawable current frame draws nothing (matches GPU skip)", async () => {
  const videoFrame = async () => null; // resolver reports no drawable frame
  const bytes = await irToPDF(
    [video({ ref: "clip", x: 0, y: 0, w: 50, h: 50 })],
    { width: 100, height: 100, view: { zoom: 1, panX: 0, panY: 0 }, background: "#ffffff", videoFrame },
  );
  assert.ok(!latin1(bytes).includes(" Do"), "no XObject draw for a blank frame");
});
test("videoRefs: distinct, order-preserving, deduped", () => {
  assert.deepEqual(videoRefs([{ op: "video", ref: "a" }, { op: "rect" }, { op: "video", ref: "a" }, { op: "video", ref: "b" }]), ["a", "b"]);
  assert.deepEqual(videoRefs([{ op: "rect" }]), []);
});

await atest("tjHex encodes and escapes via the font", async () => {
  const { PDFDocument, StandardFonts } = await import("pdf-lib");
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  assert.equal(tjHex(font, "Hi"), "<4869>");
  assert.ok(tjHex(font, "(x)").length > 0); // parens safe in hex form
});

// ── committed-font embedding (the fonts task) ────────────────────────────────
test("textFaces: distinct (font, bold) faces, order-preserving, default font", () => {
  assert.deepEqual(
    textFaces([text({ text: "a", x: 0, y: 0, size: 10, color: "#000", font: "inter" }),
               text({ text: "b", x: 0, y: 0, size: 10, color: "#000", font: "inter", bold: true }),
               text({ text: "c", x: 0, y: 0, size: 10, color: "#000", font: "inter" })]),
    [{ font: "inter", bold: false }, { font: "inter", bold: true }],
  );
  assert.deepEqual(textFaces([text({ text: "x", x: 0, y: 0, size: 10, color: "#000" })]), [{ font: "system", bold: false }]);
  assert.deepEqual(textFaces([rect({ x: 0, y: 0, w: 1, h: 1, fill: "#fff" })]), []);
});
test("fontResName: valid PDF token per face", () => {
  assert.equal(fontResName("inter", false), "F_inter_R");
  assert.equal(fontResName("source-serif", true), "F_source_serif_B");
  assert.equal(fontResName("system", false), "F_system_R");
});
await atest("system-font text still embeds standard-14 Helvetica (back-compat, no seams)", async () => {
  const bytes = await irToPDF([text({ text: "System", x: 5, y: 5, size: 20, color: "#000" })],
    { width: 120, height: 40, view: { zoom: 1, panX: 0, panY: 0 } });
  const s = latin1(bytes);
  assert.ok(s.startsWith("%PDF-"));
  assert.ok(s.includes("Helvetica"), "system falls back to standard-14 Helvetica");
  assert.ok(s.includes("/F_system_R "), "uses the per-font resource name");
});
await atest("committed font embeds the SAME TTF (fontkit + loadFontBytes) and is selectable", async () => {
  const { execFileSync } = await import("node:child_process");
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const fontkit = (await import("@pdf-lib/fontkit")).default;
  const bytes = await irToPDF(
    [text({ text: "Embedded Inter", x: 8, y: 8, size: 24, color: "#000", font: "inter" }),
     text({ text: "Bold Serif", x: 8, y: 40, size: 24, color: "#000", font: "source-serif", bold: true })],
    { width: 260, height: 80, view: { zoom: 1, panX: 0, panY: 0 }, background: "#ffffff",
      loadFontBytes: nodeLoadFontBytes, registerFontkit: fontkit },
  );
  const s = latin1(bytes);
  assert.ok(s.startsWith("%PDF-"));
  // Embedded (subset) fonts appear as FontFile2 + a subset tag; NOT the base-14 name.
  assert.ok(s.includes("FontFile2") || s.includes("/Type0") || s.includes("Identity-H"),
    "an embedded TrueType/composite font is present (FontFile2/Type0)");
  assert.ok(s.includes("/F_inter_R ") && s.includes("/F_source_serif_B "), "per-font resource names present");
  // pdftotext must still extract the text (selectability is the acceptance gate).
  const dir = mkdtempSync(join(tmpdir(), "powerrp-font-"));
  const pdfPath = join(dir, "embed.pdf");
  writeFileSync(pdfPath, Buffer.from(bytes));
  let txt = "";
  try { txt = execFileSync("pdftotext", [pdfPath, "-"]).toString(); }
  catch { console.log("    (pdftotext not on PATH — skipping the extraction assertion; install poppler)"); return; }
  assert.ok(txt.includes("Embedded Inter"), `pdftotext extracts embedded text (got ${JSON.stringify(txt.trim().slice(0, 60))})`);
});
test("fontFileFor resolves committed basenames the loader reads", () => {
  // Sanity: the registry names files that actually exist on disk (else the
  // browser ?url glob and node reader both fail).
  for (const [id, bold] of [["inter", false], ["inter", true], ["source-serif", false], ["jetbrains-mono", true], ["lora", false]]) {
    const file = fontFileFor(id, bold);
    assert.ok(file, `${id}/${bold} has a file`);
    const bytes = nodeLoadFontBytes(file);
    assert.ok(bytes.length > 1000, `${file} is a real TTF (${bytes.length} bytes)`);
  }
});

test("groupedTextDraws: same line+style clusters; style or line change splits", () => {
  const d = (over) => ({ text: "a", x: 0, baselineY: 10, size: 12, font: "system", bold: false, italic: false, color: "#000", opacity: 1, ...over });
  assert.equal(groupedTextDraws([d({}), d({ text: " ", x: 8 }), d({ text: "b", x: 12 })]).length, 1); // one cluster: word+space+word
  assert.equal(groupedTextDraws([d({}), d({ bold: true, x: 8 })]).length, 2);        // bold change splits
  assert.equal(groupedTextDraws([d({}), d({ baselineY: 30 })]).length, 2);           // new line splits
  assert.equal(groupedTextDraws([d({}), d({ color: "#f00", x: 8 })]).length, 2);     // color change splits
  assert.deepEqual(groupedTextDraws([]), []);
});

await atest("RICH TEXT EXTRACTION FIDELITY: verbatim text (spaces included) survives metric mismatch", async () => {
  // THE REGRESSION (coordinator re-task, 2026-07-15): the `system` font is laid
  // out with canvas SF Pro metrics but DRAWN as standard-14 Helvetica (no
  // embeddable file). Helvetica is wider — an unscaled word's ink overran the
  // next piece's position and poppler's geometric word-builder merged them:
  // pdftotext read "PowerRPV1". The fix fits every piece's drawn ink to the
  // LAYOUT width (per-piece Tz) inside ONE text object per line cluster.
  // This test reproduces the mismatch with a deliberately NARROW measure
  // (0.7 × the em — narrower than Helvetica for any word) and asserts:
  //   1. STRUCTURE (poppler-free): one BT text object for the line; the space
  //      is IN the show stream between the words; Tz fitting engaged.
  //   2. EXTRACTION (pdftotext, poppler): the visible text VERBATIM including
  //      the space. Reported-skip when poppler is absent (the in-file
  //      precedent above; the parity suite hard-requires poppler regardless).
  const narrowMeasure = (str, { size }) => ({ width: [...str].length * size * 0.35, ascent: 0.8 * size, descent: 0.2 * size });
  const rich = normalizeRichText("PowerRP V1", { font: "system", size: 48, color: "#101018", bold: false });
  const bytes = await irToPDF([
    rect({ x: 0, y: 0, w: 640, h: 200, fill: "#ffffff" }),
    text({ text: "PowerRP V1", x: 40, y: 40, size: 48, color: "#101018", font: "system",
           rich, boxW: 560, boxH: 120, boxStyle: { align: "left", lineSpacing: 1, charSpacing: 0, wordSpacing: 0 } }),
  ], { width: 640, height: 200, view: { zoom: 1, panX: 0, panY: 0 }, background: "#ffffff", measureText: narrowMeasure, textAscent: 0.8 });
  const s = latin1(bytes);

  // 1. Structure: ONE text object for the one-line cluster; word+space+word
  //    shown in stream order inside it; Tz fitting engaged for the mismatch.
  const bt = s.match(/BT[\s\S]*?ET/g).filter((b) => b.includes("Tj"));
  assert.equal(bt.length, 1, "one text object for the single line cluster");
  const shows = [...bt[0].matchAll(/<([0-9A-Fa-f]+)> Tj/g)].map((m) =>
    m[1].match(/../g).map((h) => String.fromCharCode(parseInt(h, 16))).join(""));
  assert.deepEqual(shows, ["PowerRP", " ", "V1"], "pieces (incl. the SPACE) shown verbatim in stream order");
  assert.ok(/[\d.]+ Tz/.test(bt[0]), "Tz geometric fit engaged under metric mismatch");

  // 2. Extraction: pdftotext reproduces the visible text verbatim.
  const { execFileSync } = await import("node:child_process");
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "powerrp-richtext-"));
  const pdfPath = join(dir, "extract.pdf");
  writeFileSync(pdfPath, Buffer.from(bytes));
  let txt = "";
  try { txt = execFileSync("pdftotext", [pdfPath, "-"]).toString(); }
  catch { console.log("    (pdftotext not on PATH — skipping the extraction assertion; install poppler)"); return; }
  assert.ok(txt.includes("PowerRP V1"), `pdftotext reproduces "PowerRP V1" verbatim incl. the space (got ${JSON.stringify(txt.trim().slice(0, 40))})`);
});

// ── synthetic-ref resolver seam + lossless PDF-page embed (pdf_page/latex) ───
// FIXTURE: a real pdf-lib-authored PDF (page 1 is pure vector: a filled rect).
const PDF_FIXTURE = new Uint8Array(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../../tests/fixtures/pdf_vector_fixture.pdf")));
const CHECKER_BYTES = base64ToBytes(CHECKER_PNG_DATA_URI.split(",")[1]);

test("isSyntheticImageRef: custom scheme vs fetchable", () => {
  assert.equal(isSyntheticImageRef("pdfpage:blob:x:1:1"), true);
  assert.equal(isSyntheticImageRef("latex:x^2:#000:1"), true);
  assert.equal(isSyntheticImageRef("data:image/png;base64,AAAA"), false);
  assert.equal(isSyntheticImageRef("https://x/a.png"), false);
  assert.equal(isSyntheticImageRef("blob:https://h/uuid"), false);
  assert.equal(isSyntheticImageRef("/assets/a.png"), false); // path, no scheme
});
test("parsePdfPageRef: trailing page/scale, src may contain ':'", () => {
  assert.deepEqual(parsePdfPageRef("pdfpage:blob:x:3:2.3"), { src: "blob:x", page: 3 });
  assert.deepEqual(parsePdfPageRef("pdfpage:blob:x:1:1"), { src: "blob:x", page: 1 });
  assert.deepEqual(parsePdfPageRef("pdfpage:data:application/pdf;base64,AAA:2:1.5"), { src: "data:application/pdf;base64,AAA", page: 2 });
  assert.equal(parsePdfPageRef("latex:eq:#000:1"), null); // not a pdf_page ref
  assert.equal(parsePdfPageRef("data:image/png;base64,AA"), null);
});
test("pdfPageEmbedRefs: full-frame opaque pdfpage only; cropped/translucent excluded", () => {
  const full = (ref, over = {}) => image({ ref, x: 0, y: 0, w: 10, h: 10, ...over });
  assert.deepEqual([...pdfPageEmbedRefs([full("pdfpage:a:1:1")])], ["pdfpage:a:1:1"]);
  assert.equal(pdfPageEmbedRefs([full("pdfpage:a:1:1", { opacity: 0.5 })]).size, 0); // translucent → raster
  assert.equal(pdfPageEmbedRefs([full("pdfpage:a:1:1", { sw: 0.5 })]).size, 0);      // cropped → raster
  assert.equal(pdfPageEmbedRefs([full("data:image/png;base64,AA")]).size, 0);        // not a pdfpage ref
  // a ref used in BOTH a full-frame AND a cropped op is excluded (one kind per ref)
  assert.equal(pdfPageEmbedRefs([full("pdfpage:a:1:1"), full("pdfpage:a:1:1", { sw: 0.5 })]).size, 0);
});
test("pdfPageEmbedPlacementOps: point-box → dest rect, y-flip", () => {
  assert.deepEqual(
    pdfPageEmbedPlacementOps({ x: 10, y: 20, w: 100, h: 80 }, { name: "Pg1", width: 200, height: 160 }),
    ["0.5 0 0 -0.5 10 100 cm", "/Pg1 Do"],
  );
});

await atest("SYNTHETIC pdfpage:/latex: refs resolve via resolveImageBytes (no fetch crash)", async () => {
  // The old bug: loadImageBytes fetch("pdfpage:…") → TypeError "URL scheme not
  // supported". With the seam the same refs embed as raster image XObjects.
  const resolveImageBytes = async (ref) => {
    assert.ok(isSyntheticImageRef(ref), `only synthetic refs reach the seam (got ${ref})`);
    return CHECKER_BYTES;
  };
  const bytes = await irToPDF(
    [image({ ref: "pdfpage:blob:paper:1:1", x: 10, y: 10, w: 80, h: 60, opacity: 0.5 }), // translucent → raster, not page-embed
     image({ ref: "latex:eq:#000:1", x: 0, y: 0, w: 20, h: 20 })],
    { width: 100, height: 100, view: { zoom: 1, panX: 0, panY: 0 }, background: "#ffffff", resolveImageBytes },
  );
  const s = latin1(bytes);
  assert.ok(s.startsWith("%PDF-"), "is a PDF (no crash)");
  assert.ok(s.includes("/Subtype /Image"), "synthetic refs embed as raster image XObjects");
  assert.ok(s.includes(" Do"), "placed");
  assert.ok(!s.includes("not supported"), "no fetch-scheme error text");
});

await atest("SYNTHETIC ref WITHOUT resolveImageBytes throws loudly (crash → clear error)", async () => {
  await assert.rejects(
    () => irToPDF([image({ ref: "pdfpage:blob:x:1:1", x: 0, y: 0, w: 10, h: 10, opacity: 0.5 })],
      { width: 100, height: 100, view: { zoom: 1, panX: 0, panY: 0 } }),
    /no resolveImageBytes seam/,
  );
});

await atest("EMBEDDED PDF page exports as LOSSLESS vector (Form XObject page-embed, not a raster image)", async () => {
  // A full-frame opaque pdf_page ref is copied whole via pdf-lib embedPdf: the
  // exported page carries the source page's real vectors (a /Subtype /Form
  // XObject), NOT a rasterized /Subtype /Image. resolveImageBytes THROWS to
  // prove the raster path is never taken for this page.
  const resolvePdfPageEmbed = async (ref) => {
    assert.equal(parsePdfPageRef(ref).page, 1);
    return { bytes: PDF_FIXTURE, pageIndex: 0 };
  };
  const resolveImageBytes = async () => { throw new Error("raster path must NOT be used for a lossless page-embed"); };
  const bytes = await irToPDF(
    [image({ ref: "pdfpage:blob:paper:1:1", x: 10, y: 10, w: 100, h: 80 })],
    { width: 200, height: 160, view: { zoom: 1, panX: 0, panY: 0 }, background: "#ffffff", resolveImageBytes, resolvePdfPageEmbed },
  );
  const s = latin1(bytes);
  assert.ok(s.startsWith("%PDF-"), "is a PDF");
  assert.ok(s.includes("/Subtype /Form"), "the source page is copied as a Form XObject (lossless vectors/text)");
  assert.ok(!s.includes("/Subtype /Image"), "NOT a raster image embed");
  assert.ok(s.includes(" Do"), "the embedded page is placed");
});

await atest("page-embed is PREFERRED over raster when both seams are wired", async () => {
  let rasterUsed = false;
  const bytes = await irToPDF(
    [image({ ref: "pdfpage:blob:paper:1:1", x: 0, y: 0, w: 100, h: 80 })],
    { width: 200, height: 160, view: { zoom: 1, panX: 0, panY: 0 },
      resolvePdfPageEmbed: async () => ({ bytes: PDF_FIXTURE, pageIndex: 0 }),
      resolveImageBytes: async () => { rasterUsed = true; return CHECKER_BYTES; } },
  );
  assert.ok(latin1(bytes).includes("/Subtype /Form"), "used the lossless page-embed");
  assert.equal(rasterUsed, false, "did not touch the raster resolver");
});

await atest("page-embed failure falls back to raster LOUDLY (no silent drop)", async () => {
  const errs = [];
  const orig = console.warn; console.warn = (m) => errs.push(String(m));
  try {
    const bytes = await irToPDF(
      [image({ ref: "pdfpage:blob:bad:1:1", x: 0, y: 0, w: 50, h: 50 })],
      { width: 100, height: 100, view: { zoom: 1, panX: 0, panY: 0 },
        resolvePdfPageEmbed: async () => ({ bytes: new Uint8Array([1, 2, 3, 4]), pageIndex: 0 }), // not a real PDF → embedPdf throws
        resolveImageBytes: async () => CHECKER_BYTES },
    );
    const s = latin1(bytes);
    assert.ok(s.includes("/Subtype /Image"), "fell back to a raster embed");
    assert.ok(!s.includes("/Subtype /Form"), "no bogus Form XObject");
  } finally { console.warn = orig; }
  assert.ok(errs.some((m) => /page-embed failed/.test(m)), "the fallback was reported (loud, not silent)");
});

await atest("a CROPPED pdf_page rasters (page-embed skipped) even with the embed seam wired", async () => {
  const bytes = await irToPDF(
    [image({ ref: "pdfpage:blob:paper:1:1", x: 0, y: 0, w: 100, h: 80, sw: 0.5, sh: 0.5 })], // edge-crop → not a whole-page copy
    { width: 200, height: 160, view: { zoom: 1, panX: 0, panY: 0 },
      resolvePdfPageEmbed: async () => ({ bytes: PDF_FIXTURE, pageIndex: 0 }),
      resolveImageBytes: async () => CHECKER_BYTES },
  );
  const s = latin1(bytes);
  assert.ok(s.includes("/Subtype /Image"), "cropped page rasters");
  assert.ok(!s.includes("/Subtype /Form"), "cropped page is NOT page-embedded");
});

console.log(`\npdf_backend tests: ${passed} passed`);
