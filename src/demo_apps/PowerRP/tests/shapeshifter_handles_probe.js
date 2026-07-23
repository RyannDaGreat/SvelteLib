/**
 * Shapeshifter HANDLES probe — boots the real editor over a served origin,
 * adds each handle-bearing shapeshifter family, selects it, and verifies the
 * on-canvas yellow MODIFIER squares (`.overlay rect.modifier`) appear at the
 * expected count. Screenshots each so a human/VLM can confirm the handles sit
 * at the right spots (the count assertion pins the wiring; the screenshot pins
 * placement). Mirrors modifier_probe.js's app-driven creation + the QA's
 * swiftshader launch.
 *
 * Run (dev server up): node tests/shapeshifter_handles_probe.js [http://localhost:PORT]
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import puppeteer from "puppeteer";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOG = path.join(HERE, "..", "..", "..", "..", "..", ".claude_logs", "devserver.log");
const SHOTS = path.join(HERE, "..", ".claude_vlm_checks");
const URL = process.argv[2] || fs.readFileSync(LOG, "utf8").match(/https?:\/\/localhost:\d+/)[0];

// family type → expected on-canvas handle count (from plugins/shapeshifter.js)
const EXPECTED = { ss_radialSweep: 3, ss_polygonStar: 2, ss_cornerRect: 4, ss_gear: 2, ss_callout: 1, ss_crossPlus: 2, ss_frame: 1 };

const errors = [];
const results = [];

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await puppeteer.launch({ headless: "new", args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox", "--ignore-gpu-blocklist"] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 800, deviceScaleFactor: 1 });
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push("console.error: " + m.text()); });

  await page.evaluateOnNewDocument(() => localStorage.removeItem("powerrp.autosave"));
  await page.goto(URL, { waitUntil: "networkidle0" });
  await new Promise((r) => setTimeout(r, 800));

  for (const [type, want] of Object.entries(EXPECTED)) {
    // Add the family at a centered, generous size and select it (addItem selects).
    const count = await page.evaluate((type) => {
      const app = window.__powerrp_app;
      app.addItem(app.registry.get(type).defaults);
      const id = app.selection;
      app.setPreview([[["items", id, "x"], 430], [["items", id, "y"], 250], [["items", id, "w"], 320], [["items", id, "h"], 320]]);
      app.commitPreview();
      return id;
    }, type);
    await new Promise((r) => setTimeout(r, 400));
    const handles = await page.evaluate(() => document.querySelectorAll(".overlay rect.modifier").length);
    const ok = handles === want;
    results.push({ type, want, got: handles, ok });
    await page.screenshot({ path: path.join(SHOTS, `shapeshifter_handles_${type}.png`) });
    // Remove it so the next family starts clean (delete the selection).
    await page.evaluate((id) => { const a = window.__powerrp_app; if (a.deleteSelection) a.deleteSelection(); else a.setPreview([[["items", id, "active"], false]]), a.commitPreview(); }, count);
    await new Promise((r) => setTimeout(r, 200));
  }

  await browser.close();
  console.log("Handle-count checks:");
  for (const r of results) console.log(`  ${r.ok ? "ok  " : "FAIL"} ${r.type}: ${r.got} handles (want ${r.want})`);
  const danger = errors.filter((e) => e.startsWith("pageerror:") || /is not a function|cannot read|undefined is not/i.test(e));
  const allOk = results.every((r) => r.ok) && danger.length === 0;
  if (danger.length) console.log("DANGEROUS ERRORS:", danger);
  console.log(`\nRESULT: ${allOk ? "PASS" : "FAIL"} — screenshots in .claude_vlm_checks/shapeshifter_handles_*.png`);
  process.exit(allOk ? 0 : 1);
})();
