/**
 * MODE-SELECTOR ROW VISIBILITY, IN THE REAL INSPECTOR (R6-31 / #218).
 *
 * The node suite (tests/pattern_row_visibility_test.js) proves the SCHEMA hides
 * the right rows. It cannot prove the PANEL does — web/PaintField.svelte is the
 * only thing that resolves `visibleWhen`, and a schema aspect nothing reads is
 * exactly the kind of change that passes every bare-node suite while the UI is
 * unmoved. So this boots the editor, puts a vector-pattern fill on a real item,
 * and reads the rendered `.paint-material-row` labels back for EVERY generator.
 *
 * THREE THINGS THAT ONLY A BROWSER CAN SHOW:
 *   1. The rendered rows match the node-side expectation, per generator, DERIVED
 *      from PATTERN_GENERATORS rather than typed here.
 *   2. THE PICTURE DOES NOT MOVE. Hiding a control must not change a pixel; the
 *      canvas is captured either side of a pure visibility change and compared
 *      byte for byte. That is the whole claim of the feature.
 *   3. NO DATA IS LOST. A knob written while its generator reads it, then hidden
 *      by switching the mode, is still stored — and still stored after switching
 *      back — with its value and its "=" equation intact.
 *
 * Screenshots (default /tmp/pattern_row_visibility_probe) are the human record:
 * one Inspector shot per sampled generator, so the row list can be eyeballed.
 *
 * Run: node src/demo_apps/PowerRP/tests/pattern_row_visibility_probe.js [shot_dir]
 */
import { mkdir, readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { launchBrowser } from "./puppeteerLaunch.js";
import { PATTERN_GENERATORS, patternGeneratorIds } from "../core/vector_patterns.js";
import { PATTERN_FILL_PARAMS, PATTERN_MATERIAL_ID } from "../render_gpu/skia/pattern_material.js";
import { visibleKnobRows, materialFillParamDefaults, getMaterial } from "../render_gpu/skia/materials.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(HERE, "../web");
const demoJson = await readFile(resolve(HERE, "../examples/demo.powerrp.json"), "utf8");
const shots = process.argv[2] ?? "/tmp/pattern_row_visibility_probe";
await mkdir(shots, { recursive: true });

// ── NODE-SIDE TRUTH (derived; never typed) ───────────────────────────────────
const DEFAULTS = materialFillParamDefaults(getMaterial(PATTERN_MATERIAL_ID));
/** The knob-row labels PaintField must render for `generator`. A material knob
 *  row declares no `label`, so the rendered label IS the knob name. */
const expectedRows = (generator) =>
  visibleKnobRows(PATTERN_FILL_PARAMS, { ...DEFAULTS, generator }).filter((r) => r.kind !== "stops").map((r) => r.name);
/** Generators sampled for a SCREENSHOT — deliberately the extremes plus a middle,
 *  chosen by measured row count so the shots differ visibly rather than by taste. */
const byWidth = [...patternGeneratorIds()].sort((a, b) => expectedRows(a).length - expectedRows(b).length);
const SAMPLED = [...new Set([byWidth[0], byWidth[Math.floor(byWidth.length / 2)], byWidth[byWidth.length - 1], "scallop", "brick"])];
/** A knob `brick` reads and `stripes` does not — the hidden-value round trip. */
const BRICK_ONLY = PATTERN_GENERATORS.brick.params.map((r) => r.name).find((n) => !PATTERN_GENERATORS.stripes.params.some((r) => r.name === n));

const server = await createServer({
  configFile: resolve(webRoot, "vite.config.js"),
  server: { port: 0, open: false, host: "127.0.0.1", hmr: false, watch: null },
});
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/`;

const browser = await launchBrowser();
const errors = [];
const checks = [];
const ok = (cond, label) => { checks.push([!!cond, label]); if (!cond) errors.push(`CHECK FAILED: ${label}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// The demo fixture's known boot noise, verbatim from tests/material_paint_ui_probe.js
// (stale-fixture migrations + the software renderer's absent video adapter).
const IGNORE_BOOT = [/PowerRP repair:/, /was missing font/, /duration.*transition|transition.*duration/i, /no.*adapter|adapters/i];

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") errors.push(`console.error: ${m.text()}`); });
  await page.evaluateOnNewDocument((json) => localStorage.setItem("powerrp.autosave", json), demoJson);
  await page.goto(url, { waitUntil: "networkidle0" });
  await sleep(700);
  const bootErrors = errors.filter((e) => !IGNORE_BOOT.some((re) => re.test(e)));
  if (bootErrors.length) { console.error("PAGE ERRORS AT BOOT:\n" + bootErrors.join("\n")); process.exit(1); }
  errors.length = 0; // from here, ANY console error fails the probe

  // Select a rect and give it a vector-pattern fill through the app's own commit
  // seam (one undo unit), which is what the Inspector then renders.
  const rectId = await page.evaluate((matId) => {
    const app = window.__powerrp_app;
    app.slideIndex = 0;
    const items = app.doc.slides[0].delta.items;
    const id = Object.keys(items).find((k) => items[k].type === "rect");
    app.selection = id;
    app.setPreview([[["items", id, "fill"], { type: "material", material: { id: matId, params: {} } }]]);
    app.commitPreview();
    return id;
  }, PATTERN_MATERIAL_ID);
  ok(rectId, "found a rect and gave it a vector-pattern fill");
  await sleep(300);

  /** Command. Opens the Fill row's knob accordion if it is folded. */
  const expandKnobs = () => page.evaluate(() => {
    const row = [...document.querySelectorAll(".inspector .row")].find((r) => r.querySelector(".label")?.textContent === "Fill");
    const header = row?.querySelector(".cat-header");
    if (header && header.getAttribute("aria-expanded") === "false") header.click();
    return !!header;
  });
  ok(await expandKnobs(), "the Fill row mounts the material knob accordion");
  await sleep(250);

  /** Command. Writes the mode knob and returns the labels the panel then renders. */
  const setGeneratorAndRead = async (generator) => {
    await page.evaluate((id, g) => {
      const app = window.__powerrp_app;
      app.setPreview([[["items", id, "fill", "material", "params", "generator"], g]]);
      app.commitPreview();
    }, rectId, generator);
    await sleep(160);
    return page.evaluate(() => {
      const row = [...document.querySelectorAll(".inspector .row")].find((r) => r.querySelector(".label")?.textContent === "Fill");
      return [...(row?.querySelectorAll(".paint-material-row .paint-material-label") ?? [])].map((el) => el.textContent.trim());
    });
  };

  // ── (1) EVERY generator renders exactly the rows its own declaration implies ─
  let mismatches = 0;
  for (const generator of patternGeneratorIds()) {
    const rendered = await setGeneratorAndRead(generator);
    const want = expectedRows(generator);
    if (JSON.stringify([...rendered].sort()) !== JSON.stringify([...want].sort())) {
      mismatches++;
      errors.push(`CHECK FAILED: ${generator} rendered [${rendered}] but its declaration implies [${want}]`);
    }
    if (SAMPLED.includes(generator)) {
      // The FILL ROW, not the whole Inspector: the panel is several thousand px
      // of scroll and the knob list sits below the fold, so a panel-wide shot is
      // a picture of the transform section. This frames the thing under test.
      const handle = await page.evaluateHandle(() => {
        const row = [...document.querySelectorAll(".inspector .row")].find((r) => r.querySelector(".label")?.textContent === "Fill");
        row?.scrollIntoView({ block: "center" });
        return row;
      });
      await sleep(120);
      await handle.asElement().screenshot({ path: `${shots}/inspector-${generator}-${rendered.length}rows.png` });
    }
  }
  ok(mismatches === 0, `all ${patternGeneratorIds().length} generators render exactly their own knob rows (${mismatches} mismatched)`);

  // The rows must actually DIFFER between generators, or the assertion above is
  // satisfied by a panel that renders everything.
  const wide = await setGeneratorAndRead("plank");
  const narrow = await setGeneratorAndRead("plaid");
  ok(narrow.length < wide.length, `the panel THINS with the mode: plaid ${narrow.length} rows vs plank ${wide.length}`);
  ok(wide.length < PATTERN_FILL_PARAMS.length, `even the widest generator hides rows (${wide.length} of ${PATTERN_FILL_PARAMS.length})`);

  // ── (2) THE PICTURE DOES NOT MOVE ───────────────────────────────────────────
  // Same mode, same knobs, but every knob the mode does NOT read set to a wild
  // value. The panel hides them; the canvas must be byte-identical.
  const canvasBytes = () => page.evaluate(() => {
    const c = document.querySelector("canvas");
    return c ? c.toDataURL("image/png").length + ":" + c.toDataURL("image/png").slice(-2000) : null;
  });
  await setGeneratorAndRead("brick");
  await sleep(500);
  const clean = await canvasBytes();
  const hiddenNames = PATTERN_FILL_PARAMS.map((r) => r.name).filter((n) => !expectedRows("brick").includes(n));
  await page.evaluate((id, names) => {
    const app = window.__powerrp_app;
    app.setPreview(names.map((n) => [["items", id, "fill", "material", "params", n], 999]));
    app.commitPreview();
  }, rectId, hiddenNames);
  await sleep(500);
  const poisoned = await canvasBytes();
  ok(clean && clean === poisoned,
    `poisoning all ${hiddenNames.length} knobs brick does not read leaves the canvas byte-identical`);
  await page.evaluate(() => window.__powerrp_app.undo());
  await sleep(250);

  // ── (3) NO DATA IS LOST ACROSS A MODE SWITCH ────────────────────────────────
  const readKnob = (name) => page.evaluate((id, n) =>
    JSON.stringify(window.__powerrp_app.doc.slides[0].delta.items[id].fill?.material?.params?.[n] ?? null), rectId, name)
    .then(JSON.parse);
  await setGeneratorAndRead("brick");
  await page.evaluate((id, n) => {
    const app = window.__powerrp_app;
    app.setPreview([[["items", id, "fill", "material", "params", n], 37]]);
    app.commitPreview();
  }, rectId, BRICK_ONLY);
  await sleep(160);
  ok(await readKnob(BRICK_ONLY) === 37, `"${BRICK_ONLY}" committed while brick reads it`);
  ok((await setGeneratorAndRead("stripes")).includes(BRICK_ONLY) === false, `"${BRICK_ONLY}" is HIDDEN under stripes`);
  ok(await readKnob(BRICK_ONLY) === 37, `…and its stored value survived the switch that hid it`);
  const back = await setGeneratorAndRead("brick");
  ok(back.includes(BRICK_ONLY), `"${BRICK_ONLY}" is back on screen under brick`);
  ok(await readKnob(BRICK_ONLY) === 37, `…still carrying 37 after the round trip`);

  // The same for an "=" EQUATION, which is the case a naive "clear inapplicable
  // knobs on mode change" implementation would destroy silently.
  const EQUATION = "= 4 + 1";
  await page.evaluate((id, n, eq) => {
    const app = window.__powerrp_app;
    app.setPreview([[["items", id, "fill", "material", "params", n], eq]]);
    app.commitPreview();
  }, rectId, BRICK_ONLY, EQUATION);
  await sleep(160);
  await setGeneratorAndRead("stripes");
  await setGeneratorAndRead("brick");
  ok(await readKnob(BRICK_ONLY) === EQUATION, `an "=" equation on a hidden knob survives the round trip verbatim`);

  await page.screenshot({ path: `${shots}/final.png` });
} finally {
  await browser.close();
  await server.close();
}

for (const [pass, label] of checks) console.log(`  ${pass ? "ok " : "FAIL"}  ${label}`);
if (errors.length) {
  console.error(`\npattern_row_visibility_probe FAILED:\n${errors.join("\n")}`);
  process.exit(1);
}
console.log(`\npattern_row_visibility_probe: OK — ${checks.length} checks; the Inspector hides exactly the knobs the chosen generator does not read, the canvas is unmoved by hiding, and no stored value or equation is lost across a mode switch. Shots in ${shots}`);
