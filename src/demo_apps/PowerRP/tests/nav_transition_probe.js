/**
 * Navigator transition-slice probe (verification, ephemeral). Boots the editor
 * with the demo deck, screenshots the Slide Navigator, then clicks the first
 * transition slice and asserts app.selectedTransition is set and item selection
 * cleared (mutual exclusivity). Zero console errors required.
 *
 *   node src/demo_apps/PowerRP/tests/nav_transition_probe.js <shot_dir>
 */

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { readFile } from "node:fs/promises";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../web");
const repo = resolve(webRoot, "../../../..");
const shotDir = process.argv[2] ?? resolve(webRoot, "../.claude_logs");
const demoJson = await readFile(resolve(webRoot, "../examples/demo.powerrp.json"), "utf8");

const { createServer } = await import("vite");
const server = await createServer({ configFile: resolve(webRoot, "vite.config.js"), server: { port: 0, open: false, host: "127.0.0.1" } });
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/`;

const { launchBrowser } = await import("./puppeteerLaunch.js");
const browser = await launchBrowser();
const errors = [];
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 2 });
  // Ignore the pre-existing CanvasView zero-sized-canvas paint race (a headless
  // layout-timing artifact in a file outside this task's scope) — this probe
  // validates the NAVIGATOR + selection seam, not the viewport paint loop.
  // VideoV7: headless SwiftShader has no WebGPU adapter, so the overlay reports
  // its 2D-drawImage fallback on every boot (theme_probe.js/clipboard_duplicate_
  // probe.js precedent) — orthogonal to the nav-transition path under test here.
  const ignore = (t) => /zero-sized canvas/.test(t) || /VideoV7: WebGPU init failed/.test(t);
  page.on("pageerror", (e) => { if (!ignore(e.message)) errors.push(`pageerror: ${e.message}`); });
  page.on("console", (m) => { if (m.type() === "error" && !ignore(m.text())) errors.push(`console.error: ${m.text()}`); });
  await page.evaluateOnNewDocument((json) => localStorage.setItem("powerrp.autosave", json), demoJson);
  await page.goto(url, { waitUntil: "networkidle0" });
  await new Promise((r) => setTimeout(r, 400));

  const sliceCount = await page.$$eval(".transition-slice", (els) => els.length);
  if (sliceCount < 2) throw new Error(`expected >=2 transition slices for the 3-slide demo, got ${sliceCount}`);

  await page.screenshot({ path: resolve(shotDir, "nav_transitions.png"), clip: { x: 0, y: 0, width: 260, height: 900 } });

  // Select an item first, then click the transition slice — assert exclusivity.
  const result = await page.evaluate(async () => {
    const app = window.__powerrp_app;
    app.selection = app.nodes()[0]?.itemId ?? null; // pick some item
    const hadItem = app.selection;
    document.querySelectorAll(".transition-slice")[0].click();
    return {
      hadItem,
      selectedTransition: app.selectedTransition,
      selectionAfter: app.selection,
      targetKind: app.selectionTarget?.kind,
      transitionResolved: app.transitionAt(app.selectedTransition),
    };
  });
  await page.screenshot({ path: resolve(shotDir, "nav_transition_selected.png"), clip: { x: 0, y: 0, width: 260, height: 900 } });

  if (!result.selectedTransition) throw new Error("clicking the slice did not set selectedTransition");
  if (result.selectionAfter !== null) throw new Error("selecting a transition did not clear item selection (mutual exclusivity broken)");
  if (result.targetKind !== "transition") throw new Error(`selectionTarget.kind = ${result.targetKind}, expected "transition"`);
  if (!result.transitionResolved?.type) throw new Error("transitionAt returned no record");
  if (errors.length) throw new Error(`console errors:\n${errors.join("\n")}`);

  console.log(`NAV PROBE OK: ${sliceCount} slices; slice-click selected transition (${result.transitionResolved.type}, ${result.transitionResolved.seconds}s), cleared item selection. Zero console errors.`);
  console.log("  screenshots:", resolve(shotDir, "nav_transitions.png"), resolve(shotDir, "nav_transition_selected.png"));
} finally {
  await browser.close();
  await server.close();
}
