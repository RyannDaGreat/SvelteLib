/**
 * SKY-FAMILY PRESET LIBRARY probe — proves that every preset all FOUR `sky*` widgets
 * ship actually renders, and that the house hover-preview trope holds for every row of
 * every widget rather than for the first row of one.
 *
 * Run from anywhere (paths resolve off import.meta.url, never the cwd):
 *   node src/demo_apps/PowerRP/tests/sky_presets_probe.js [shot_dir]
 *
 * WHY THIS EXISTS, next to the three suites that already touch these presets:
 *   tests/tool_groups_test.js   — bare node, proves the RESOLUTION rules (a preset
 *     group exists, families are disjoint) over every registered plugin. No pixels.
 *   tests/sky_family_test.js    — bare node, proves the LIBRARY's rules (every preset
 *     spells every look knob, none writes a composition key, the paired names match)
 *     and the dark-halo regression. Still not the PANE.
 *   tests/toolspane_probe.js    — browser, proves the pane's structure and that
 *     hover-preview survives, on ONE card (`.tool-preset` first match).
 * None can catch a preset that resolves, lists, previews — and renders a look
 * INDISTINGUISHABLE from another. With twenty-nine rows over four widgets, "they all
 * render" long ago stopped being inspectable by eye.
 *
 * DELIBERATELY MODELLED ON tests/lens_flare_presets_probe.js, including its ONE
 * improvement over the older pane probe: it sweeps EVERY row rather than the first
 * `.tool-preset` match, which is exactly how eleven untested rows once hid. What is new
 * here is the second axis — four widgets, selected in turn — because this family's whole
 * point is that its members interact, so each one's presets have to be previewed with
 * its siblings present.
 *
 * THE FOUR CHECKS PER WIDGET, each a rendered fact:
 *   (1) THE LIBRARY IS COMPLETE AND ORDERED — the pane's rows are exactly that
 *       widget's presets, in the plugin's order. The order is content (the sky's five
 *       day atmospheres run up Preetham's turbidity ladder; the moon's run the month),
 *       so a re-sorted or dropped row is a defect.
 *   (2) EVERY ROW EXPLAINS ITSELF — the row's tip is the preset's own `description`,
 *       not ToolsPane's generic "Apply the … preset" fallback. For this family the
 *       description is load-bearing beyond politeness: it is where the multi-widget
 *       pairing and the "put the sun here" instruction live.
 *   (3) EVERY PRESET RENDERS, DISTINCTLY — hovering repaints the viewport, and all of
 *       that widget's previews plus its un-hovered baseline are pairwise different
 *       images.
 *   (4) PREVIEW IS FREE — the document bytes are untouched while previewing and leaving
 *       reverts. A click costing exactly one undo unit is checked once at the end.
 *
 * Vite runs with HMR + watching OFF (tests/toolspane_probe.js's reason: sibling agents
 * edit these files concurrently and a reload mid-probe reads as a flake).
 */
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import puppeteer from "puppeteer";
import { skyPlugins } from "../plugins/demo/sky.js";

const here = dirname(fileURLToPath(import.meta.url));
const powerRP = resolve(here, "..");
const svelteLib = resolve(powerRP, "../../..");
const webRoot = resolve(powerRP, "web");
const demoJson = await readFile(resolve(powerRP, "examples/demo.powerrp.json"), "utf8");
const shots = process.argv[2] ?? resolve(powerRP, ".claude_vlm_checks/sky_presets_probe");
await mkdir(shots, { recursive: true });

// THE SCENE, in insertion order. Every widget is given an EXPLICIT modest box: the sky
// dome is per-pixel SkSL and headless Chrome has no real GPU (SwiftShader), so a
// camera-filling dome would make every one of ~30 hovers a multi-second repaint. The
// boxes overlap the way a real sky scene does, and the sun is inside the dome's box so
// the sibling query (core/derive.collectSkyScene) has something to find — which is the
// whole reason the previews have to be taken with the family assembled.
const SCENE = [
  { type: "sky", x: 80, y: 70, w: 640, h: 360 },
  { type: "skyClouds", x: 110, y: 190, w: 560, h: 170 },
  { type: "skySun", x: 200, y: 120, w: 180, h: 180 },
  { type: "skyMoon", x: 520, y: 110, w: 150, h: 150 },
];
// ToolsPane.svelte's tip when a preset declares no description — the string check (2)
// must NOT see. A literal on purpose: if the pane's wording changes, this probe going
// quiet is the wrong failure, so (2) asserts the DESCRIPTION is present and only names
// the fallback as the diagnosis.
const GENERIC_TIP = (name) => `Apply the ${name} preset to the current frame`;
// A hover stages synchronously but the Skia surface repaints on the next tick, and the
// screenshot must be of the repaint. Longer than the lens flare's 260 ms because the
// atmosphere shader is far heavier than a flare on a software rasterizer.
const SETTLE_MS = 520;
// After the app's test hook appears, the slack it needs to finish its first paint. The
// hook itself is WAITED for rather than slept past (BOOT_TIMEOUT_MS): a fixed sleep is
// what made the first run of this probe die on a cold Vite that spent seconds
// re-optimizing dependencies before the app ever mounted.
const BOOT_SETTLE_MS = 900;
const BOOT_TIMEOUT_MS = 60000;

const server = await createServer({
  configFile: resolve(webRoot, "vite.config.js"),
  root: webRoot,
  server: { port: 0, open: false, host: "127.0.0.1", hmr: false, watch: null },
});
await server.listen();
const port = server.httpServer.address().port;

// The scene rasterizes on Skia over WebGL2, which headless Chrome only has through
// SwiftShader — the same flags every other editor probe uses (tests/boot_probe.js).
const browser = await puppeteer.launch({
  headless: "new",
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox", "--ignore-gpu-blocklist"],
});
const failures = [];
const errors = [];
/** Command. Records one check's outcome and prints it. */
const check = (name, cond, detail = "") => {
  if (!cond) failures.push(`${name}${detail ? `: ${detail}` : ""}`);
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}${cond || !detail ? "" : ` — ${detail}`}`);
};
/**
 * Pure function. A short stable digest of an image buffer, used only to compare renders
 * for equality. Chrome's PNG encoder is deterministic for identical pixels, so equal
 * digests mean an identical image and unequal digests mean a different one.
 *
 * @param {Buffer} buf - PNG bytes
 * @returns {string} 12 hex chars
 *
 * @example digest(Buffer.from("abc")) // "ba7816bf8f01"
 */
const digest = (buf) => createHash("sha256").update(buf).digest("hex").slice(0, 12);
/** Pure function. A filename-safe form of a preset or widget name.
 *  @example slug("Dark-Sky Star Field") // "dark_sky_star_field" */
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_");

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") errors.push(`console.error: ${m.text()}`); });
  await page.evaluateOnNewDocument((json) => localStorage.setItem("powerrp.autosave", json), demoJson);
  // Collapse state persists per group id; start from a known-expanded pane.
  await page.evaluateOnNewDocument(() => localStorage.removeItem("powerrp.toolsCollapsed"));
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "networkidle0" });
  try {
    await page.waitForFunction(() => !!window.__powerrp_app, { timeout: BOOT_TIMEOUT_MS });
  } catch (e) {
    // RE-RAISED, never swallowed — but with the page's own errors attached, because a
    // bare "waiting failed" says nothing about WHY the app never mounted (a sibling
    // agent's half-saved module, a repair throw, a missing asset).
    throw new Error(`${e.message}\n  page errors so far:\n    ${errors.join("\n    ") || "(none captured — the app simply never set its test hook)"}`);
  }
  await new Promise((r) => setTimeout(r, BOOT_SETTLE_MS));
  const bootErrors = errors.length; // baseline: in-flight WIP noise from siblings

  const settle = () => new Promise((r) => setTimeout(r, SETTLE_MS));

  // ── assemble the scene, remembering each member's item id ──────────────────
  const ids = await page.evaluate((scene) => {
    const app = window.__powerrp_app;
    const out = {};
    for (const spec of scene) {
      app.addItem({ ...app.registry.get(spec.type).defaults, ...spec });
      out[spec.type] = app.selection; // addItem selects what it created
    }
    return out;
  }, SCENE);
  await settle();
  for (const spec of SCENE) check(`${spec.type}-was-inserted`, !!ids[spec.type]);

  /** Query. The i-th preset row's viewport centre, scrolled into view first (the pane's
   *  rows container is height-capped and scrolls internally). */
  const rowCenter = (i) => page.evaluate((idx) => {
    const el = [...document.querySelectorAll(".toolspane .tool-preset")][idx];
    if (!el) return null;
    el.scrollIntoView({ block: "nearest" });
    const r = el.getBoundingClientRect();
    return { label: el.textContent.trim(), x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, i);

  /** Query. A PNG of the viewport's canvas region (what the preview actually drew). */
  const canvasShot = async () => {
    const el = await page.$(".canvas-wrap");
    return await el.screenshot();
  };

  const docBefore = await page.evaluate(() => JSON.stringify(window.__powerrp_app.doc));
  let lastRowIndex = 0;

  // ── sweep every widget, then every row of it ───────────────────────────────
  for (const plugin of skyPlugins) {
    const presets = plugin.presets;
    console.log(`\n  ── ${plugin.title} (${presets.length} presets) ──`);
    check(`${plugin.type}: the plugin ships presets`, Array.isArray(presets) && presets.length > 0);
    if (!presets?.length) continue;

    await page.evaluate((id) => { window.__powerrp_app.selection = id; }, ids[plugin.type]);
    await settle();
    check(`${plugin.type}: it is the selected widget`,
      (await page.evaluate(() => window.__powerrp_app.selectedNode()?.type)) === plugin.type);

    // ── (1) the library is complete and in the plugin's order ────────────────
    const rows = await page.evaluate(() => {
      const groups = [...document.querySelectorAll(".toolspane .prop-category")];
      const g = groups.find((x) => x.querySelector(".cat-rows .tool-preset"));
      if (!g) return null;
      return {
        title: g.querySelector(".cat-title")?.textContent?.trim(),
        labels: [...g.querySelectorAll(".cat-rows .tool-preset")].map((b) => b.textContent.trim()),
      };
    });
    check(`${plugin.type}: a preset group is rendered`, !!rows);
    check(`${plugin.type}: the group is titled Presets`, rows?.title === "Presets", rows?.title);
    check(`${plugin.type}: the pane lists every preset in the plugin's order`,
      JSON.stringify(rows?.labels) === JSON.stringify(presets.map((p) => p.name)),
      `${rows?.labels?.length} rows: ${rows?.labels?.join(" | ")}`);

    const baseline = await canvasShot();
    await writeFile(`${shots}/${slug(plugin.type)}_00_no_preview.png`, baseline);
    const seen = new Map([[digest(baseline), "(widget defaults, no preview)"]]);

    // ── (2)(3)(4) sweep EVERY row of THIS widget ─────────────────────────────
    for (let i = 0; i < presets.length; i++) {
      const preset = presets[i];
      const row = await rowCenter(i);
      check(`${plugin.type} row ${i} is present`, !!row, preset.name);
      if (!row) continue;
      lastRowIndex = i;
      await page.mouse.move(row.x, row.y);
      await settle();

      const staged = await page.evaluate(() => ({
        preview: window.__powerrp_app.previewDelta,
        doc: JSON.stringify(window.__powerrp_app.doc),
        tip: document.querySelector(".tt-tip")?.textContent ?? "",
      }));
      check(`${preset.name}: hover stages a preview`, !!staged.preview);
      check(`${preset.name}: hover leaves the document untouched`, staged.doc === docBefore);
      check(`${preset.name}: tip is the preset's own description`,
        staged.tip.includes(preset.description.slice(0, 40)),
        staged.tip === GENERIC_TIP(preset.name) ? "showing ToolsPane's generic fallback — the preset declares no description" : JSON.stringify(staged.tip.slice(0, 90)));

      // (3) It rendered, and it rendered something no other row of this widget produced.
      const png = await canvasShot();
      await writeFile(`${shots}/${slug(plugin.type)}_${String(i + 1).padStart(2, "0")}_${slug(preset.name)}.png`, png);
      const d = digest(png);
      check(`${preset.name}: renders a distinct image`, !seen.has(d), `identical to ${seen.get(d)}`);
      seen.set(d, preset.name);

      // (4) Leaving reverts, with no document change either way.
      await page.mouse.move(10, 10);
      await settle();
      const left = await page.evaluate(() => ({
        preview: window.__powerrp_app.previewDelta,
        doc: JSON.stringify(window.__powerrp_app.doc),
      }));
      check(`${preset.name}: leaving reverts the preview`, left.preview === null, JSON.stringify(left.preview));
      check(`${preset.name}: still no document change after revert`, left.doc === docBefore);
    }
    console.log(`  ${seen.size - 1}/${presets.length} ${plugin.type} presets rendered distinctly`);
  }

  // ── a click is EXACTLY one undo unit ──────────────────────────────────────
  // Done once, on the last row swept: the commit path is app.applyPreset for every row
  // alike (ToolsPane.runRow), so thirty clicks would prove the same fact thirty times
  // while each mutation makes the next row's "document untouched" baseline a moving
  // target. Same reasoning as tests/lens_flare_presets_probe.js's (4b).
  const last = await rowCenter(lastRowIndex);
  await page.mouse.move(last.x, last.y);
  await settle();
  await page.mouse.click(last.x, last.y);
  await settle();
  const committed = await page.evaluate(() => JSON.stringify(window.__powerrp_app.doc));
  check("click commits a change", committed !== docBefore);
  await page.evaluate(() => window.__powerrp_app.undo());
  await settle();
  check("one undo fully reverts the pick",
    (await page.evaluate(() => JSON.stringify(window.__powerrp_app.doc))) === docBefore);

  const newErrors = errors.slice(bootErrors);
  check("no new console errors", newErrors.length === 0, newErrors.join(" | "));
  console.log(`\n  shots in ${shots.replace(svelteLib, ".")}`);
} finally {
  await browser.close();
  await server.close();
}

if (failures.length) {
  console.error(`\n${failures.length} FAILURES:\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
console.log("\nsky preset probe: all checks passed");
