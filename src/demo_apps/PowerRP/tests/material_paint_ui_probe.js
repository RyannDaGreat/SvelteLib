/**
 * MATERIAL PAINT UI probe: boot the PowerRP editor headless with the demo deck,
 * select a rect, and exercise PaintField's "Mat" mode on BOTH paint slots —
 * the seam every ?cli=1 render probe structurally cannot reach (they never
 * mount the Inspector), which is exactly how a broken PaintField (its stroke
 * imports and `strokeMaterials` prop lost to a mid-fleet git-stash reset while
 * the slot-aware code using them survived) once passed 88 node suites and both
 * material render probes. Asserts, per slot:
 *   - clicking "Mat" on the FILL row stores {type:"material"} with the FILL
 *     registry's default id and renders that entry's fillParams knob rows;
 *   - clicking "Mat" on the STROKE row stores the STROKE registry's default id
 *     (the setMode slot guard: a stroke slot must never store a fill id) and
 *     renders strokeParams rows;
 *   - a knob commit writes a SPARSE param at material.params.<name>;
 *   - each Mat commit is one undo unit; zero console errors throughout.
 * The registries are read NODE-SIDE (materials.js / stroke_materials.js), so
 * the probe grows automatically as materials — e.g. brushes — register.
 *
 * Run from SvelteLib root: node src/demo_apps/PowerRP/tests/material_paint_ui_probe.js
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { createServer } from "vite";
import puppeteer from "puppeteer";
import { fillCapableMaterialIds, getMaterial } from "../render_gpu/skia/materials.js";
import { strokeMaterialIds, getStrokeMaterial } from "../render_gpu/skia/stroke_materials.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(HERE, "../web");
const demoJson = await readFile(resolve(HERE, "../examples/demo.powerrp.json"), "utf8");

const server = await createServer({
  configFile: resolve(webRoot, "vite.config.js"),
  server: { port: 0, open: false, host: "127.0.0.1", hmr: false, watch: null },
});
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/`;

const browser = await puppeteer.launch({ headless: "new", args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox", "--ignore-gpu-blocklist"] });
const errors = [];
const checks = [];
const ok = (cond, label) => { checks.push([!!cond, label]); if (!cond) errors.push(`CHECK FAILED: ${label}`); };

// Known demo-fixture boot noise (the colorfield_probe allowlist, same reasoning:
// stale fixture migrations + the software renderer's absent video adapter are
// not this suite's to own). Anything else at boot, and ANYTHING after, fails.
const IGNORE_BOOT = [/PowerRP repair:/, /was missing font/, /duration.*transition|transition.*duration/i, /no.*adapter|adapters/i];
const isBootNoise = (s) => IGNORE_BOOT.some((re) => re.test(s));

/** The node-side truth the UI must mirror: each slot's registry + default entry. */
const FILL_IDS = fillCapableMaterialIds();
const STROKE_IDS = strokeMaterialIds();
const FILL_DEFAULT = FILL_IDS[0];
const STROKE_DEFAULT = STROKE_IDS[0];
const fillRowCount = (getMaterial(FILL_DEFAULT).fillParams ?? []).length;
const strokeRowCount = (getStrokeMaterial(STROKE_DEFAULT).strokeParams ?? []).length;

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") errors.push(`console.error: ${m.text()}`); });
  await page.evaluateOnNewDocument((json) => localStorage.setItem("powerrp.autosave", json), demoJson);
  await page.goto(url, { waitUntil: "networkidle0" });
  await new Promise((r) => setTimeout(r, 600));
  const realBootErrors = errors.filter((e) => !isBootNoise(e));
  if (realBootErrors.length) { console.error("PAGE ERRORS AT BOOT:\n" + realBootErrors.join("\n")); process.exit(1); }
  errors.length = 0; // from here, ANY console error fails the probe

  const rectId = await page.evaluate(() => {
    const app = window.__powerrp_app;
    app.slideIndex = 0;
    const items = app.doc.slides[0].delta.items;
    const id = Object.keys(items).find((k) => items[k].type === "rect");
    app.selection = id;
    return id;
  });
  ok(rectId, "found a rect item in the demo deck");
  await new Promise((r) => setTimeout(r, 250));

  /** Click the "Mat" mode button inside the Inspector row labelled `rowLabel`. */
  const clickMat = (rowLabel) => page.evaluate((lbl) => {
    const rows = [...document.querySelectorAll(".inspector .row")];
    const row = rows.find((r) => r.querySelector(".label")?.textContent === lbl);
    const btn = row && [...row.querySelectorAll("button")].find((b) => b.textContent.trim() === "Mat");
    if (!btn) return false;
    btn.click();
    return true;
  }, rowLabel);

  /** The Inspector row's rendered material knob rows + the stored doc paint.
   * The paint is JSON.stringify'd IN PAGE and parsed here: the doc is a Svelte 5
   * $state deep proxy, and puppeteer's return-by-value serialization silently
   * mangles it (plain numbers survive; the nested object came back empty). */
  const slotState = async (rowLabel, key) => {
    const r = await page.evaluate((lbl, k, id) => {
      const rows = [...document.querySelectorAll(".inspector .row")];
      const row = rows.find((el) => el.querySelector(".label")?.textContent === lbl);
      return {
        knobRows: row ? row.querySelectorAll(".paint-material-row").length : -1,
        storedJson: JSON.stringify(window.__powerrp_app.doc.slides[0].delta.items[id][k] ?? null),
      };
    }, rowLabel, key, rectId);
    return { knobRows: r.knobRows, stored: JSON.parse(r.storedJson) };
  };

  // ── FILL slot → Mat: fill registry's default id + its fillParams rows ───────
  ok(await clickMat("Fill"), "Fill row shows a Mat mode button; clicked");
  await new Promise((r) => setTimeout(r, 200));
  const fill = await slotState("Fill", "fill");
  ok(fill.stored?.type === "material", `Mat on Fill stores type:"material"; got ${JSON.stringify(fill.stored?.type)}`);
  ok(fill.stored?.material?.id === FILL_DEFAULT, `fill slot stores the FILL registry default "${FILL_DEFAULT}"; got ${JSON.stringify(fill.stored?.material?.id)}`);
  ok(FILL_IDS.includes(fill.stored?.material?.id), "fill slot's id is fill-capable (never a stroke id)");
  ok(fill.knobRows === fillRowCount, `fill row renders "${FILL_DEFAULT}"'s ${fillRowCount} fillParams knob rows; got ${fill.knobRows}`);

  // A knob commit writes a SPARSE param. The first number knob's DraggableNumber
  // commits via onchange; drive the app seam directly (the control's own gesture
  // path is DraggableNumber's suite's to own) with a value inside the knob's range.
  const numKnob = (getMaterial(FILL_DEFAULT).fillParams ?? []).find((r) => r.kind === "number" || r.kind === "angle" || !r.kind);
  if (numKnob) {
    const knobValue = (numKnob.default ?? 0) + ((numKnob.max ?? Infinity) > (numKnob.default ?? 0) ? 0 : -0.1) || 0.1;
    await page.evaluate((id, name, v) => {
      const app = window.__powerrp_app;
      app.setPreview([[["items", id, "fill", "material", "params", name], v]]);
      app.commitPreview();
    }, rectId, numKnob.name, knobValue);
    await new Promise((r) => setTimeout(r, 120));
    const afterKnob = await slotState("Fill", "fill");
    ok(afterKnob.stored?.material?.params?.[numKnob.name] === knobValue,
      `knob "${numKnob.name}" committed SPARSELY at material.params (${knobValue})`);
  }

  // ── STROKE slot → Mat: the slot guard picks the STROKE registry default ─────
  ok(await clickMat("Stroke"), "Stroke row shows a Mat mode button; clicked");
  await new Promise((r) => setTimeout(r, 200));
  const stroke = await slotState("Stroke", "stroke");
  ok(stroke.stored?.type === "material", `Mat on Stroke stores type:"material"; got ${JSON.stringify(stroke.stored?.type)}`);
  ok(stroke.stored?.material?.id === STROKE_DEFAULT, `stroke slot stores the STROKE registry default "${STROKE_DEFAULT}"; got ${JSON.stringify(stroke.stored?.material?.id)}`);
  ok(STROKE_IDS.includes(stroke.stored?.material?.id) && !FILL_IDS.includes(stroke.stored?.material?.id),
    "stroke slot's id is stroke-registry-only (the setMode slot guard held)");
  ok(stroke.knobRows === strokeRowCount, `stroke row renders "${STROKE_DEFAULT}"'s ${strokeRowCount} strokeParams knob rows; got ${stroke.knobRows}`);

  // ── Undo unwinds the Mat commits (each was ONE unit) ────────────────────────
  await page.evaluate(() => { window.__powerrp_app.undo(); window.__powerrp_app.undo(); });
  await new Promise((r) => setTimeout(r, 150));
  const afterUndo = JSON.parse(await page.evaluate((id) => JSON.stringify(window.__powerrp_app.doc.slides[0].delta.items[id].stroke ?? null), rectId));
  ok(afterUndo?.type !== "material", "two undos unwind the stroke Mat commit (one unit each)");

  if (errors.length) {
    console.error("PROBE ERRORS:\n" + errors.join("\n"));
    console.error(`\n${checks.filter(([c]) => c).length}/${checks.length} checks passed`);
    process.exit(1);
  }
  console.log(`Material paint UI probe passed: ${checks.length}/${checks.length} checks, zero console errors.`);
  for (const [, label] of checks) console.log(`  ok  ${label}`);
} finally {
  await browser.close();
  await server.close();
}
