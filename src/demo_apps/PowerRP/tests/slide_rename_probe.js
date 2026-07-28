/**
 * SLIDE RENAME probe (Round 4 #54: "I can't even double click the title of the
 * slide to rename it — add me a control"). Boots the editor with the demo deck
 * and drives the navigator's inline rename: double-click the slide name → an
 * input appears seeded with the current name → type → Enter commits ONE undo
 * unit; Escape cancels without committing; blank restores the positional
 * default. The Inspector boundary panel's Name field shares the same
 * app.renameSlide seam, exercised here directly.
 *
 * Run from SvelteLib root or PowerRP dir: node tests/slide_rename_probe.js
 */
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import puppeteer from "puppeteer";

const HERE = dirname(fileURLToPath(import.meta.url));
const demoJson = await readFile(resolve(HERE, "../examples/demo.powerrp.json"), "utf8");
const server = await createServer({ configFile: resolve(HERE, "../web/vite.config.js"), server: { port: 0, open: false, host: "127.0.0.1", hmr: false, watch: null } });
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/`;
const browser = await puppeteer.launch({ headless: "new", args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox", "--ignore-gpu-blocklist"] });
const errors = [];
const checks = [];
const ok = (cond, label) => { checks.push([!!cond, label]); if (!cond) errors.push(`CHECK FAILED: ${label}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const IGNORE_BOOT = [/PowerRP repair:/, /was missing font/, /no.*adapter|adapters/i];

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") errors.push(`console.error: ${m.text()}`); });
  await page.evaluateOnNewDocument((json) => localStorage.setItem("powerrp.autosave", json), demoJson);
  await page.goto(url, { waitUntil: "networkidle0" });
  await sleep(700);
  const boot = errors.filter((e) => !IGNORE_BOOT.some((re) => re.test(e)));
  if (boot.length) { console.error("BOOT ERRORS:\n" + boot.join("\n")); process.exit(1); }
  errors.length = 0;

  const nameOf = (i) => page.evaluate((n) => window.__powerrp_app.doc.slides[n].name, i);
  const before = await nameOf(0);

  // dblclick the first slide's name → inline input appears, seeded
  await page.evaluate(() => {
    const el = document.querySelector(".slidenav .slide .name");
    el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  });
  await sleep(150);
  const seeded = await page.evaluate(() => document.querySelector(".slidenav .name-edit")?.value ?? null);
  ok(seeded === before, `double-click opens the inline editor seeded with the current name; got ${JSON.stringify(seeded)}`);

  // type a new name, Enter commits one undo unit
  await page.evaluate(() => { const inp = document.querySelector(".slidenav .name-edit"); inp.value = ""; });
  await page.type(".slidenav .name-edit", "Grand Opening");
  await page.keyboard.press("Enter");
  await sleep(200);
  ok((await nameOf(0)) === "Grand Opening", "Enter commits the typed name to the doc");
  ok(await page.evaluate(() => !document.querySelector(".slidenav .name-edit")), "the editor closes on commit");
  await page.evaluate(() => window.__powerrp_app.undo());
  await sleep(150);
  ok((await nameOf(0)) === before, `the rename was ONE undo unit (undo restores ${JSON.stringify(before)})`);

  // Escape cancels without committing
  await page.evaluate(() => {
    document.querySelector(".slidenav .slide .name").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  });
  await sleep(150);
  await page.type(".slidenav .name-edit", "XXX");
  await page.keyboard.press("Escape");
  await sleep(150);
  ok((await nameOf(0)) === before, "Escape cancels without committing");

  // blank restores the positional default (via the shared seam)
  await page.evaluate(() => window.__powerrp_app.renameSlide(0, "   "));
  await sleep(100);
  ok((await nameOf(0)) === "Slide 1", `blank restores the positional default; got ${JSON.stringify(await nameOf(0))}`);
  await page.evaluate(() => window.__powerrp_app.undo());

  if (errors.length) {
    console.error("PROBE ERRORS:\n" + errors.join("\n"));
    process.exit(1);
  }
  console.log(`Slide rename probe passed: ${checks.length}/${checks.length} checks, zero console errors.`);
  for (const [, label] of checks) console.log(`  ok  ${label}`);
} finally {
  await browser.close();
  await server.close();
}
