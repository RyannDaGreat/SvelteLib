/**
 * Export QA — proves SVG + PDF export still work end-to-end in the browser after
 * the Skia rewrite (the user's "all SVG exports work" gate). Creates a real
 * widget, invokes the app's exportSvg()/exportPdf() (captured via a
 * URL.createObjectURL hook), and validates: SVG is well-formed and contains
 * vector geometry + selectable <text>; PDF has a valid %PDF header and real size.
 *
 * Run (dev server up): node tests/skia_export_qa.js [http://localhost:PORT]
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import puppeteer from "puppeteer";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOG = path.join(HERE, "..", "..", "..", "..", "..", ".claude_logs", "devserver.log");
const SHOTS = path.join(HERE, "..", "..", "..", "..", "..", ".claude_vlm_checks");
const URL_ = process.argv[2] || fs.readFileSync(LOG, "utf8").match(/https?:\/\/localhost:\d+/)[0];

const fail = (m) => { console.error("EXPORT QA FAIL:", m); process.exit(2); };

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await puppeteer.launch({ headless: "new", args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox"] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
  await page.evaluateOnNewDocument(() => {
    window.__blobs = [];
    const orig = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (b) => { window.__blobs.push(b); return orig(b); };
  });
  await page.goto(URL_, { waitUntil: "networkidle2", timeout: 60000 });
  await new Promise((r) => setTimeout(r, 3500));

  // Create content: a rectangle (arm the tool, drag on the canvas) + a text box.
  const armDrag = async (title, x0, y0, x1, y1) => {
    await page.evaluate((t) => [...document.querySelectorAll("button")].find((b) => (b.title || b.getAttribute("aria-label")) === t)?.click(), title);
    const box = await page.evaluate(() => { const c = document.querySelector("canvas.scene"); const r = c.getBoundingClientRect(); return { x: r.x, y: r.y }; });
    await page.mouse.move(box.x + x0, box.y + y0); await page.mouse.down();
    await page.mouse.move(box.x + x1, box.y + y1, { steps: 10 }); await page.mouse.up();
    await new Promise((r) => setTimeout(r, 500));
  };
  await armDrag("Add Rectangle", 120, 120, 340, 260);
  await armDrag("Add Text", 120, 300, 420, 360);
  await page.keyboard.type("Export QA"); // fills the text widget if it entered edit mode
  await page.keyboard.press("Escape");
  await new Promise((r) => setTimeout(r, 400));

  const hasApp = await page.evaluate(() => !!window.__powerrp_app);
  if (!hasApp) fail("window.__powerrp_app not found");

  // Invoke both exports; capture the generated blobs.
  await page.evaluate(async () => { await window.__powerrp_app.exportSvg(); });
  await new Promise((r) => setTimeout(r, 800));
  await page.evaluate(async () => { await window.__powerrp_app.exportPdf(); });
  await new Promise((r) => setTimeout(r, 1200));

  const out = await page.evaluate(async () => {
    const svgBlob = window.__blobs.find((b) => (b.type || "").includes("svg"));
    const pdfBlob = window.__blobs.find((b) => (b.type || "").includes("pdf"));
    const svg = svgBlob ? await svgBlob.text() : null;
    let pdf = null;
    if (pdfBlob) { const u = new Uint8Array(await pdfBlob.arrayBuffer()); pdf = { size: u.length, header: String.fromCharCode(...u.slice(0, 5)) }; }
    return { svg, pdf, blobTypes: window.__blobs.map((b) => b.type) };
  });
  await browser.close();

  console.log("captured blob types:", JSON.stringify(out.blobTypes));
  // --- SVG assertions ---
  if (!out.svg) fail("no SVG blob captured from exportSvg()");
  if (!/<svg[\s>]/.test(out.svg)) fail("SVG missing <svg> root");
  if (!/<(path|rect|ellipse|polygon)[\s>]/.test(out.svg)) fail("SVG has no vector geometry (path/rect/ellipse/polygon)");
  const hasText = /<text[\s>]/.test(out.svg);
  fs.writeFileSync(path.join(SHOTS, "export_qa.svg"), out.svg);
  console.log(`SVG ok: ${out.svg.length} bytes, geometry present, selectable <text>: ${hasText}`);
  // --- PDF assertions ---
  if (!out.pdf) fail("no PDF blob captured from exportPdf()");
  if (out.pdf.header !== "%PDF-") fail(`PDF bad header: ${JSON.stringify(out.pdf.header)}`);
  if (out.pdf.size < 500) fail(`PDF too small: ${out.pdf.size} bytes`);
  console.log(`PDF ok: ${out.pdf.size} bytes, %PDF- header`);
  if (!hasText) fail("SVG had no <text> — text export (selectability) not verified");
  console.log("\nRESULT: PASS — SVG + PDF export produce valid files with vector geometry + selectable text");
})().catch((e) => { console.error("EXPORT QA ERROR:", e.message); process.exit(1); });
