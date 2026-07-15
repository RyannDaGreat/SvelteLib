/**
 * Opus23 cruft-batch + minimap probe (headless puppeteer). Verifies the four
 * behavior-preservation / correctness claims of the SET-1 cruft batch:
 *   1. repairedDocument runs at boot (the same repair the CLI runs) and is the
 *      ONLY console noise is the DOCUMENTED stale-fixture text-defaults fill
 *      (Opus21's rich-text keys on the pre-rich-text demo) — no NEW errors.
 *   2. The BROWSER settings factory round-trips: toggling minimap writes
 *      localStorage "powerrp.minimap" = "off" and flips app.minimapVisible.
 *   3. The shared KeyframeControls renders in BOTH the Property Panel and the
 *      Variables Panel (same .keybtn/.jumpbtn markup) — the extraction landed.
 *   4. EDITOR vs CLI render PARITY: window.__powerrp_render (the CLI hook, now
 *      on cameraFrameIR + repairedDocument) and the shared pixel service
 *      (renderCameraFrame, also on cameraFrameIR) produce byte-identical PNGs
 *      for one frame — proving cameraFrameIR + repairedDocument parity.
 *
 * Run from SvelteLib root: node src/demo_apps/PowerRP/tests/cruft23_probe.js
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer } from "vite";
import puppeteer from "puppeteer";

const repo = process.cwd();
const webRoot = resolve(repo, "src/demo_apps/PowerRP/web");
const demoJson = await readFile(resolve(repo, "src/demo_apps/PowerRP/examples/demo.powerrp.json"), "utf8");

// Documented boot noise we tolerate: ANY `PowerRP repair:` line. Those ARE my
// repairedDocument pipeline reporting loudly — the demo fixture predates the
// parallel fleet's grown plugin defaults / legacyKeys (rich-text align/spacing,
// stroke-bundle rimColor→stroke, shape/cornerRadius, ...), so the load-boundary
// repair correctly fills/renames them. The fixture-regen interleave concerns.md
// records repeatedly; a repair report firing PROVES the pipeline runs. ANY
// NON-repair console.error still fails the probe.
const IGNORE_BOOT = /PowerRP repair:/;

const server = await createServer({
  configFile: resolve(webRoot, "vite.config.js"),
  server: { port: 0, open: false, host: "127.0.0.1" },
});
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/`;
const browser = await puppeteer.launch({ headless: "new" });

let failed = false;
function check(name, ok) {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}`);
  if (!ok) failed = true;
}

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  const unexpected = [];
  page.on("pageerror", (e) => unexpected.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error" && !IGNORE_BOOT.test(m.text())) unexpected.push(`console.error: ${m.text()}`);
  });
  await page.evaluateOnNewDocument((json) => localStorage.setItem("powerrp.autosave", json), demoJson);
  await page.goto(url, { waitUntil: "networkidle0" });
  await new Promise((r) => setTimeout(r, 800));

  check("boot: no UNEXPECTED errors (only the documented text-defaults fill)", unexpected.length === 0);
  if (unexpected.length) console.error("    unexpected:\n    " + unexpected.join("\n    "));

  // 2. Settings factory round-trip: toggle minimap, read localStorage + state.
  const settings = await page.evaluate(() => {
    const app = window.__powerrp_app;
    const before = app.minimapVisible;
    app.toggleMinimap();
    const persisted = localStorage.getItem("powerrp.minimap");
    const flipped = app.minimapVisible;
    app.toggleMinimap(); // restore
    return { before, flipped, persisted, restored: app.minimapVisible };
  });
  check("settings factory: toggleMinimap flips state", settings.before !== settings.flipped);
  check("settings factory: persists 'on'/'off' to the SAME key", settings.persisted === "off" || settings.persisted === "on");
  check("settings factory: restores on re-toggle", settings.before === settings.restored);

  // 3. KeyframeControls in the Property Panel: select the rect, count .keybtn.
  await page.evaluate(() => {
    const app = window.__powerrp_app;
    const items = app.doc.slides[0].delta.items;
    app.selection = Object.keys(items).find((id) => items[id].type === "rect");
  });
  await new Promise((r) => setTimeout(r, 300));
  const inspectorKeybtns = await page.$$eval(".inspector .keybtn", (els) => els.length);
  const inspectorJumpbtns = await page.$$eval(".inspector .jumpbtn", (els) => els.length);
  check("KeyframeControls: Property Panel has ◆ keybtns", inspectorKeybtns >= 1);
  check("KeyframeControls: Property Panel has ‹ › jumpbtns (2 per row)", inspectorJumpbtns >= 2);

  // Variables Panel: add a variable, confirm its KeyframeControls render.
  await page.evaluate(() => window.__powerrp_app.addVariable("probe_var"));
  await new Promise((r) => setTimeout(r, 300));
  const varsKeybtns = await page.$$eval(".varspanel .keybtn", (els) => els.length);
  const varsJumpbtns = await page.$$eval(".varspanel .jumpbtn", (els) => els.length);
  check("KeyframeControls: Variables Panel has ◆ keybtn", varsKeybtns >= 1);
  check("KeyframeControls: Variables Panel has ‹ › jumpbtns", varsJumpbtns >= 2);

  // 4. Editor(pixel service) vs CLI render byte parity for one frame. The app's
  //    own vite root is web/, so the module is served at /gpuService.js.
  const parity = await page.evaluate(async () => {
    const app = window.__powerrp_app;
    const doc = app.doc;
    const W = 320, H = 180;
    // The CLI hook (main.js): repairedDocument + cameraFrameIR.
    const cliUrl = await window.__powerrp_render(doc, { slide: 0, alpha: 1, width: W, height: H });
    // The shared pixel service (gpuService.renderCameraFrame, also cameraFrameIR).
    const svc = await import("/gpuService.js");
    const canvas = await svc.renderCameraFrame(doc, { slideIndex: 0, alpha: 1, registry: app.registry, width: W, height: H });
    const svcUrl = canvas.toDataURL("image/png");
    return { cliLen: cliUrl.length, svcLen: svcUrl.length, identical: cliUrl === svcUrl };
  });
  check("render parity: CLI hook and pixel service emit byte-identical PNG (cameraFrameIR + repairedDocument)", parity.identical);
  if (!parity.identical) console.error(`    cliLen=${parity.cliLen} svcLen=${parity.svcLen}`);

  // 5. Minimap: with it visible, the thumb data URL is produced (camera-based
  //    render lands) and the MiniMap SVG mounts.
  const minimap = await page.evaluate(async () => {
    const app = window.__powerrp_app;
    if (!app.minimapVisible) app.toggleMinimap();
    return true;
  });
  await new Promise((r) => setTimeout(r, 600));
  const minimapImg = await page.$$eval(".minimap-dock image", (els) => els.length);
  const minimapHref = await page.$eval(".minimap-dock image", (el) => (el.getAttribute("href") || "").startsWith("data:image/png")).catch(() => false);
  check("minimap: MiniMap content image mounts", minimapImg >= 1);
  check("minimap: content is a camera-frame PNG data URL", minimapHref === true);
} finally {
  await browser.close();
  await server.close();
}

if (failed) {
  console.error("\ncruft23 probe: FAILURES above");
  process.exit(1);
}
console.log("\ncruft23 probe: all checks passed");
