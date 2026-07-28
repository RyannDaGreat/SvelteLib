/**
 * Editor smoke test: boot the PowerRP editor in headless Chromium with the
 * demo deck in localStorage, exercise selection + palette + slide nav, and
 * screenshot. Fails loudly on any page error.
 *
 * TWO CHANNELS, NOT ONE. Until 2026-07-28 this file pushed EVERY console.error
 * into `errors` and exited 1, which made it permanently red for a reason that was
 * never a defect: the load-boundary repair (core/document.js printRepairReports)
 * console.errors one line per migration BY DESIGN — silent repairs are forbidden
 * — so a fixture one plugin-default behind its plugins failed the smoke test with
 * six "filled with plugin defaults" lines. A test that cannot tell a diagnostic
 * from a defect cannot catch a defect. So console.error is now classified against
 * a NAMED, NARROW allowlist (ALLOWED_CONSOLE): allowed lines are DIAGNOSTICS —
 * reported at the end, never swallowed — and everything else is a failure.
 * `pageerror` is never allowlisted; an uncaught exception is always a failure.
 *
 * Run: node src/demo_apps/PowerRP/tests/editor_smoke.js <shot_dir>
 * (<shot_dir> is resolved against the CALLER's cwd; every path this file needs of
 * its own resolves off the file, the suite convention.)
 */
import { readFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import puppeteer from "puppeteer";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, "../web");
const demoJson = await readFile(resolve(here, "../examples/demo.powerrp.json"), "utf8");
const shots = process.argv[2];
if (!shots) throw new Error("usage: node src/demo_apps/PowerRP/tests/editor_smoke.js <shot_dir>");
await mkdir(shots, { recursive: true }); // screenshots must never fail on a missing artifact dir

/**
 * console.error text that is legitimate DIAGNOSTIC output rather than a defect.
 * Each entry names ONE condition and nothing more — a broad pattern here is how
 * five browser probes failed unnoticed for a whole session, so these must stay
 * narrow enough that a real error in the same subsystem still fails the run.
 *   1. The load-boundary repair's own report lines (printRepairReports). Loud by
 *      design; the deck being migrated is not the editor misbehaving.
 *   2. THE no-adapter condition only. This container exposes `navigator.gpu` but
 *      `requestAdapter()` resolves null, and CanvasView mounts VideoV7Overlay
 *      unconditionally, so its eager device init reports a loud fallback on every
 *      boot regardless of deck content. Environment, not product — and narrow
 *      enough that a context-creation or device-lost failure still fails here.
 *      Same literal tests/boolean_uniformity_probe.js already uses.
 */
const ALLOWED_CONSOLE = [/^PowerRP repair: /, /no WebGPU adapter/];

/**
 * Pure function. True when a console.error line is an allowed diagnostic.
 *
 * @param {string} text - the console.error message text
 * @returns {boolean}
 *
 * @example isDiagnostic('PowerRP repair: item "a" was missing softEdges — filled with plugin defaults') // true
 * @example isDiagnostic("VideoV7: WebGPU init failed — using 2D drawImage fallback: Error: VideoV7: no WebGPU adapter") // true
 * @example isDiagnostic("TypeError: app.nodes is not a function") // false
 * @example isDiagnostic("VideoV7: canvas.getContext('webgpu') returned null") // false — a real WebGPU defect still fails
 */
const isDiagnostic = (text) => ALLOWED_CONSOLE.some((re) => re.test(text));

const server = await createServer({
  configFile: resolve(webRoot, "vite.config.js"),
  server: { port: 0, open: false, host: "127.0.0.1" },
});
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/`;

const browser = await puppeteer.launch({ headless: "new", args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox", "--ignore-gpu-blocklist"] });
const errors = [];
const diagnostics = []; // allowed console.error lines — printed, never swallowed

/** Command (writes to stdout). Prints the allowed diagnostics, so a filter that has
 *  gone stale or over-broad is visible in the log instead of hiding output that
 *  should have failed the run. Silent filtering is what this file is fixing. */
const reportDiagnostics = () => {
  if (diagnostics.length) console.log(`DIAGNOSTICS (allowed, not failures) x${diagnostics.length}:\n` + diagnostics.join("\n"));
};

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    (isDiagnostic(m.text()) ? diagnostics : errors).push(`console.error: ${m.text()}`);
  });
  await page.evaluateOnNewDocument((json) => localStorage.setItem("powerrp.autosave", json), demoJson);
  await page.goto(url, { waitUntil: "networkidle0" });
  await new Promise((r) => setTimeout(r, 600));
  await page.screenshot({ path: `${shots}/editor_slide1.png` });
  if (errors.length) {
    reportDiagnostics();
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

  reportDiagnostics();
  if (errors.length) {
    console.error("PAGE ERRORS:\n" + errors.join("\n"));
    process.exit(1);
  }
  console.log("Editor smoke test passed, screenshots written.");
} finally {
  await browser.close();
  await server.close();
}
