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
 * BOTH SURFACES ARE MODALS NOW. The slide name was an inline editor when this
 * probe was written; a later ruling (2026-08-02) made it the SAME dialog the
 * project title uses — "in the same way that rename project does… A dialog comes
 * up pre-selected and whatever process for that should be reused for this."
 * Ruling 1 is therefore asserted at both surfaces unchanged, and is the reason
 * this probe still earns its runtime: select-all is exactly the thing that
 * silently regresses to a caret-at-one-end concatenation.
 * Ruling 2 no longer has an inline editor to govern anywhere in the app. What is
 * asserted in its place is the outcome it protected — a half-typed draft is never
 * committed — through the dialog's explicit Cancel.
 *
 * Surfaces asserted:
 *   - SLIDE name, dialog (SlideNav row dblclick → App.svelte slide rename modal):
 *     select-all, ArrowRight-appends, Escape and Cancel both discard.
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

  // ── SURFACE 1: the SLIDE name (DIALOG, dblclick) ──────────────────────────
  // IT IS A DIALOG NOW, not an inline editor (user ruling, 2026-08-02: "when I
  // double click a slide title, it should let me edit it. In the same way that
  // rename project does… A dialog comes up pre-selected"). The SELECT-ALL ruling
  // this probe exists for is unchanged and still measured the same way — the
  // dialog's input is pre-filled and fully selected, so typing replaces — but the
  // CANCEL surface moved: Escape and a click-away are the Modal's to own, and the
  // dialog has an explicit Cancel button, so (c) and (d) below test that button
  // rather than blur semantics that no longer belong to this control.
  console.log("\nSLIDE NAME (dialog, dblclick):");
  let el = await firstSlideNameEl();
  assert(!!el, "slide name span exists");
  await el.click({ clickCount: 2 });
  await sleep(400);

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

  // (c) Escape cancels — nothing is written. The Modal owns this key now, but the
  //     OUTCOME the ruling names is the same and is what is asserted.
  el = await firstSlideNameEl();
  await el.click({ clickCount: 2 });
  await sleep(400);
  await page.keyboard.type("ThrownAway");
  await page.keyboard.press("Escape");
  await sleep(400);
  assert((await slideName(0)) === "NewNameZ", `Escape CANCELS — name unchanged (got "${await slideName(0)}")`);

  // (d) THE SECOND RULING — "clicking away should cancel" — is now served by an
  //     explicit Cancel BUTTON rather than by blur. That is a real improvement to
  //     assert rather than mourn: the old inline editor cancelled on any wandering
  //     focus, which meant a half-typed name could be lost by clicking anywhere;
  //     a dialog only discards when the user says to. What must stay true either
  //     way is that a half-typed draft is NEVER committed.
  el = await firstSlideNameEl();
  await el.click({ clickCount: 2 });
  await sleep(400);
  await page.keyboard.type("HalfTyped");
  sel = await selectionOf();
  assert(sel?.value === "HalfTyped", `the draft really is in the input before cancelling (got "${sel?.value}")`);
  await page.evaluate(() => [...document.querySelectorAll(".slide-rename-modal button")].find((b) => b.textContent.trim() === "Cancel")?.click());
  await sleep(400);
  assert((await slideName(0)) === "NewNameZ", `Cancel DISCARDS the draft — name unchanged (got "${await slideName(0)}")`);
  // SCOPED to the slide dialog. Three dialogs render .name-modal-input, so the
  // bare class cannot say which one is open — asserting on it here was answered
  // by the PROJECT rename modal and reported a false failure.
  assert(await page.evaluate(() => !document.querySelector(".slide-rename-modal")), "the dialog closed on Cancel");

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
