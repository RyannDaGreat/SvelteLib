/**
 * RENAME SELECT-ALL + BLUR-CANCELS PROBE — pins the two rulings that made every
 * name editor in the app behave the same way.
 *
 * Ruling 1 (select-all): "When I click to rename, or I double click a slide to
 * edit the name, it should by default select all the text — so that if I simply
 * start typing it would rename the whole thing. Of course I could always press
 * the arrow key to rename part of it, but that should be the default."
 * The bug this catches: an editor that FOCUSES without SELECTING leaves the
 * caret at one end, so typing "NewName" over "Slide 1" yields a CONCATENATION
 * ("Slide 1NewName"), not a rename.
 *
 * Ruling 2 (blur cancels): "When I'm renaming a slide, clicking away should
 * cancel." Only for INLINE editors. A modal's backdrop/Cancel already means
 * cancel and its semantics are untouched.
 *
 * Surfaces asserted:
 *   - SLIDE name, inline (SlideNav → InlineRename, dblclick): select-all,
 *     ArrowRight-appends, and blur CANCELS (the ruling's own scenario: type
 *     garbage, click the canvas, the slide keeps its ORIGINAL name).
 *   - PROJECT title, modal (Toolbar single click → App.svelte rename modal,
 *     use:selectAllOnMount): select-all and ArrowRight-appends. Blur is NOT
 *     asserted to cancel — modals keep modal semantics by ruling.
 *
 * Spawns its OWN isolated Vite + headless Chromium, cribbed from
 * text_undo_probe.js. Run from POWERRP or the SvelteLib root (cwd-independent).
 */
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(HERE, "../web");

const { createServer } = await import("vite");
const server = await createServer({ configFile: resolve(webRoot, "vite.config.js"), server: { port: 0, open: false, host: "127.0.0.1" } });
await server.listen();
const baseUrl = `http://127.0.0.1:${server.httpServer.address().port}`;

const { launchBrowser } = await import("./puppeteerLaunch.js");
const browser = await launchBrowser();

const errors = [];
const fails = [];
const assert = (cond, msg) => { if (!cond) { fails.push(msg); console.log(`  FAIL ${msg}`); } else { console.log(`  ok   ${msg}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  // Frontend-only Vite (no server.py), so project/thumbnail POSTs 404. Orthogonal.
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource|thumbnail|\/api\/|WebGPU|VideoV7|listAssets|listProjects/i.test(m.text())) errors.push(`console.error: ${m.text()}`); });

  await page.goto(`${baseUrl}/`, { waitUntil: "networkidle0" });
  await sleep(3500); // Skia wasm + fonts + first paint
  if (errors.length) { console.error("BOOT ERRORS:\n" + errors.join("\n")); process.exit(1); }

  // A two-slide deck with KNOWN, distinctive names. "Slide 1"-style defaults
  // would make a concatenation bug ambiguous against the positional default.
  await page.evaluate(() => {
    const app = window.__powerrp_app;
    const def = (type) => ({ ...app.registry.get(type).defaults, type });
    const cam = { ...def("camera"), name: "Camera", x: 0, y: 0, w: 1000, h: 500, z: 1000, active: true, background: "#101014" };
    const doc = { meta: { name: "OriginalProject", slideW: 1000, slideH: 500 }, slides: [
      { id: "s0", name: "Alpha", transition: { type: "tween", seconds: 0.4, curve: "smooth", sound: null }, delta: { items: { cam } } },
      { id: "s1", name: "Beta", transition: { type: "tween", seconds: 0.4, curve: "smooth", sound: null }, delta: { items: {} } },
    ] };
    app.commit(app.repaired(doc));
    app.slideIndex = 0;
    app.selection = null;
  });
  await sleep(500);

  const slideName = (i) => page.evaluate((n) => window.__powerrp_app.doc.slides[n].name, i);
  const projectName = () => page.evaluate(() => window.__powerrp_app.projectName());
  // The live selection inside whatever input is focused — this is the ACTUAL
  // measurement of "all text selected", not a proxy for it.
  const selectionOf = () => page.evaluate(() => {
    const el = document.activeElement;
    if (!(el instanceof HTMLInputElement)) return null;
    return { value: el.value, start: el.selectionStart, end: el.selectionEnd };
  });

  const firstSlideNameEl = async () => {
    const handle = await page.evaluateHandle(() => document.querySelector(".slidenav .slide .name"));
    return handle.asElement();
  };

  // ── SURFACE 1: the SLIDE name (inline, dblclick) ──────────────────────────
  console.log("\nSLIDE NAME (inline, dblclick):");
  let el = await firstSlideNameEl();
  assert(!!el, "slide name span exists");
  await el.click({ clickCount: 2 });
  await sleep(300);

  let sel = await selectionOf();
  assert(sel !== null, "double-click opens an input and focuses it");
  assert(sel?.value === "Alpha", `input is pre-filled with the current name (got "${sel?.value}")`);
  assert(sel?.start === 0 && sel?.end === 5, `ALL text is selected on open (got ${sel?.start}..${sel?.end} of 5)`);

  // (a) type with NO other keys → the name is exactly what was typed
  await page.keyboard.type("NewName");
  await page.keyboard.press("Enter");
  await sleep(300);
  assert((await slideName(0)) === "NewName", `typing replaces the WHOLE name (got "${await slideName(0)}" — a concatenation means select-all failed)`);

  // (b) ArrowRight first → selection collapses natively, typing APPENDS
  el = await firstSlideNameEl();
  await el.click({ clickCount: 2 });
  await sleep(300);
  await page.keyboard.press("ArrowRight");
  sel = await selectionOf();
  assert(sel?.start === 7 && sel?.end === 7, `ArrowRight collapses the selection to the end (got ${sel?.start}..${sel?.end})`);
  await page.keyboard.type("Z");
  await page.keyboard.press("Enter");
  await sleep(300);
  assert((await slideName(0)) === "NewNameZ", `ArrowRight then typing APPENDS (got "${await slideName(0)}")`);

  // (c) Escape cancels — nothing is written
  el = await firstSlideNameEl();
  await el.click({ clickCount: 2 });
  await sleep(300);
  await page.keyboard.type("ThrownAway");
  await page.keyboard.press("Escape");
  await sleep(300);
  assert((await slideName(0)) === "NewNameZ", `Escape CANCELS — name unchanged (got "${await slideName(0)}")`);

  // (d) THE SECOND RULING: type garbage, click the canvas, the slide keeps its
  //     ORIGINAL name. Blur must not commit a half-typed name.
  el = await firstSlideNameEl();
  await el.click({ clickCount: 2 });
  await sleep(300);
  await page.keyboard.type("HalfTyped");
  sel = await selectionOf();
  assert(sel?.value === "HalfTyped", `the draft really is in the input before blurring (got "${sel?.value}")`);
  await page.mouse.click(700, 450); // the canvas, well away from the rail
  await sleep(400);
  assert((await slideName(0)) === "NewNameZ", `BLUR (clicking the canvas) CANCELS — name unchanged (got "${await slideName(0)}")`);
  assert(await page.evaluate(() => !document.querySelector(".slidenav .inline-rename-input")), "the editor closed on blur");

  // ── SURFACE 2: the PROJECT title (modal, single click) ────────────────────
  console.log("\nPROJECT TITLE (modal, single click):");
  // .doc-name is the toolbar title (Toolbar.svelte); its SINGLE click opens the
  // rename modal. Clicked for real rather than calling renamePresentation()
  // directly, so the probe exercises the gesture the ruling names.
  const titleEl = await page.evaluateHandle(() => document.querySelector(".doc-name"));
  const titleClickable = titleEl.asElement();
  assert(!!titleClickable, "toolbar title (.doc-name) exists");
  await titleClickable.click();
  await sleep(500);

  sel = await selectionOf();
  assert(sel !== null, "the rename modal opens with its input focused");
  assert(sel?.value === "OriginalProject", `modal input is pre-filled with the project name (got "${sel?.value}")`);
  assert(sel?.start === 0 && sel?.end === 15, `ALL text is selected on open (got ${sel?.start}..${sel?.end} of 15)`);

  // ArrowRight-appends holds here too (same native behaviour, asserted so a
  // future focus rewrite cannot silently break it).
  await page.keyboard.press("ArrowRight");
  sel = await selectionOf();
  assert(sel?.start === 15 && sel?.end === 15, `ArrowRight collapses to the end (got ${sel?.start}..${sel?.end})`);
  await page.keyboard.type("X");
  sel = await selectionOf();
  assert(sel?.value === "OriginalProjectX", `ArrowRight then typing APPENDS in the modal (got "${sel?.value}")`);

  // Leave the modal without renaming — this probe's Vite has no backend, so an
  // actual rename would fail on the network, and the modal's OWN semantics
  // (Cancel/backdrop = cancel) are deliberately not under test here.
  await page.keyboard.press("Escape");
  await sleep(300);
  assert((await projectName()) === "OriginalProject", `Escape leaves the project name alone (got "${await projectName()}")`);

  if (errors.length) fails.push(...errors.map((e) => `unexpected error: ${e}`));
  if (fails.length) { console.error(`\nRENAME SELECT-ALL PROBE FAILED (${fails.length}):\n` + fails.join("\n")); process.exit(1); }
  console.log("\nRENAME SELECT-ALL PROBE PASSED — every name editor opens fully selected (typing replaces), ArrowRight appends, and inline blur CANCELS.");
} finally {
  await browser.close();
  await server.close();
}
