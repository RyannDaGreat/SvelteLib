/**
 * MATERIAL PRESET SURFACING probe (browser): proves manifest D.10–11 — the Tools
 * pane derives its preset offerings from the SELECTED item's CURRENT materials, not
 * from the widget TYPE. So a plain rect whose FILL carries the sky material shows the
 * sky's presets, titled specifically for that material ("Sky material presets"), and a
 * solid-fill rect shows no material preset section at all.
 *
 * The seam is driven directly (app.setPreview/commitPreview — the same whole-paint
 * write PaintField.commitWhole uses), because the point under test is the pane's
 * derivation from paint state, not the picker gesture (material_paint_ui_probe owns
 * that). Asserts, in order:
 *   - a solid-fill rect shows NO "* material presets" / "* stroke presets" section;
 *   - a sky-fill rect shows a section TITLED "Sky material presets" listing exactly
 *     the MERGED sky roster (widget presets first, curated extras after — #52), in order;
 *   - clicking a preset writes its params SPARSELY at fill.material.params.<knob>
 *     (JSON.stringify IN page — the doc is a Svelte 5 deep proxy) as ONE undo unit;
 *   - a brush-STROKE rect shows a "Brush stroke presets" section (the stroke slot +
 *     the D.11 slot-specific title);
 * with zero console errors after boot.
 *
 * Run from SvelteLib root: node src/demo_apps/PowerRP/tests/material_presets_probe.js
 */
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { launchBrowser } from "./puppeteerLaunch.js";
import { presetsForMaterial } from "../render_gpu/skia/material_presets.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(HERE, "../web");
const demoJson = await readFile(resolve(HERE, "../examples/demo.powerrp.json"), "utf8");

// The UI list is the MERGED roster (Round 4 #52: the demo widget's presets come
// FIRST, curated extras after) — build the same merge here in node with a real
// registry, so the pin follows the contract instead of a frozen count.
const { registerAll } = await import("../plugins/index.js");
const { createRegistry } = await import("../core/registry.js");
const { createCommands } = await import("../core/commands.js");
const probeRegistry = createRegistry();
registerAll(probeRegistry, createCommands());
const SKY_PRESETS = presetsForMaterial("sky", probeRegistry);
const SKY_TITLE = "Sky material presets";
const BRUSH_TITLE = "Brush stroke presets";

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
const settle = () => new Promise((r) => setTimeout(r, 160));

// Same boot-noise allowlist as the sibling material probe (stale-fixture migrations
// + the software renderer's absent video adapter are not this suite's to own).
const IGNORE_BOOT = [/PowerRP repair:/, /was missing font/, /duration.*transition|transition.*duration/i, /no.*adapter|adapters/i];
const isBootNoise = (s) => IGNORE_BOOT.some((re) => re.test(s));

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") errors.push(`console.error: ${m.text()}`); });
  await page.evaluateOnNewDocument((json) => localStorage.setItem("powerrp.autosave", json), demoJson);
  await page.evaluateOnNewDocument(() => localStorage.removeItem("powerrp.toolsCollapsed"));
  await page.goto(url, { waitUntil: "networkidle0" });
  await settle();
  const realBootErrors = errors.filter((e) => !isBootNoise(e));
  if (realBootErrors.length) { console.error("PAGE ERRORS AT BOOT:\n" + realBootErrors.join("\n")); process.exit(1); }
  errors.length = 0; // from here, ANY console error fails the probe

  // Select a rect on the opening slide (material_paint_ui_probe's approach).
  const rectId = await page.evaluate(() => {
    const app = window.__powerrp_app;
    app.slideIndex = 0;
    const items = app.doc.slides[0].delta.items;
    const id = Object.keys(items).find((k) => items[k].type === "rect");
    app.selection = id;
    return id;
  });
  ok(rectId, "found a rect item in the demo deck");
  await settle();

  /** Command. Writes the whole paint object at ["items", rect, slot] the way
   *  PaintField.commitWhole does (setPreview → commitPreview). */
  const setPaint = (slot, paint) => page.evaluate((id, s, p) => {
    const app = window.__powerrp_app;
    app.setPreview([[["items", id, s], p]]);
    app.commitPreview();
  }, rectId, slot, paint);

  /** Query. The pane's preset-section titles + each section's row labels. */
  const sections = () => page.evaluate(() => {
    const pane = document.querySelector(".toolspane");
    if (!pane) return [];
    return [...pane.querySelectorAll(".prop-category")].map((g) => ({
      title: g.querySelector(".cat-title")?.textContent?.trim(),
      presets: [...g.querySelectorAll(".cat-rows .tool-preset")].map((b) => b.textContent.trim()),
    }));
  });

  // ── (1) a solid-fill rect shows NO material/stroke preset section ───────────
  await setPaint("fill", { type: "solid", solid: "#3388ff" });
  await settle();
  const solid = await sections();
  ok(!solid.some((s) => /material presets|stroke presets/i.test(s.title ?? "")),
    `solid-fill rect shows no material preset section (saw: ${solid.map((s) => s.title).join(", ")})`);

  // ── (2) a SKY-fill rect shows the sky section, titled specifically ──────────
  await setPaint("fill", { type: "material", material: { id: "sky", params: {} } });
  await settle();
  const skyState = await sections();
  const skySection = skyState.find((s) => s.title === SKY_TITLE);
  ok(skySection, `sky-fill rect shows a section titled "${SKY_TITLE}" (saw: ${skyState.map((s) => s.title).join(", ")})`);
  ok(skySection && skySection.presets.length === SKY_PRESETS.length,
    `"${SKY_TITLE}" lists all ${SKY_PRESETS.length} sky presets (got ${skySection?.presets.length})`);
  ok(skySection && skySection.presets.join("|") === SKY_PRESETS.map((p) => p.title).join("|"),
    `sky preset rows are the library, in order (got ${skySection?.presets.join(", ")})`);
  // The title is SPECIFIC, never generic (D.11).
  ok(!skyState.some((s) => /^fill material presets$/i.test(s.title ?? "")), "no generic 'fill material presets' title");

  // ── (3) clicking a preset writes sparse params at fill.material.params, ONE undo unit ──
  const target = SKY_PRESETS[0]; // "Starfield"
  const paramsJson = () => page.evaluate((id) => JSON.stringify(window.__powerrp_app.doc.slides[0].delta.items[id].fill?.material?.params ?? null), rectId);
  const docBytes = () => page.evaluate(() => JSON.stringify(window.__powerrp_app.doc));
  const before = await docBytes();
  const clicked = await page.evaluate((label) => {
    const pane = document.querySelector(".toolspane");
    const btn = [...pane.querySelectorAll(".cat-rows .tool-preset")].find((b) => b.textContent.trim() === label);
    if (!btn) return false;
    btn.click();
    return true;
  }, target.title);
  ok(clicked, `clicked the "${target.title}" preset row`);
  await settle();
  const applied = JSON.parse(await paramsJson());
  const knob = Object.keys(target.params)[0]; // starDensity
  ok(applied && applied[knob] === target.params[knob],
    `preset param "${knob}" committed at fill.material.params (${target.params[knob]}; got ${applied?.[knob]})`);
  ok(Object.entries(target.params).every(([k, v]) => applied?.[k] === v), "every preset knob landed in the doc");
  const afterClick = await docBytes();
  ok(afterClick !== before, "clicking changed the document");
  await page.evaluate(() => window.__powerrp_app.undo());
  await settle();
  ok((await docBytes()) === before, "one undo fully reverts the preset (exactly one undo unit)");

  // ── (4) a BRUSH stroke shows the D.11 slot-specific "Brush stroke presets" ──
  await setPaint("stroke", { type: "material", material: { id: "brush", params: {} } });
  await settle();
  const strokeState = await sections();
  const brushSection = strokeState.find((s) => s.title === BRUSH_TITLE);
  ok(brushSection, `brush-stroke rect shows a section titled "${BRUSH_TITLE}" (saw: ${strokeState.map((s) => s.title).join(", ")})`);
  ok(brushSection && brushSection.presets.length === presetsForMaterial("brush").length,
    `"${BRUSH_TITLE}" lists all ${presetsForMaterial("brush").length} brush presets (got ${brushSection?.presets.length})`);

  if (errors.length) {
    console.error("PROBE ERRORS:\n" + errors.join("\n"));
    console.error(`\n${checks.filter(([c]) => c).length}/${checks.length} checks passed`);
    process.exit(1);
  }
  console.log(`Material presets probe passed: ${checks.length}/${checks.length} checks, zero console errors.`);
  for (const [, label] of checks) console.log(`  ok  ${label}`);
} finally {
  await browser.close();
  await server.close();
}
