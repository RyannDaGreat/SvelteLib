/**
 * SLIDE RENAME probe (Round 4 #54: "I can't even double click the title of the
 * slide to rename it — add me a control"). Boots the editor with the demo deck
 * and drives the rail's rename: double-click a slide row → the Rename Slide
 * DIALOG opens with the name pre-selected → type → confirm commits ONE undo
 * unit; Cancel writes nothing; blank restores the positional default. The
 * Inspector boundary panel's Name field shares the same app.renameSlide seam,
 * exercised here directly.
 *
 * IT DRIVES A REAL MOUSE, and that is the point of this rewrite. The probe used
 * to dispatch a synthetic `new MouseEvent("dblclick")` straight at `.name`, and
 * it stayed GREEN through the entire period the feature was dead in the user's
 * hands ("I'm not able to rename slides. I'm double clicking the name and it
 * won't let me edit the slide name"). The reason is exact: the rail's drag calls
 * setPointerCapture on the ROW, pointer capture RETARGETS the rest of the
 * sequence to the capturing element, and the old inline editor listened on a
 * `display: contents` wrapper reachable only by bubbling from the name span.
 * A synthesized event skips the pointer sequence, so it never sees the capture.
 * page.mouse.click(clickCount: 2) does what a user does; anything less cannot
 * catch this class of bug.
 *
 * Run from SvelteLib root or PowerRP dir: node tests/slide_rename_probe.js
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

  const nameOf = (i) => page.evaluate((n) => window.__powerrp_app.doc.slides[n].name, i);
  const before = await nameOf(0);
  // SCOPED to the slide dialog: three dialogs render .name-modal-input, so the
  // bare class cannot say WHICH one is open.
  const DIALOG_INPUT = ".slide-rename-modal .name-modal-input";
  /** Query. The dialog's input value, or null when no dialog is open. */
  const dialogValue = () => page.evaluate((s) => document.querySelector(s)?.value ?? null, DIALOG_INPUT);
  /** Command. Double-clicks slide row `i` with a REAL mouse (see the header). */
  async function dblclickRow(i) {
    const box = await page.evaluate((n) => {
      const r = document.querySelectorAll(".slidenav [data-slide-row]")[n].getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + 12 }; // near the top: the name row, not the thumbnail
    }, i);
    await page.mouse.click(box.x, box.y, { clickCount: 2 });
    await sleep(300);
  }

  // A real double-click on the row opens the DIALOG, pre-filled AND pre-selected.
  await dblclickRow(0);
  const seeded = await dialogValue();
  ok(seeded === before, `a real double-click opens the Rename Slide dialog seeded with the current name; got ${JSON.stringify(seeded)}`);
  const selection = await page.evaluate((s) => {
    const el = document.querySelector(s);
    return el ? { start: el.selectionStart, end: el.selectionEnd, len: el.value.length } : null;
  }, DIALOG_INPUT);
  ok(selection && selection.start === 0 && selection.end === selection.len,
    `the dialog opens PRE-SELECTED so typing replaces (got ${JSON.stringify(selection)})`);

  // Typing replaces the whole name; submitting commits ONE undo unit.
  await page.keyboard.type("Grand Opening");
  await page.keyboard.press("Enter");
  await sleep(300);
  ok((await nameOf(0)) === "Grand Opening", `confirming commits the typed name (got ${JSON.stringify(await nameOf(0))})`);
  ok(await page.evaluate((s) => !document.querySelector(s), DIALOG_INPUT), "the dialog closes on commit");
  await page.evaluate(() => window.__powerrp_app.undo());
  await sleep(200);
  ok((await nameOf(0)) === before, `the rename was ONE undo unit (undo restores ${JSON.stringify(before)})`);

  // Cancel writes nothing.
  await dblclickRow(0);
  await page.keyboard.type("XXX");
  await page.evaluate(() => [...document.querySelectorAll(".slide-rename-modal button")].find((b) => b.textContent.trim() === "Cancel")?.click());
  await sleep(250);
  ok((await nameOf(0)) === before, `Cancel writes nothing (got ${JSON.stringify(await nameOf(0))})`);

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
