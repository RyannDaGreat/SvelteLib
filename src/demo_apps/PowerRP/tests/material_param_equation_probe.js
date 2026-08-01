/**
 * MATERIAL PARAM EQUATION probe (R6-7) — the user's reproduction, in a real
 * browser: select a widget, put a material on its Fill, type `=time` into a knob,
 * and see it ACCEPTED and EVALUATED.
 *
 * WHY A BROWSER PROBE AND NOT ONLY tests/material_param_equation_test.js: the two
 * failures were STACKED, and only one of them is visible to node. The node suite
 * proves core accepts and evaluates a knob equation. It cannot prove the KNOB ROW
 * offers any way to enter one — and it did not: the row mounted a bare
 * DraggableNumber, which has no `onedit`, no text path and no ƒ, so typing
 * `=time` produced `DraggableNumber: "=time" is not a number` and stored nothing.
 * A fix to core alone would have left the user's exact repro still broken with a
 * green node run, which is precisely the false green this repo keeps paying for.
 *
 * It also pins the two doctrine repairs the same rows carried:
 *   - ZERO native <input type="checkbox"> in the Inspector. A boolean knob used to
 *     be one, against BooleanField's own "deliberately no native checkbox anywhere
 *     in the editor" — which tests/boolean_uniformity_probe.js asserts as fact, so
 *     that probe was asserting something false.
 *   - a per-knob ‹ ◆ › triad, on the knob's own state path.
 *
 * The knob schema is read NODE-SIDE from the material registry, so the probe grows
 * with the material rather than transcribing its knobs (the hand-maintained-mirror
 * defect, R6-24.7).
 *
 * Run from SvelteLib root: node src/demo_apps/PowerRP/tests/material_param_equation_probe.js
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { launchBrowser } from "./puppeteerLaunch.js";
import { fillCapableMaterialIds, getMaterial } from "../render_gpu/skia/materials.js";
import { EDITOR_FREEZE_TIME } from "../core/particles.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(HERE, "../web");
const shotDir = resolve(HERE, "../.frenzy/round6/W2-D-shots");
const demoJson = await readFile(resolve(HERE, "../examples/demo.powerrp.json"), "utf8");

// THE MATERIAL FROM THE MANIFEST'S OWN REPRO ("material -> atmosphere, type
// `=time`, refused") — and the widest single schema for the purpose: number,
// angle and colour knobs in one list.
const MATERIAL_ID = "atmosphere";
const SCHEMA = (getMaterial(MATERIAL_ID).fillParams ?? []).filter((r) => !r.hidden && r.kind !== "stops");
const NUMBER_KNOB = SCHEMA.find((r) => r.kind === "number");
const ANGLE_KNOB = SCHEMA.find((r) => r.kind === "angle");
const COLOR_KNOB = SCHEMA.find((r) => r.kind === "color");
const knobLabel = (r) => r.label ?? r.name;

// The BOOLEAN knob has to come from somewhere else — the repro material declares
// none. Discovered from the registry (first fill material with a visible boolean
// knob) rather than named here, so it survives a schema change.
const BOOL_MATERIAL_ID = fillCapableMaterialIds()
  .find((id) => (getMaterial(id).fillParams ?? []).some((r) => r.kind === "boolean" && !r.hidden));
const BOOL_KNOB = (getMaterial(BOOL_MATERIAL_ID).fillParams ?? []).find((r) => r.kind === "boolean" && !r.hidden);

// The equation under test and what it must settle to. `time` reads the ONE
// presentation clock, which is PAUSED in the editor — so the settled value is the
// freeze constant, imported rather than transcribed.
const EQUATION = "=time";
const EXPECTED = EDITOR_FREEZE_TIME;

const server = await createServer({
  configFile: resolve(webRoot, "vite.config.js"),
  server: { port: 0, open: false, host: "127.0.0.1", hmr: false, watch: null },
});
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/`;

const browser = await launchBrowser();
// The page's OWN errors, kept apart from this probe's failed checks: folding the
// two together makes the final "zero console errors" assertion report every
// earlier failure a second time, which reads as a page error that never happened.
const errors = [];
const checks = [];
const ok = (cond, label) => checks.push([!!cond, label]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Command. Scrolls the knob rows into view, so a screenshot artifact shows the
 *  thing under test rather than the top of the panel. */
const showKnobs = (page) => page.evaluate(() => {
  const rows = [...document.querySelectorAll(".inspector .row")];
  const fill = rows.find((el) => el.querySelector(".label")?.textContent === "Fill");
  fill?.scrollIntoView({ block: "center" });
});

/** Command. Settles the open equation input by BLURRING it — the field's own
 *  commit path (NumericField onEqBlur → commitText). Deliberately NOT Enter: with
 *  the autocomplete list open, Enter ACCEPTS THE HIGHLIGHTED CANDIDATE and does
 *  not commit (NumericField's documented rule, "Tab/Enter accept the highlighted
 *  suggestion IF the dropdown is open"), so an Enter-only probe measures the
 *  suggestion layer and reports the field as broken. Blur is unconditional. */
const blurActive = (page) => page.evaluate(() => document.activeElement?.blur());

// Known demo-fixture boot noise (the material_paint_ui_probe allowlist, verbatim
// and for its reasons): stale fixture migrations + the software renderer's absent
// video adapter are not this suite's to own. Anything else at boot, and ANYTHING
// after boot, fails.
const IGNORE_BOOT = [/PowerRP repair:/, /was missing font/, /duration.*transition|transition.*duration/i, /no.*adapter|adapters/i];
const isBootNoise = (s) => IGNORE_BOOT.some((re) => re.test(s));

await mkdir(shotDir, { recursive: true });

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") errors.push(`console.error: ${m.text()}`); });
  await page.evaluateOnNewDocument((json) => localStorage.setItem("powerrp.autosave", json), demoJson);
  await page.goto(url, { waitUntil: "networkidle0" });
  await sleep(600);
  const realBootErrors = errors.filter((e) => !isBootNoise(e));
  if (realBootErrors.length) { console.error("PAGE ERRORS AT BOOT:\n" + realBootErrors.join("\n")); process.exit(1); }
  errors.length = 0; // from here, ANY console error fails the probe

  // Select a rect and put the material on its FILL. The mode strip + dropdown are
  // material_paint_ui_probe's to exercise; this probe is about the KNOB ROWS, so
  // the fixture is set through the app's own commit seam (one undo unit).
  const rectId = await page.evaluate((materialId) => {
    const app = window.__powerrp_app;
    app.slideIndex = 0;
    const items = app.doc.slides[0].delta.items;
    const id = Object.keys(items).find((k) => items[k].type === "rect");
    app.selection = id;
    app.setPreview([[["items", id, "fill"], { type: "material", material: { id: materialId, params: {} } }]]);
    app.commitPreview();
    return id;
  }, MATERIAL_ID);
  ok(rectId, "found a rect in the demo deck and put the material on its Fill");
  await sleep(300);

  /** The Fill row's knob sub-rows, keyed by their visible label. */
  const knobRow = (label) => page.evaluate((lbl) => {
    const rows = [...document.querySelectorAll(".inspector .row")];
    const fill = rows.find((el) => el.querySelector(".label")?.textContent === "Fill");
    const row = fill && [...fill.querySelectorAll(".paint-material-row")]
      .find((r) => r.querySelector(".paint-material-label")?.textContent?.trim() === lbl);
    if (!row) return null;
    return {
      hasNumField: !!row.querySelector(".numfield"),
      hasBoolField: !!row.querySelector(".boolfield"),
      hasColorField: !!row.querySelector(".colorfield"),
      hasAngleDial: !!row.querySelector(".angle-dial"),
      hasEqOpen: !!row.querySelector(".numfield .eq-open"),
      keyButtons: row.querySelectorAll(".kf-controls .keybtn, .kf-controls .jumpbtn").length,
    };
  }, label);

  /** Raw stored + settled value at a knob's state path (stringified IN PAGE: the
   *  doc is a Svelte 5 $state deep proxy, and returning it by value mangles it —
   *  the PROBE-AUTHOR TRAP the sibling probes record). */
  const knobValue = (name) => page.evaluate((id, n) => {
    const app = window.__powerrp_app;
    return JSON.parse(JSON.stringify({
      stored: app.rawState().items[id].fill?.material?.params?.[n] ?? null,
      settled: app.state().items[id].fill?.material?.params?.[n] ?? null,
    }));
  }, rectId, name);

  // ── (1) THE KNOB ROWS MOUNT THE APP'S STANDARD CONTROLS ──────────────────────
  const numRow = await knobRow(knobLabel(NUMBER_KNOB));
  ok(numRow?.hasNumField, `a NUMBER knob ("${knobLabel(NUMBER_KNOB)}") mounts NumericField, not a bare scrubber`);
  ok(numRow?.hasEqOpen, "…and therefore carries the ƒ equation affordance every other numeric row has");
  const angRow = await knobRow(knobLabel(ANGLE_KNOB));
  ok(angRow?.hasAngleDial, `an ANGLE knob ("${knobLabel(ANGLE_KNOB)}") mounts the rotary dial`);
  const colRow = await knobRow(knobLabel(COLOR_KNOB));
  ok(colRow?.hasColorField, `a COLOUR knob ("${knobLabel(COLOR_KNOB)}") still mounts ColorField`);

  // A SPARSE knob shows its SCHEMA DEFAULT, not 0 — the regression the `value`
  // fallback exists to prevent (params are stored sparse: "no state until written").
  const shownDefault = await page.evaluate((lbl) => {
    const rows = [...document.querySelectorAll(".inspector .row")];
    const fill = rows.find((el) => el.querySelector(".label")?.textContent === "Fill");
    const row = [...fill.querySelectorAll(".paint-material-row")]
      .find((r) => r.querySelector(".paint-material-label")?.textContent?.trim() === lbl);
    return row.querySelector(".numfield .dn")?.textContent?.trim() ?? null;
  }, knobLabel(NUMBER_KNOB));
  ok(shownDefault?.includes(String(NUMBER_KNOB.default)),
    `an UNWRITTEN knob still reads its schema default ${NUMBER_KNOB.default}; got ${JSON.stringify(shownDefault)}`);

  // ── (2) ZERO NATIVE CHECKBOXES (the doctrine the boolean knob broke) ─────────
  // On a material that actually HAS a boolean knob — the manifest's repro material
  // has none, so checking only that one would be a check that cannot fail
  // (R6-24.4), which is how this class of defect survives. The material is chosen
  // from the registry, so it follows the schema rather than transcribing it.
  await page.evaluate((id, materialId) => {
    const app = window.__powerrp_app;
    app.setPreview([[["items", id, "fill", "material", "id"], materialId]]);
    app.commitPreview();
  }, rectId, BOOL_MATERIAL_ID);
  await sleep(300);
  const boolRow = await knobRow(knobLabel(BOOL_KNOB));
  ok(boolRow?.hasBoolField, `a BOOLEAN knob ("${knobLabel(BOOL_KNOB)}" on ${BOOL_MATERIAL_ID}) mounts THE on/off toggle`);
  const nativeCheckboxes = await page.evaluate(() => document.querySelectorAll('.inspector input[type="checkbox"]').length);
  ok(nativeCheckboxes === 0, `ZERO native <input type=checkbox> in the Inspector; got ${nativeCheckboxes}`);
  await showKnobs(page);
  await page.screenshot({ path: resolve(shotDir, "01b-boolean-knob.png") });
  // Back to the repro material for the rest.
  await page.evaluate((id, materialId) => {
    const app = window.__powerrp_app;
    app.setPreview([[["items", id, "fill", "material", "id"], materialId]]);
    app.commitPreview();
  }, rectId, MATERIAL_ID);
  await sleep(300);

  // ── (3) THE PER-KNOB ‹ ◆ › ──────────────────────────────────────────────────
  ok(numRow?.keyButtons === 3, `each knob row carries the ‹ ◆ › triad; got ${numRow?.keyButtons}`);

  await showKnobs(page);
  await page.screenshot({ path: resolve(shotDir, "01-knob-rows.png") });

  // ── (4) THE REPRODUCTION: type the equation into the knob ───────────────────
  // Through the REAL affordance: click ƒ, type, Enter. Nothing is written by the
  // probe — if the field refuses the text, the stored value stays null and the
  // assertions below say so.
  await page.evaluate((lbl) => {
    const rows = [...document.querySelectorAll(".inspector .row")];
    const fill = rows.find((el) => el.querySelector(".label")?.textContent === "Fill");
    const row = [...fill.querySelectorAll(".paint-material-row")]
      .find((r) => r.querySelector(".paint-material-label")?.textContent?.trim() === lbl);
    row.querySelector(".numfield .eq-open").click();
  }, knobLabel(NUMBER_KNOB));
  await sleep(200);
  const openedInput = await page.evaluate((lbl) => {
    const rows = [...document.querySelectorAll(".inspector .row")];
    const fill = rows.find((el) => el.querySelector(".label")?.textContent === "Fill");
    const row = [...fill.querySelectorAll(".paint-material-row")]
      .find((r) => r.querySelector(".paint-material-label")?.textContent?.trim() === lbl);
    const input = row.querySelector(".numfield .eq-input");
    if (input) input.select();
    return !!input;
  }, knobLabel(NUMBER_KNOB));
  ok(openedInput, "the ƒ button opened the equation text entry ON the knob row");

  await page.keyboard.type(EQUATION);
  await sleep(150);
  await showKnobs(page);
  await page.screenshot({ path: resolve(shotDir, "02-typing-equation.png") });
  await blurActive(page);
  await sleep(250);

  const after = await knobValue(NUMBER_KNOB.name);
  ok(typeof after.stored === "string" && after.stored.length > 0,
    `the knob ACCEPTED the equation and stored it as text; got ${JSON.stringify(after.stored)}`);
  ok(after.settled === EXPECTED,
    `…and it EVALUATED to the presentation clock (${EXPECTED}); got ${JSON.stringify(after.settled)}`);
  ok(!errors.some((e) => /is not a number/.test(e)),
    `no "is not a number" rejection was logged; got ${JSON.stringify(errors.filter((e) => /is not a number/.test(e)))}`);
  await showKnobs(page);
  await page.screenshot({ path: resolve(shotDir, "03-equation-evaluated.png") });

  // ONE UNDO UNIT — the field's commit contract, not a hand-rolled write.
  await page.evaluate(() => window.__powerrp_app.undo());
  await sleep(200);
  const undone = await knobValue(NUMBER_KNOB.name);
  ok(undone.stored === null, `the equation commit was ONE undo unit; got ${JSON.stringify(undone.stored)}`);

  // ── (5) NO REGRESSION: a plain number still commits as a plain number ────────
  const literal = (NUMBER_KNOB.min ?? 0) + ((NUMBER_KNOB.max ?? 1) - (NUMBER_KNOB.min ?? 0)) / 3;
  await page.evaluate((lbl) => {
    const rows = [...document.querySelectorAll(".inspector .row")];
    const fill = rows.find((el) => el.querySelector(".label")?.textContent === "Fill");
    const row = [...fill.querySelectorAll(".paint-material-row")]
      .find((r) => r.querySelector(".paint-material-label")?.textContent?.trim() === lbl);
    row.querySelector(".numfield .eq-open").click();
  }, knobLabel(NUMBER_KNOB));
  await sleep(200);
  await page.evaluate((lbl) => {
    const rows = [...document.querySelectorAll(".inspector .row")];
    const fill = rows.find((el) => el.querySelector(".label")?.textContent === "Fill");
    const row = [...fill.querySelectorAll(".paint-material-row")]
      .find((r) => r.querySelector(".paint-material-label")?.textContent?.trim() === lbl);
    row.querySelector(".numfield .eq-input").select();
  }, knobLabel(NUMBER_KNOB));
  await page.keyboard.type(String(literal));
  await blurActive(page);
  await sleep(250);
  const asNumber = await knobValue(NUMBER_KNOB.name);
  ok(typeof asNumber.stored === "number", `a plain number still commits as a NUMBER, not a string; got ${JSON.stringify(asNumber.stored)}`);
  ok(Math.abs(asNumber.stored - literal) < 1e-3, `…with the typed value (${literal}); got ${asNumber.stored}`);

  // ── (6) THE ◆ ACTS ON THE KNOB'S OWN STATE PATH ─────────────────────────────
  // A commit IS a keyframe on the current slide (app.commitPreview → keyframed),
  // so the knob written just above is ALREADY keyed and the diamond must read
  // FILLED. The test of the triad is therefore that clicking it REMOVES that
  // keyframe and clicking again re-inserts it — on the knob's own deep path, which
  // is the thing that was missing.
  const knobKeyed = () => page.evaluate((id, n) => window.__powerrp_app.hasKeyPath(["items", id, "fill", "material", "params", n]), rectId, NUMBER_KNOB.name);
  const diamondFilled = () => page.evaluate((lbl) => {
    const rows = [...document.querySelectorAll(".inspector .row")];
    const fill = rows.find((el) => el.querySelector(".label")?.textContent === "Fill");
    const row = [...fill.querySelectorAll(".paint-material-row")]
      .find((r) => r.querySelector(".paint-material-label")?.textContent?.trim() === lbl);
    return row.querySelector(".kf-controls .keybtn").classList.contains("keyed");
  }, knobLabel(NUMBER_KNOB));
  const clickDiamond = () => page.evaluate((lbl) => {
    const rows = [...document.querySelectorAll(".inspector .row")];
    const fill = rows.find((el) => el.querySelector(".label")?.textContent === "Fill");
    const row = [...fill.querySelectorAll(".paint-material-row")]
      .find((r) => r.querySelector(".paint-material-label")?.textContent?.trim() === lbl);
    row.querySelector(".kf-controls .keybtn").click();
  }, knobLabel(NUMBER_KNOB));

  ok(await knobKeyed(), "committing the knob keyed its own deep state path on this slide");
  ok(await diamondFilled(), "…and the row's ◆ reads FILLED, so the triad is bound to that path");
  await showKnobs(page);
  await page.screenshot({ path: resolve(shotDir, "04-knob-keyframed.png") });
  await clickDiamond();
  await sleep(200);
  ok(!(await knobKeyed()), "clicking the FILLED ◆ removed the knob's keyframe");
  await clickDiamond();
  await sleep(200);
  ok(await knobKeyed(), "clicking the HOLLOW ◆ inserted it again");

  ok(errors.length === 0, `zero console errors throughout; got:\n${errors.join("\n")}`);
} catch (e) {
  // A THROWN step is a failed CHECK, not a stack trace with the earlier results
  // thrown away: the checks already collected are the diagnosis of where it broke.
  ok(false, `the probe threw before finishing: ${e.message}`);
} finally {
  await browser.close();
  await server.close();
}

const failed = checks.filter(([pass]) => !pass);
for (const [pass, label] of checks) console.log(`  ${pass ? "ok " : "FAIL"}  ${label}`);
await writeFile(resolve(shotDir, "checks.txt"), checks.map(([p, l]) => `${p ? "ok" : "FAIL"}\t${l}`).join("\n"));
console.log(`\n${checks.length - failed.length}/${checks.length} material-param equation UI checks passed (shots in ${shotDir})`);
if (failed.length) process.exit(1);
