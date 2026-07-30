/**
 * HINTBAR SAVE + LEGIBILITY probe — the browser half of the shortcut-convention audit.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 * The user reported: "Cmd+S saves the project and yet that shortcut is not listed
 * on the bottom." The registry was innocent — `save-dispatch` is registered with a
 * label and an `editMode` scope, and every bare-node guard passed. So the report
 * could only be answered by LOOKING at the running app, which is what this does.
 *
 * It pins TWO things the existing hintbar_context_probe.js structurally cannot see,
 * because that probe reads `.hintbar .label` TEXT CONTENT and text content is
 * present for a chip that is scrolled out of the bar's clipped viewport:
 *
 *   (1) THE USER'S CASE. With the canvas focused, a "Save" chip is on the bar, and
 *       it is really ON SCREEN — inside the bar's own rect, not merely in the DOM.
 *
 *   (2) THE LEGIBILITY DIRECTION, which is the third kind of violation the audit
 *       looked for and the one nothing guarded. The HintBar's resting height is ONE
 *       ROW with `overflow: hidden` (src/lib/HintBar.svelte, --hint-rows), so chips
 *       past the first row are CLIPPED — registered, satisfiable, in the DOM, and
 *       invisible. Measured on this deck at 1440x900 with an item selected: 26 chips
 *       rendered, 21 visible, 5 clipped (Add to selection / Grab / Scale / Pan /
 *       Zoom). That is BY DESIGN — the bar is draggable and the palette lists
 *       everything — but "Save" specifically must never be among the clipped, since
 *       it is the key the user actually went looking for.
 *
 * The observable for (2) is GEOMETRY, not text: a chip counts as visible iff its
 * rect lies inside the bar's rect. That distinction is the entire point of the probe.
 *
 * Run from SvelteLib root or PowerRP dir: node tests/hintbar_save_probe.js
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
  await sleep(800);
  const boot = errors.filter((e) => !IGNORE_BOOT.some((re) => re.test(e)));
  if (boot.length) { console.error("BOOT ERRORS:\n" + boot.join("\n")); process.exit(1); }
  errors.length = 0;

  /**
   * Query. Every chip on the bar as {label, visible}, where `visible` means the
   * chip's rect lies INSIDE the bar's rect — the bar clips overflow rows, so DOM
   * presence is not visibility and only this distinction answers the user's report.
   */
  const chips = () => page.evaluate(() => {
    const bar = document.querySelector(".hintbar");
    const b = bar.getBoundingClientRect();
    return [...bar.querySelectorAll(".hint")].map((el) => {
      const r = el.getBoundingClientRect();
      return { label: el.querySelector(".label")?.textContent ?? "", visible: r.top >= b.top - 1 && r.bottom <= b.bottom + 1 && r.right <= b.right + 1 };
    });
  });
  const onScreen = async (label) => (await chips()).some((c) => c.label === label && c.visible);

  // ── (1) THE USER'S CASE: canvas focused, a Save chip is on the bar AND on screen.
  await page.click("canvas.scene");
  await sleep(300);
  const idle = await chips();
  ok(idle.some((c) => c.label === "Save"), `a "Save" chip is registered on the bar (got ${JSON.stringify(idle.map((c) => c.label))})`);
  ok(await onScreen("Save"), `the "Save" chip is really ON SCREEN, not clipped into an overflow row — the user's exact report`);

  // The chip must name the key the user pressed. Cmd covers Ctrl in dispatch, so
  // the registry writes "Cmd"; keyicons renders it as a glyph, hence the icon check.
  const saveKeys = await page.evaluate(() => {
    const hint = [...document.querySelectorAll(".hintbar .hint")].find((e) => e.querySelector(".label")?.textContent === "Save");
    return hint ? [...hint.querySelectorAll(".keys kbd > *")].map((n) => n.tagName === "SPAN" ? n.textContent : n.getAttribute("icon")) : null;
  });
  ok(saveKeys?.includes("S"), `the Save chip's combo ends in the "S" key (got ${JSON.stringify(saveKeys)})`);
  ok(saveKeys?.length === 2, `the Save chip shows a two-token combo — a modifier glyph + S (got ${JSON.stringify(saveKeys)})`);

  // ── (2) SAVE SURVIVES THE BUSIEST CONTEXT. Selecting an item takes the bar from
  //     13 chips to 26, which is where the one-row clip starts biting. Save is early
  //     in registration order, so it must still be on screen; this is what would
  //     regress if anyone reordered the entries or added chips ahead of it.
  await page.evaluate(() => { const a = window.__powerrp_app; a.addItem({ ...a.registry.get("rect").defaults, x: 300, y: 300, w: 120, h: 90 }); });
  await sleep(400);
  const selected = await chips();
  ok(selected.length > idle.length, `selecting an item grows the hint set (${idle.length} → ${selected.length} chips)`);
  ok(await onScreen("Save"), `the "Save" chip stays ON SCREEN in the busiest (selection) context, ${selected.length} chips deep`);

  // ── (3) THE CLIP IS REAL, and this probe can see it. Not a defect — the bar is
  //     draggable by design — but asserting it here is what keeps the visibility
  //     measurement HONEST: if this ever reports zero clipped chips at this width,
  //     the geometry check has gone vacuous and checks (1)/(2) prove nothing.
  const clipped = selected.filter((c) => !c.visible);
  ok(clipped.length > 0, `the one-row bar really does clip overflow chips at 1440px (${clipped.length} clipped: ${JSON.stringify(clipped.map((c) => c.label))}) — proves the visibility test is not vacuous`);

  // ── (4) DRAGGING THE BAR TALLER REVEALS THEM, which is the documented escape
  //     hatch that makes the clip acceptable rather than a lost input.
  await page.evaluate(() => {
    const bar = document.querySelector(".hintbar");
    bar.style.setProperty("--hint-h", "60px"); // what a grip drag sets
  });
  await sleep(250);
  const revealed = (await chips()).filter((c) => c.visible).length;
  ok(revealed > selected.filter((c) => c.visible).length, `dragging the bar taller reveals clipped chips (${selected.filter((c) => c.visible).length} → ${revealed} visible)`);

  if (errors.length) {
    console.error("PROBE ERRORS:\n" + errors.join("\n"));
    process.exit(1);
  }
  console.log(`HintBar save probe passed: ${checks.length}/${checks.length} checks, zero console errors.`);
  for (const [, label] of checks) console.log(`  ok  ${label}`);
} finally {
  await browser.close();
  await server.close();
}
