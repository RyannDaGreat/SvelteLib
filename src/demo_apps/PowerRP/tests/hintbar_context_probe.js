/**
 * HINTBAR CONTEXT probe (item 61 — THE HINTBAR COMPLETENESS LAW). Boots the editor
 * with the demo deck and proves that the CONTEXTUAL chips — the ones that used to be
 * the sweep's chipless "LOCAL" drift — actually appear on the bottom bar in the
 * context where their keys apply, and vanish when it passes.
 *
 * The four pins the coordinator named:
 *   (a) focusing the SlideNav rename input makes the bar show the Enter/Esc rename
 *       chips, and blurring removes them;
 *   (b) opening a dialog shows "Esc Close" (and Tab "Next field");
 *   (c) opening a popover (the ShapePicker) shows its "Esc Close" chip;
 *   (d) NONE of those contextual chips show at idle.
 *
 * The bar is a dumb renderer of [keys, label] pairs, so the label text in
 * `.hintbar .label` IS the observable: a chip shows iff its label is in that list.
 *
 * Run from SvelteLib root or PowerRP dir: node tests/hintbar_context_probe.js
 */
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { launchBrowser } from "./puppeteerLaunch.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const demoJson = await readFile(resolve(HERE, "../examples/demo.powerrp.json"), "utf8");
const server = await createServer({ configFile: resolve(HERE, "../web/vite.config.js"), server: { port: 0, open: false, host: "127.0.0.1", hmr: false, watch: null } });
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/`;
const browser = await launchBrowser();
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

  /** Query. The label text of every chip currently on the HintBar. */
  const labels = () => page.evaluate(() => [...document.querySelectorAll(".hintbar .label")].map((e) => e.textContent));
  const has = (arr, ...want) => want.every((w) => arr.includes(w));
  const none = (arr, ...unwanted) => unwanted.every((w) => !arr.includes(w));

  // ── (d) IDLE: the bar shows the canvas hint set, and NONE of the contextual chips.
  const idle = await labels();
  ok(idle.length > 0 && has(idle, "Select / drag"), `idle bar shows the canvas hints (got ${JSON.stringify(idle)})`);
  ok(none(idle, "Rename", "Cancel", "Commit", "Close", "Choose"), `idle bar shows NO contextual field/popover/dialog chips (got ${JSON.stringify(idle)})`);

  // ── (a) FIELD SCOPE: focusing the slide-rename input shows Enter/Esc rename chips.
  await page.evaluate(() => document.querySelector(".slidenav .slide .name").dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
  await sleep(200);
  const scope = await page.evaluate(() => document.activeElement?.dataset?.hintScope ?? null);
  ok(scope === "rename", `the rename input is focused and carries data-hint-scope="rename" (got ${JSON.stringify(scope)})`);
  const renaming = await labels();
  ok(has(renaming, "Rename", "Cancel"), `focusing the rename input shows "Rename" + "Cancel" chips (got ${JSON.stringify(renaming)})`);
  // Escape cancels the rename AND blurs → the chips must clear.
  await page.keyboard.press("Escape");
  await sleep(200);
  const afterBlur = await labels();
  ok(none(afterBlur, "Rename", "Cancel"), `blurring the rename input removes the "Rename"/"Cancel" chips (got ${JSON.stringify(afterBlur)})`);

  // ── (b) DIALOG: opening a modal dialog shows "Close" + "Next field".
  await page.evaluate(() => window.__powerrp_app.renamePresentation());
  await sleep(300);
  ok(await page.evaluate(() => !!document.querySelector('[role="dialog"]')), "renamePresentation opens a role=dialog Modal");
  const dialog = await labels();
  ok(has(dialog, "Close", "Next field"), `an open dialog shows "Close" + "Next field" chips (got ${JSON.stringify(dialog)})`);
  ok(none(dialog, "Select / drag"), `the canvas chips stand DOWN behind the dialog takeover (got ${JSON.stringify(dialog)})`);
  await page.keyboard.press("Escape");
  await sleep(250);
  ok(none(await labels(), "Close", "Next field"), "closing the dialog removes its chips");

  // ── (c) POPOVER: opening the ShapePicker (a real click, which focuses its trigger)
  //     shows its "Close" chip, and the canvas chips stand down.
  await page.click(".shape-picker button");
  await sleep(300);
  const popover = await labels();
  ok(has(popover, "Close"), `an open popover (ShapePicker) shows its "Close" chip (got ${JSON.stringify(popover)})`);
  ok(none(popover, "Select / drag"), `the canvas chips stand DOWN behind the popover takeover (got ${JSON.stringify(popover)})`);

  if (errors.length) {
    console.error("PROBE ERRORS:\n" + errors.join("\n"));
    process.exit(1);
  }
  console.log(`HintBar context probe passed: ${checks.length}/${checks.length} checks, zero console errors.`);
  for (const [, label] of checks) console.log(`  ok  ${label}`);
} finally {
  await browser.close();
  await server.close();
}
