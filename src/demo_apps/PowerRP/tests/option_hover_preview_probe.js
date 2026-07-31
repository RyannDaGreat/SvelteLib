/**
 * OPTION-HOVER PREVIEW probe (manifest item 74 — "when I'm mousing over the
 * options of metal material, it does not preview when I hover over them").
 *
 * The FIX under test: a material-param SELECT knob (metalType brass/chrome/steel…)
 * must live-preview the pointed option on the canvas — the same "point at an
 * option, see it before you pick it" contract the material PICKER and every
 * Inspector select row already obey (web/hoverPreview.js + the SvelteLib Dropdown
 * onpreview/oncancelpreview seam; PaintField.selectKnobHover wires the knob to it).
 *
 * Boots the real editor headless, gives a big rect a METAL fill, and drives the
 * metalType dropdown through the actual DOM — opening it, dispatching pointerenter
 * on option rows, closing, and clicking — asserting BOTH halves of the doctrine:
 *   1. HOVER previews: the pointed metalType is staged in app.previewDelta and the
 *      VIEWPORT canvas pixels change (metal's F0 tint shifts, brass→steel→copper),
 *      while the DOCUMENT (JSON.stringify'd in-page — the doc is a Svelte 5 deep
 *      proxy) is UNTOUCHED and no undo entry appears.
 *   2. moving the hover to another option re-stages (pixels change again);
 *   3. CLOSING without choosing REVERTS — previewDelta cleared, pixels back to the
 *      baseline, doc still unchanged;
 *   4. CLICK-CHOOSE commits ONE undo unit (doc changes; a single undo restores it).
 *
 * The canvas is read via `.canvas-wrap` element screenshots (brightness_contrast_
 * browser_probe's idiom — the real WebGL2 Skia surface). The metalType dropdown
 * menu opens over the right-hand Inspector column, outside the canvas element's
 * box, so element.screenshot never captures the menu itself.
 *
 * Run from SvelteLib root: node src/demo_apps/PowerRP/tests/option_hover_preview_probe.js
 */
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { launchBrowser } from "./puppeteerLaunch.js";
import { PNG } from "pngjs";

// puppeteer ≥23 returns screenshot bytes as Uint8Array; pngjs wants a Buffer.
const readPng = (bytes) => PNG.sync.read(Buffer.from(bytes));

const HERE = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(HERE, "../web");
const demoJson = await readFile(resolve(HERE, "../examples/demo.powerrp.json"), "utf8");

// Two metalType options MAXIMALLY unlike the "brass" default (warm gold): steel
// (#b6bcc2 cool grey) and copper (#c07845 pink-orange). Both differ hugely from
// brass AND from each other, so each hover is an unmistakable pixel shift.
const HOVER_A = { value: "steel", label: "Steel" };
const HOVER_B = { value: "copper", label: "Copper" };

// Mean per-channel |Δ| that counts as "the metal repainted" vs "same frame as
// baseline". Metal's F0 retint is a whole-fill colour change (tens of levels),
// far above raster noise; a static software Skia surface re-shot is bit-identical,
// so the revert floor is generous but the change floor is what proves the preview.
const CHANGE_MIN = 1.5;

const IGNORE_BOOT = [/PowerRP repair:/, /was missing font/, /duration.*transition|transition.*duration/i, /no.*adapter|adapters/i];
const isBootNoise = (s) => IGNORE_BOOT.some((re) => re.test(s));

/**
 * Pure function. Mean per-channel absolute RGB difference between two decoded
 * PNGs of equal size (alpha ignored). 0 ⇒ identical; larger ⇒ more changed.
 *
 * @example // two identical frames → 0
 * @example // brass vs steel fill → tens of levels
 */
function meanDiff(a, b) {
  const n = Math.min(a.data.length, b.data.length);
  let sum = 0, count = 0;
  for (let i = 0; i < n; i += 4) {
    sum += Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2]);
    count += 3;
  }
  return count ? sum / count : 0;
}

const server = await createServer({ configFile: resolve(webRoot, "vite.config.js"), server: { port: 0, open: false, host: "127.0.0.1", hmr: false, watch: null } });
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/`;

const browser = await launchBrowser();
const errors = [];
const checks = [];
const ok = (cond, label) => { checks.push([!!cond, label]); if (!cond) errors.push(`CHECK FAILED: ${label}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") errors.push(`console.error: ${m.text()}`); });
  await page.evaluateOnNewDocument((json) => localStorage.setItem("powerrp.autosave", json), demoJson);
  await page.goto(url, { waitUntil: "networkidle0" });
  await sleep(600);
  const realBoot = errors.filter((e) => !isBootNoise(e));
  if (realBoot.length) { console.error("PAGE ERRORS AT BOOT:\n" + realBoot.join("\n")); process.exit(1); }
  errors.length = 0; // from here ANY console error fails the probe

  // A BIG rect, metal fill, centred on the slide so its interior dominates the
  // canvas image (the metalType retint has plenty of pixels to move). Fill is
  // committed via the same whole-paint write PaintField.commitWhole uses.
  const rectId = await page.evaluate(() => {
    const app = window.__powerrp_app;
    app.slideIndex = 0;
    const W = app.doc.meta.slideW, H = app.doc.meta.slideH;
    app.addItem({ ...app.registry.get("rect").defaults, x: W * 0.1, y: H * 0.1, w: W * 0.8, h: H * 0.8, strokeWidth: 0 });
    const id = app.selection;
    app.setPreview([[["items", id, "fill"], { type: "material", material: { id: "metal", params: {} } }]]);
    app.commitPreview();
    return id;
  });
  ok(rectId, "created a metal-filled rect and selected it");
  await sleep(600); // let the SkSL metal shader compile + paint

  /** JSON-safe read of the selected item's stored fill (in-page stringify: the
   *  doc is a $state proxy that puppeteer's return-by-value mangles). */
  const storedFill = () => page.evaluate((id) => JSON.stringify(window.__powerrp_app.doc.slides[0].delta.items[id].fill ?? null), rectId);
  /** The metalType the previewDelta currently STAGES (null when nothing staged). */
  const previewMetalType = () => page.evaluate((id) => JSON.stringify(window.__powerrp_app.previewDelta?.items?.[id]?.fill?.material?.params?.metalType ?? null), rectId);

  const fillBefore = await storedFill();
  ok(JSON.parse(fillBefore)?.material?.id === "metal", "the rect's fill is the metal material");

  /** Shoot the live editor canvas region, re-querying the element (Svelte may
   *  recreate the wrapper across doc changes — the bc_browser_probe caveat). */
  const shoot = async () => {
    const el = await page.$(".canvas-wrap");
    if (!el) throw new Error("probe: .canvas-wrap not found");
    return readPng(await el.screenshot());
  };

  // Baseline shot ×2 → the ambient noise floor (a static software Skia surface is
  // effectively bit-identical, but this adapts if anything ambient repaints).
  const base1 = await shoot();
  await sleep(120);
  const base2 = await shoot();
  const noiseFloor = meanDiff(base1, base2);
  ok(noiseFloor < CHANGE_MIN, `baseline is stable frame-to-frame (noise floor ${noiseFloor.toFixed(3)} < ${CHANGE_MIN})`);
  const revertMax = Math.max(noiseFloor * 3, 0.5);

  /** Open the metalType dropdown: the Fill row's .paint-material-row labelled
   *  "metalType", its own .dd-trigger. Returns true if found + clicked. */
  const openMetalDropdown = () => page.evaluate(() => {
    const rows = [...document.querySelectorAll(".inspector .row")];
    const fill = rows.find((r) => r.querySelector(".label")?.textContent === "Fill");
    const mrow = fill && [...fill.querySelectorAll(".paint-material-row")].find((pr) => pr.querySelector(".paint-material-label")?.textContent === "metalType");
    const trig = mrow?.querySelector(".dd-trigger");
    if (!trig) return false;
    trig.click();
    return true;
  });
  /** Dispatch pointerenter on the metalType option row whose label === `label`
   *  (the Dropdown collapses pointer + arrow keys to ONE "active" notion, so this
   *  is the exact hover path a real mouse takes). Returns true if the row exists. */
  const hoverOption = (label) => page.evaluate((lbl) => {
    const rows = [...document.querySelectorAll(".inspector .row")];
    const fill = rows.find((r) => r.querySelector(".label")?.textContent === "Fill");
    const mrow = [...fill.querySelectorAll(".paint-material-row")].find((pr) => pr.querySelector(".paint-material-label")?.textContent === "metalType");
    const item = [...mrow.querySelectorAll(".dd-item")].find((li) => li.querySelector(".dd-item-body")?.textContent?.trim() === lbl);
    if (!item) return false;
    item.dispatchEvent(new PointerEvent("pointerenter", { bubbles: true, pointerId: 1 }));
    return true;
  }, label);

  // Close by clicking the trigger again (toggle) — NOT Escape. A real user's
  // Escape hits the Dropdown's own handler (the trigger has focus, stopPropagation
  // keeps it off the app's global Escape=Deselect); but a synthetic pointerenter
  // never focuses the trigger, so a synthetic Escape would bubble to Deselect and
  // clear the Inspector. Toggling the trigger is the material_paint_ui_probe idiom
  // and still fires the Dropdown's oncancelpreview (the revert) on close.
  const closeMetalDropdown = () => page.evaluate(() => {
    const rows = [...document.querySelectorAll(".inspector .row")];
    const fill = rows.find((r) => r.querySelector(".label")?.textContent === "Fill");
    const mrow = [...fill.querySelectorAll(".paint-material-row")].find((pr) => pr.querySelector(".paint-material-label")?.textContent === "metalType");
    mrow.querySelector(".dd-trigger").click();
  });

  ok(await openMetalDropdown(), "opened the metalType dropdown");
  await sleep(120);

  // ── HOVER A (steel): previews live; doc untouched ───────────────────────────
  ok(await hoverOption(HOVER_A.label), `hovered the "${HOVER_A.label}" option`);
  await sleep(250);
  ok(JSON.parse(await previewMetalType()) === HOVER_A.value, `hover stages metalType="${HOVER_A.value}" in previewDelta; got ${await previewMetalType()}`);
  ok(await storedFill() === fillBefore, "hover leaves the DOCUMENT fill unchanged (no write, no undo entry)");
  const shotA = await shoot();
  const diffA = meanDiff(base1, shotA);
  ok(diffA > CHANGE_MIN, `hover REPAINTED the viewport (brass→${HOVER_A.value}: meanΔ ${diffA.toFixed(3)} > ${CHANGE_MIN})`);

  // ── HOVER B (copper): moving the hover re-stages; pixels change again ────────
  ok(await hoverOption(HOVER_B.label), `moved the hover to "${HOVER_B.label}"`);
  await sleep(250);
  ok(JSON.parse(await previewMetalType()) === HOVER_B.value, `re-hover re-stages metalType="${HOVER_B.value}"; got ${await previewMetalType()}`);
  const shotB = await shoot();
  const diffAB = meanDiff(shotA, shotB);
  ok(diffAB > CHANGE_MIN, `moving the hover REPAINTED again (${HOVER_A.value}→${HOVER_B.value}: meanΔ ${diffAB.toFixed(3)} > ${CHANGE_MIN})`);
  ok(await storedFill() === fillBefore, "the document is STILL unchanged after two hovers");

  // ── CLOSE without choosing → REVERTS (previewDelta cleared, pixels restored) ──
  await closeMetalDropdown();
  await sleep(300);
  ok(JSON.parse(await previewMetalType()) === null, "closing the dropdown REVERTED the staged preview (previewDelta cleared)");
  ok(await storedFill() === fillBefore, "closing without choosing left the document unchanged");
  const shotRevert = await shoot();
  const diffRevert = meanDiff(base1, shotRevert);
  ok(diffRevert <= revertMax, `viewport returned to the baseline after close (meanΔ ${diffRevert.toFixed(3)} <= ${revertMax.toFixed(3)})`);

  // ── CLICK-CHOOSE → ONE undo unit ────────────────────────────────────────────
  ok(await openMetalDropdown(), "reopened the metalType dropdown");
  await sleep(120);
  ok(await hoverOption(HOVER_A.label), `hovered "${HOVER_A.label}" to choose it`);
  await sleep(150);
  await page.evaluate((lbl) => {
    const rows = [...document.querySelectorAll(".inspector .row")];
    const fill = rows.find((r) => r.querySelector(".label")?.textContent === "Fill");
    const mrow = [...fill.querySelectorAll(".paint-material-row")].find((pr) => pr.querySelector(".paint-material-label")?.textContent === "metalType");
    const item = [...mrow.querySelectorAll(".dd-item")].find((li) => li.querySelector(".dd-item-body")?.textContent?.trim() === lbl);
    item.click();
  }, HOVER_A.label);
  await sleep(250);
  const fillChosen = JSON.parse(await storedFill());
  ok(fillChosen?.material?.params?.metalType === HOVER_A.value, `clicking committed metalType="${HOVER_A.value}" to the doc; got ${JSON.stringify(fillChosen?.material?.params?.metalType)}`);
  ok(JSON.parse(await previewMetalType()) === null, "after the pick the transient preview is dropped (previewDelta cleared)");
  await page.evaluate(() => window.__powerrp_app.undo());
  await sleep(200);
  const fillUndone = JSON.parse(await storedFill());
  ok((fillUndone?.material?.params?.metalType ?? null) === null, "the pick was ONE undo unit (undo removes the metalType param)");

  if (errors.length) {
    console.error("PROBE ERRORS:\n" + errors.join("\n"));
    console.error(`\n${checks.filter(([c]) => c).length}/${checks.length} checks passed`);
    process.exit(1);
  }
  console.log(`Option hover preview probe passed: ${checks.length}/${checks.length} checks, zero console errors.`);
  for (const [, label] of checks) console.log(`  ok  ${label}`);
} finally {
  await browser.close();
  await server.close();
}
