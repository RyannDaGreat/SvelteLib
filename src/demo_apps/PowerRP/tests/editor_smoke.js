/**
 * Editor smoke test: boot the PowerRP editor in headless Chromium with the
 * demo deck in localStorage, exercise selection + palette + slide nav, and
 * screenshot. Fails loudly on any page error.
 * Run from SvelteLib root: node src/demo_apps/PowerRP/tests/editor_smoke.js <shot_dir>
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer } from "vite";
import puppeteer from "puppeteer";

const repo = process.cwd();
const webRoot = resolve(repo, "src/demo_apps/PowerRP/web");
const demoJson = await readFile(resolve(repo, "src/demo_apps/PowerRP/examples/demo.powerrp.json"), "utf8");
const shots = process.argv[2];

const server = await createServer({
  configFile: resolve(webRoot, "vite.config.js"),
  server: { port: 0, open: false, host: "127.0.0.1" },
});
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/`;

const browser = await puppeteer.launch({ headless: "new" });
const errors = [];
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console.error: ${m.text()}`);
  });
  await page.evaluateOnNewDocument((json) => localStorage.setItem("powerrp.autosave", json), demoJson);
  await page.goto(url, { waitUntil: "networkidle0" });
  await new Promise((r) => setTimeout(r, 600));
  await page.screenshot({ path: `${shots}/editor_slide1.png` });
  if (errors.length) {
    console.error("PAGE ERRORS AT BOOT:\n" + errors.join("\n"));
    process.exit(1);
  }

  // Click the rectangle on the canvas (slide coords ≈ world; canvas starts at zoom 1).
  const canvas = await page.$(".canvas-wrap");
  const box = await canvas.boundingBox();
  await page.mouse.click(box.x + 250, box.y + 240); // inside the rect
  await new Promise((r) => setTimeout(r, 300));
  await page.screenshot({ path: `${shots}/editor_selected.png` });

  // Drag the rect 100px right while holding shift (axis lock + guide).
  await page.mouse.move(box.x + 250, box.y + 240);
  await page.mouse.down();
  await page.keyboard.down("Shift");
  await page.mouse.move(box.x + 350, box.y + 265, { steps: 8 });
  await page.screenshot({ path: `${shots}/editor_axislock.png` });
  // Mid-drag invariants: doc untouched (preview-only), preview axis-locked.
  const midDrag = await page.evaluate(() => {
    const app = window.__powerrp_app;
    const items = app.doc.slides[0].delta.items;
    const rectId = Object.keys(items).find((id) => items[id].type === "rect");
    return {
      docX: items[rectId].x,
      docY: items[rectId].y,
      previewX: app.previewDelta?.items?.[rectId]?.x,
      previewY: app.previewDelta?.items?.[rectId]?.y,
      undoDepth: app.undoLog.canUndo,
    };
  });
  await page.mouse.up();
  await page.keyboard.up("Shift");
  const after = await page.evaluate(() => {
    const app = window.__powerrp_app;
    const items = app.doc.slides[0].delta.items;
    const rectId = Object.keys(items).find((id) => items[id].type === "rect");
    return { docX: items[rectId].x, docY: items[rectId].y, preview: app.previewDelta };
  });
  if (midDrag.docX !== 120) errors.push(`MID-DRAG DOC MUTATION: doc x=${midDrag.docX} (expected 120)`);
  if (midDrag.previewY !== undefined && midDrag.previewY !== 160) errors.push(`AXIS LOCK LEAKED Y: preview y=${midDrag.previewY}`);
  if (after.docX !== 220 || after.docY !== 160) errors.push(`COMMIT WRONG: x=${after.docX} y=${after.docY} (expected 220,160)`);
  if (after.preview !== null) errors.push("PREVIEW NOT CLEARED after drag");

  // Command palette: fuzzy-run "Distribute Horizontally".
  await page.keyboard.down("Meta");
  await page.keyboard.down("Shift");
  await page.keyboard.press("KeyP");
  await page.keyboard.up("Shift");
  await page.keyboard.up("Meta");
  await new Promise((r) => setTimeout(r, 200));
  await page.type(".palette input", "dist h");
  await new Promise((r) => setTimeout(r, 200));
  await page.screenshot({ path: `${shots}/editor_palette.png` });
  await page.keyboard.press("Escape");

  // Slide 3 via the navigator (blur + magnifier live rendering).
  await page.evaluate(() => document.querySelectorAll(".slidenav .slide")[2].click());
  await new Promise((r) => setTimeout(r, 400));
  await page.screenshot({ path: `${shots}/editor_slide3.png` });

  if (errors.length) {
    console.error("PAGE ERRORS:\n" + errors.join("\n"));
    process.exit(1);
  }
  console.log("Editor smoke test passed, screenshots written.");
} finally {
  await browser.close();
  await server.close();
}
