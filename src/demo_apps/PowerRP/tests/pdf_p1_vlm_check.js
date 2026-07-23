/**
 * PDF P1 VLM harness — produces the reviewable proof images in
 * POWERRP/.claude_vlm_checks/. Run FROM THE SvelteLib REPO ROOT:
 *   node src/demo_apps/PowerRP/tests/pdf_p1_vlm_check.js
 *
 * PART A (node, the real pipeline): warms the vector cache for the fixture's
 * page 1, calls the REAL plugins/pdf_page.js emit(), asserts it returns `path`
 * ops (true vector — NOT the raster image op), and renders them through
 * render_gpu/skia/node_render.renderToPng at 1× and at a high zoom →
 * pdf_p1_vector_1x.png / pdf_p1_vector_zoom.png. The zoom shot proves crispness
 * (vector rasterizes fresh at the zoom, no bitmap upscaling). It also calls emit()
 * for page 2 (text) and asserts it returns the raster image op — the no-regression
 * check that a text page still takes the P0 raster fallback.
 *
 * PART B (puppeteer): rasterizes page 2 through pdf.js in real Chromium (the SAME
 * engine gpu/pdf_page_raster.js uses for the raster fallback) → pdf_p1_text_raster
 * .png, a visual confirmation the text page renders correctly as a raster (P0).
 * Served over HTTP because Chromium blocks file:// ES-module loads.
 */

import assert from "node:assert/strict";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, extname, dirname } from "node:path";
import { createServer } from "node:http";
import { pathToFileURL, fileURLToPath } from "node:url";
import { renderToPng } from "../render_gpu/skia/node_render.js";
import { fitRectView } from "../core/view.js";
import { pushTransform, popTransform } from "../render_gpu/ir.js";
import { pdfPagePlugin } from "../plugins/pdf_page.js";
import { ensurePdfPageVector } from "../render_gpu/gpu/pdf_page_vector.js";

// cwd-independent: derive everything from this file's location (was process.cwd(),
// which doubled the path prefix when run from anywhere but the SvelteLib root).
const HERE = dirname(fileURLToPath(import.meta.url)); // .../PowerRP/tests
const POWERRP = resolve(HERE, "..");                  // .../PowerRP
const repo = resolve(HERE, "../../../..");            // .../SvelteLib (static server root)
const FIXTURE = resolve(POWERRP, "tests/fixtures/pdf_vector_fixture.pdf");
const OUT = resolve(POWERRP, ".claude_vlm_checks");
mkdirSync(OUT, { recursive: true });

const PAGE_W = 300, PAGE_H = 240, DPR = 2;
const world = { x: 0, y: 0, rotation: 0, scale: 1 };

// ── PART A: real emit() → vector, rendered at 1× and zoom ──────────────────────
const src = pathToFileURL(FIXTURE).href; // file:// URL — pdfjs legacy opens it in node
await ensurePdfPageVector(src, 1); // warm the vector cache (async) before the sync emit()

const state1 = { ...pdfPagePlugin.defaults, src, page: 1, w: PAGE_W, h: PAGE_H };
const ir1 = pdfPagePlugin.emit(state1, null, world);
assert.ok(ir1.length >= 5 && ir1.every((o) => o.op === "path"), `page 1 emit() must be all path ops, got ${ir1.map((o) => o.op)}`);
console.log(`PART A: page 1 emit() → ${ir1.length} vector path ops (no raster image op) ✓`);

const commands1 = [pushTransform(world), ...ir1, popTransform()];
const box = { x: 0, y: 0, w: PAGE_W, h: PAGE_H };
const png1x = await renderToPng(commands1, fitRectView(box, PAGE_W, PAGE_H, DPR), { width: PAGE_W * DPR, height: PAGE_H * DPR, background: "#ffffff" });
writeFileSync(resolve(OUT, "pdf_p1_vector_1x.png"), Buffer.from(png1x));
const zoomRect = { x: 150, y: 30, w: 100, h: 80 }; // ellipse region, magnified ~3×
const pngZoom = await renderToPng(commands1, fitRectView(zoomRect, PAGE_W, PAGE_H, DPR), { width: PAGE_W * DPR, height: PAGE_H * DPR, background: "#ffffff" });
writeFileSync(resolve(OUT, "pdf_p1_vector_zoom.png"), Buffer.from(pngZoom));
console.log(`PART A: wrote pdf_p1_vector_1x.png (${png1x.length}B) + pdf_p1_vector_zoom.png (${pngZoom.length}B)`);

await ensurePdfPageVector(src, 2);
const state2 = { ...pdfPagePlugin.defaults, src, page: 2, w: PAGE_W, h: PAGE_H };
const ir2 = pdfPagePlugin.emit(state2, null, world);
assert.ok(ir2.length === 1 && ir2[0].op === "image", `page 2 (text) emit() must fall back to a raster image op, got ${ir2.map((o) => o.op)}`);
console.log("PART A: page 2 (text) emit() → raster image op (P0 fallback, no regression) ✓");

// ── PART B: rasterize the text page via pdf.js in real Chromium ────────────────
const MIME = { ".mjs": "text/javascript", ".js": "text/javascript", ".html": "text/html", ".bcmap": "application/octet-stream", ".pfb": "application/octet-stream" };
const server = createServer((req, res) => {
  try {
    const p = resolve(repo, "." + decodeURIComponent(req.url.split("?")[0]));
    const body = readFileSync(p);
    res.writeHead(200, { "Content-Type": MIME[extname(p)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404); res.end("not found");
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}`;
const pdfjsUrl = `${origin}/node_modules/pdfjs-dist/build/pdf.mjs`;
const workerUrl = `${origin}/node_modules/pdfjs-dist/build/pdf.worker.mjs`;
const stdFontsUrl = `${origin}/node_modules/pdfjs-dist/standard_fonts/`;
const pdfUrl = `${origin}/src/demo_apps/PowerRP/tests/fixtures/pdf_vector_fixture.pdf`;

const html = `<!doctype html><html><body><canvas id="c"></canvas><script type="module">
import * as pdfjsLib from "${pdfjsUrl}";
pdfjsLib.GlobalWorkerOptions.workerSrc = "${workerUrl}";
const doc = await pdfjsLib.getDocument({url:"${pdfUrl}", standardFontDataUrl:"${stdFontsUrl}"}).promise;
const page = await doc.getPage(2);
const vp = page.getViewport({scale:${DPR}});
const canvas = document.getElementById("c");
canvas.width = vp.width; canvas.height = vp.height;
const ctx = canvas.getContext("2d");
ctx.fillStyle="#fff"; ctx.fillRect(0,0,canvas.width,canvas.height);
await page.render({canvasContext: ctx, canvas, viewport: vp}).promise;
window.__done = true;
</script></body></html>`;

const { default: puppeteer } = await import("puppeteer");
const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"] });
try {
  const page = await browser.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });
  await page.goto(`${origin}/blank`, { waitUntil: "domcontentloaded" }).catch(() => {});
  await page.setContent(html, { waitUntil: "networkidle0" });
  await page.waitForFunction("window.__done === true", { timeout: 20000 });
  const canvas = await page.$("#c");
  await canvas.screenshot({ path: resolve(OUT, "pdf_p1_text_raster.png") });
  console.log(`PART B: wrote pdf_p1_text_raster.png (pdf.js raster of the text page)${errs.length ? " — page errors: " + errs.join("; ") : " ✓"}`);
} finally {
  await browser.close();
  server.close();
}
console.log("\nVLM harness complete.");
