/**
 * PER-ITEM VARIABLES probe (manifest item 67). Boots the REAL editor and drives
 * the REAL Inspector UI end to end:
 *   1. select a widget → its Inspector "Variables" section is present,
 *   2. ADD a per-item var through the real add-row input (+Enter, one undo unit),
 *   3. BIND a property to "self.vars.<name>" through the real equation field,
 *   4. change the var through the real field and watch the bound property FOLLOW
 *      live (the whole point: a per-object knob that morphs just this widget),
 *   5. KEYFRAME the var across two slides and verify the tween at alpha 0.5
 *      THROUGH THE APP SEAM (cameraFrame.evaluatedStateAt = the one every pixel
 *      consumer uses), on the app's OWN real document,
 *   6. undo is ONE unit per commit at each step.
 *
 * Per the Mac-baseline memory note, app state is read as JSON.stringify(...) in
 * the page and parsed node-side — never returned raw (Svelte-5 proxy drift).
 *
 * Run from SvelteLib root or PowerRP dir: node tests/item_vars_probe.js
 */
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { launchBrowser } from "./puppeteerLaunch.js";
import { createRegistry } from "../core/registry.js";
import { createCommands } from "../core/commands.js";
import { registerAll } from "../plugins/index.js";
import { evaluatedStateAt } from "../web/cameraFrame.js";

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

// The node-side registry that recomputes the app seam on the real extracted doc.
const registry = createRegistry();
registerAll(registry, createCommands());
const parse = async (page) => JSON.parse(await page.evaluate(() => JSON.stringify(window.__powerrp_app.doc)));
// A stringified read of a single JSON-able value out of the running app.
const appJson = (page, fn) => page.evaluate((src) => JSON.stringify((0, eval)(src)(window.__powerrp_app)), fn.toString());
const appVal = async (page, fn) => JSON.parse(await appJson(page, fn));
// The ƒ equation opener is HOVER-ONLY (hidden at rest in app.css), so puppeteer's
// geometric click can't hit it — fire the handler directly. Inputs are focused +
// selected the same way so a subsequent keyboard.type replaces any pre-fill.
const jsClick = (page, handle) => page.evaluate((el) => el.click(), handle);
const jsFocusSelect = (page, handle) => page.evaluate((el) => { el.focus(); el.select?.(); }, handle);

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

  // ── Select a purgeable widget; the Inspector's Variables section appears ─────
  const itemId = await appVal(page, (app) => {
    const items = Object.entries(app.rawState().items ?? {});
    const pick = items.find(([, s]) => s.type === "rect") // a rect has plain numeric x/y/w/h rows
      ?? items.find(([, s]) => app.registry.get(s.type)?.capabilities?.purgeable !== false);
    if (pick) { app.selection = pick[0]; return pick[0]; }
    return null;
  });
  ok(itemId != null, `a purgeable widget exists to author on (selected ${JSON.stringify(itemId)})`);
  await sleep(200);
  // Expand every category accordion so numeric property rows are in the DOM.
  await page.evaluate(() => {
    for (const h of document.querySelectorAll(".inspector .cat-header[aria-expanded='false']")) h.click();
  });
  await sleep(150);
  // Ensure the Variables accordion is expanded (default; force-open if a stored
  // collapse hid it).
  await page.evaluate(() => {
    const hdr = [...document.querySelectorAll(".inspector .cat-header")].find((b) => b.textContent.includes("Variables"));
    if (hdr && hdr.getAttribute("aria-expanded") === "false") hdr.click();
  });
  await sleep(120);
  const hasSection = await page.evaluate(() =>
    !!document.querySelector(".inspector .varspanel") &&
    [...document.querySelectorAll(".inspector .cat-title")].some((s) => s.textContent.trim() === "Variables"));
  ok(hasSection, "the selected widget's Inspector shows a per-item Variables section");

  // ── ADD a per-item var "lambda" through the real add-row input (+Enter) ──────
  await page.evaluate(() => { document.querySelector(".inspector .varspanel .add-row input").value = ""; });
  await page.type(".inspector .varspanel .add-row input", "lambda");
  await page.keyboard.press("Enter");
  await sleep(200);
  ok((await appVal(page, (app) => app.rawState().items[app.selection].vars ?? null))?.lambda === 0,
    "Enter on the add-row commits a per-item var 'lambda' keyframed 0 on this slide");
  const varRows = await page.evaluate(() => document.querySelectorAll(".inspector .varspanel .row:not(.add-row)").length);
  ok(varRows === 1, `the var renders as a row in the section (got ${varRows})`);
  // one undo unit
  await page.evaluate(() => window.__powerrp_app.undo());
  await sleep(150);
  const afterUndo = await appVal(page, (app) => app.rawState().items[app.selection].vars ?? {});
  ok(!("lambda" in afterUndo), "undo removes the var in ONE unit");
  await page.evaluate(() => window.__powerrp_app.redo());
  await sleep(150);

  // ── BIND a property to "self.vars.lambda" through the real equation field ────
  // Take the FIRST property row's ƒ equation opener that is NOT inside the vars
  // section, type the binding, Enter commits.
  // A NUMERIC property field: a `.numfield` that contains a DraggableNumber
  // scrubber (`.dn`) — which the Visible boolean row and select rows do NOT have,
  // so this skips their ƒ escapes — and is not a var field (outside .varspanel).
  // Hold the `.numfield` CONTAINER (stable across the re-render): clicking its ƒ
  // swaps the scrubber+button subtree for the eq-input, detaching the button.
  const numfield = await page.evaluateHandle(() =>
    [...document.querySelectorAll(".inspector .numfield")].find((f) => f.querySelector(".dn") && !f.closest(".varspanel")) ?? null);
  ok(await page.evaluate((nf) => !!nf, numfield), "the widget exposes a numeric property with an equation field to bind");
  await page.evaluate((nf) => nf.querySelector("button.eq-open").click(), numfield);
  await sleep(150);
  const propInput = await page.evaluateHandle((nf) => nf.querySelector(".eq-input"), numfield);
  // Enter the equation ATOMICALLY (one input event) so no half-typed reference
  // ("self.vars.l") is ever previewed — a live preview of an unresolved ref
  // reports loudly, which is correct app behavior but would trip the zero-error
  // gate. A user pasting the expression takes exactly this path.
  await page.evaluate((el, val) => { el.focus(); el.value = val; el.dispatchEvent(new Event("input", { bubbles: true })); }, propInput, "self.vars.lambda");
  await page.keyboard.press("Enter");
  await sleep(200);
  const bound = await appVal(page, (app) => {
    const it = app.rawState().items[app.selection];
    for (const [k, v] of Object.entries(it)) if (v === "self.vars.lambda") return { key: k, evaluated: app.state().items[app.selection][k] };
    return null;
  });
  ok(bound != null, `a property is now bound to "self.vars.lambda" (${JSON.stringify(bound?.key)})`);
  ok(bound?.evaluated === 0, `the bound property evaluates to the var's value (lambda=0 → ${JSON.stringify(bound?.evaluated)})`);

  // ── CHANGE the var through the real field → the property FOLLOWS live ────────
  const varOpen = await page.evaluateHandle(() => document.querySelector(".inspector .varspanel button.eq-open"));
  await jsClick(page, varOpen);
  await sleep(150);
  const varInput = await page.evaluateHandle(() => document.querySelector(".inspector .varspanel .eq-input"));
  await jsFocusSelect(page, varInput);
  await page.keyboard.type("0.5");
  await page.keyboard.press("Enter");
  await sleep(200);
  // The bound property's live evaluated value, read straight from the running app.
  const following = await appVal(page, (app) => {
    const it = app.rawState().items[app.selection];
    for (const [k, v] of Object.entries(it)) if (v === "self.vars.lambda") return app.state().items[app.selection][k];
    return null;
  });
  ok((await appVal(page, (app) => app.rawState().items[app.selection].vars.lambda)) === 0.5,
    "setting the var to 0.5 through the real field commits it");
  ok(following === 0.5, `the bound property FOLLOWS the var live (0.5 → ${JSON.stringify(following)}) — a per-object morph knob`);
  // one undo unit for the value edit
  await page.evaluate(() => window.__powerrp_app.undo());
  await sleep(150);
  ok((await appVal(page, (app) => app.rawState().items[app.selection].vars.lambda)) === 0,
    "undo reverts the var value edit in ONE unit");
  await page.evaluate(() => window.__powerrp_app.redo());
  await sleep(150);

  // ── KEYFRAME across two slides; verify the tween at alpha 0.5 (app seam) ─────
  // Slide 0 already keys lambda=0.5. addSlide() inserts AFTER the current slide
  // (new index 1) AND navigates there — do NOT override slideIndex (the demo deck
  // has more slides; length-1 would land on the wrong one). Then set lambda=1.0.
  const newSlideIdx = await appVal(page, (app) => { app.addSlide(); return app.slideIndex; });
  ok(newSlideIdx === 1, `addSlide inserts and navigates to the new slide right after slide 0 (index ${newSlideIdx})`);
  await sleep(200);
  const varOpen2 = await page.evaluateHandle(() => document.querySelector(".inspector .varspanel button.eq-open"));
  await jsClick(page, varOpen2);
  await sleep(150);
  const varInput2 = await page.evaluateHandle(() => document.querySelector(".inspector .varspanel .eq-input"));
  await jsFocusSelect(page, varInput2);
  await page.keyboard.type("1");
  await page.keyboard.press("Enter");
  await sleep(200);

  const doc = await parse(page);
  const boundKey = (() => {
    // The item's bound property key, from the real doc's slide-0 fold-visible delta.
    const s0 = doc.slides[0].delta.items?.[itemId] ?? {};
    for (const [k, v] of Object.entries(s0)) if (v === "self.vars.lambda") return k;
    return null;
  })();
  ok(boundKey != null, `the extracted doc records the binding (${JSON.stringify(boundKey)})`);
  const at = (alpha) => evaluatedStateAt(doc, 1, alpha, registry).items[itemId][boundKey];
  ok(Math.abs(at(1) - 1) < 1e-9, `at alpha 1 the bound property is the slide-1 value 1.0 (got ${at(1)})`);
  ok(Math.abs(at(0) - 0.5) < 1e-9, `at alpha 0 it is the slide-0 value 0.5 (got ${at(0)})`);
  ok(Math.abs(at(0.5) - 0.75) < 1e-9, `THE TWEEN: at alpha 0.5 the per-item var lerps 0.5→1.0 and the bound property is 0.75 (got ${at(0.5)})`);

  if (errors.length) {
    console.error("PROBE ERRORS:\n" + errors.join("\n"));
    process.exit(1);
  }
  console.log(`Item-vars probe passed: ${checks.length}/${checks.length} checks, zero console errors.`);
  for (const [, label] of checks) console.log(`  ok  ${label}`);
} finally {
  await browser.close();
  await server.close();
}
