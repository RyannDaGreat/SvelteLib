/**
 * LENS-FLARE PRESET LIBRARY probe — proves that EVERY preset the plugin ships
 * actually renders, and that the house hover-preview trope holds for every row
 * rather than for the first one.
 *
 * Run from anywhere (paths resolve off import.meta.url, never the cwd):
 *   node src/demo_apps/PowerRP/tests/lens_flare_presets_probe.js [shot_dir]
 *
 * WHY THIS EXISTS, next to the two suites that already touch presets:
 *   tests/tool_groups_test.js  — bare node, proves the RESOLUTION rules (a preset
 *     group exists, families are disjoint) over every registered plugin. Says
 *     nothing about pixels.
 *   tests/toolspane_probe.js   — browser, proves the PANE's structure/typography and
 *     that hover-preview survives, on ONE card (`.tool-preset` first match).
 * Neither can catch a preset that resolves, lists, previews — and renders a look
 * INDISTINGUISHABLE from another, or from the widget defaults. A preset whose props
 * do not move a pixel is a dead row in the library, and with twelve rows spelling all
 * nineteen look knobs each, "they all render" stopped being inspectable by eye.
 *
 * The four checks, each a rendered fact:
 *   (1) THE LIBRARY IS COMPLETE AND ORDERED — the pane's rows are exactly the
 *       plugin's presets, in the plugin's order. The order is content here (the
 *       coating-era progression at the head of the table), so a pane that
 *       re-sorted or dropped one is a defect, not a cosmetic difference.
 *   (2) EVERY ROW EXPLAINS ITSELF — each row's tip is the preset's own
 *       `description`, not ToolsPane's generic "Apply the … preset" fallback.
 *   (3) EVERY PRESET RENDERS, DISTINCTLY — hovering each row repaints the viewport,
 *       and all N previews plus the un-hovered baseline are pairwise different
 *       images. Distinctness is the assertion that a look is really a look.
 *   (4) PREVIEW IS FREE, COMMIT COSTS ONE UNDO — for every row: the document bytes
 *       are untouched while previewing, leaving reverts, and a click is exactly one
 *       undo unit.
 *
 * Vite runs with HMR + watching OFF, tests/toolspane_probe.js's reason: sibling
 * agents edit these files concurrently and a reload mid-probe reads as a flake.
 */
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { launchBrowser } from "./puppeteerLaunch.js";
import { lensFlarePlugin } from "../plugins/demo/lens_flare.js";

const here = dirname(fileURLToPath(import.meta.url));
const powerRP = resolve(here, "..");
const svelteLib = resolve(powerRP, "../../..");
const webRoot = resolve(powerRP, "web");
const demoJson = await readFile(resolve(powerRP, "examples/demo.powerrp.json"), "utf8");
const shots = process.argv[2] ?? resolve(powerRP, ".claude_vlm_checks/lens_flare_presets");
await mkdir(shots, { recursive: true });

const FLARE_TYPE = lensFlarePlugin.type;
const PRESETS = lensFlarePlugin.presets;
// A flare is ADDITIVE — under "screen" its contribution collapses toward zero on
// bright content, so on the demo deck's white slide the whole library renders as
// twelve near-identical near-invisible washes. That is correct behaviour and a
// useless proof sheet, so the probe darkens THE CAMERA's background (the camera owns
// the backdrop) to a night exterior before it looks at anything. Done through the
// ordinary setPreview → commitPreview write path, BEFORE the untouched-document
// baseline is taken, so it is not part of what the preview checks measure.
const NIGHT_BACKDROP = "#0b0e14";
// ToolsPane.svelte's tip when a preset declares no description — the string check (2)
// must NOT see. Kept as a literal here on purpose: if the pane's wording changes, this
// probe going quiet is the wrong failure, so the assertion below tests for the
// description instead and only reports the fallback as the diagnosis.
const GENERIC_TIP = (name) => `Apply the ${name} preset to the current frame`;
// One rAF-plus-raster of slack after a hover: the preview stages synchronously but the
// Skia surface repaints on the next tick, and the screenshot must be of the repaint.
const SETTLE_MS = 260;
const BOOT_MS = 900;

const server = await createServer({
  configFile: resolve(webRoot, "vite.config.js"),
  root: webRoot,
  server: { port: 0, open: false, host: "127.0.0.1", hmr: false, watch: null },
});
await server.listen();
const port = server.httpServer.address().port;

// The scene rasterizes on Skia over WebGL2, which headless Chrome only has through
// SwiftShader — the same flags every other editor probe uses (tests/boot_probe.js).
const browser = await launchBrowser();
const failures = [];
const errors = [];
/** Command. Records one check's outcome and prints it. */
const check = (name, cond, detail = "") => {
  if (!cond) failures.push(`${name}${detail ? `: ${detail}` : ""}`);
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}${cond || !detail ? "" : ` — ${detail}`}`);
};
/**
 * Pure function. A short stable digest of an image buffer, used only to compare
 * renders for equality. Chrome's PNG encoder is deterministic for identical pixels,
 * so equal digests mean an identical image and unequal digests mean a different one.
 *
 * @param {Buffer} buf - PNG bytes
 * @returns {string} 12 hex chars
 *
 * @example digest(Buffer.from("abc")) // "ba7816bf8f01"
 */
const digest = (buf) => createHash("sha256").update(buf).digest("hex").slice(0, 12);

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") errors.push(`console.error: ${m.text()}`); });
  await page.evaluateOnNewDocument((json) => localStorage.setItem("powerrp.autosave", json), demoJson);
  // Collapse state persists per group id; start from a known-expanded pane.
  await page.evaluateOnNewDocument(() => localStorage.removeItem("powerrp.toolsCollapsed"));
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "networkidle0" });
  await new Promise((r) => setTimeout(r, BOOT_MS));
  const bootErrors = errors.length; // baseline: in-flight WIP noise from siblings

  const settle = () => new Promise((r) => setTimeout(r, SETTLE_MS));

  const darkened = await page.evaluate((bg) => {
    const app = window.__powerrp_app;
    const camera = app.cameraState()?.id ?? null; // the app's own canonical accessor
    if (!camera) return null;
    app.setPreview([[["items", camera, "background"], bg]]);
    app.commitPreview();
    return camera;
  }, NIGHT_BACKDROP);
  check("the camera backdrop was darkened for a legible flare", !!darkened, "no camera item found");

  // A flare inserted at ITS OWN defaults, so it is camera-bound and fills the view —
  // the framing a full-frame look is authored for. (toolspane_probe.js overrides the
  // rect to a small box because it is measuring the PANE, not the render.)
  await page.evaluate((t) => {
    const app = window.__powerrp_app;
    app.addItem({ ...app.registry.get(t).defaults, type: t });
  }, FLARE_TYPE);
  await settle();
  check("a-flare-is-selected", await page.evaluate(() => !!window.__powerrp_app.selectedNode()));

  // ── (1) the library is complete and in the plugin's order ──────────────────
  const rows = await page.evaluate(() => {
    const groups = [...document.querySelectorAll(".toolspane .prop-category")];
    const g = groups.find((x) => x.querySelector(".cat-rows .tool-preset"));
    if (!g) return null;
    return {
      title: g.querySelector(".cat-title")?.textContent?.trim(),
      labels: [...g.querySelectorAll(".cat-rows .tool-preset")].map((b) => b.textContent.trim()),
    };
  });
  check("a-preset-group-is-rendered", !!rows);
  check("preset-group-is-titled-Presets", rows?.title === "Presets", rows?.title);
  check("pane-lists-every-preset-in-the-plugin's-order",
    JSON.stringify(rows?.labels) === JSON.stringify(PRESETS.map((p) => p.name)),
    `${rows?.labels?.length} rows: ${rows?.labels?.join(" | ")}`);

  /** Query. The i-th preset row's viewport centre, scrolled into view first (the
   *  pane's rows container is height-capped and scrolls internally). */
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
  const baseline = await canvasShot();
  await writeFile(`${shots}/00_defaults.png`, baseline);
  const seen = new Map([[digest(baseline), "(widget defaults, no preview)"]]);

  // ── (2)(3)(4) sweep EVERY row ─────────────────────────────────────────────
  for (let i = 0; i < PRESETS.length; i++) {
    const preset = PRESETS[i];
    const row = await rowCenter(i);
    check(`row-${i}-is-present`, !!row, preset.name);
    if (!row) continue;
    await page.mouse.move(row.x, row.y);
    await settle();

    const staged = await page.evaluate(() => ({
      preview: window.__powerrp_app.previewDelta,
      doc: JSON.stringify(window.__powerrp_app.doc),
      tip: document.querySelector(".tt-tip")?.textContent ?? "",
    }));
    check(`${preset.name}: hover stages a preview`, !!staged.preview);
    check(`${preset.name}: hover leaves the document untouched`, staged.doc === docBefore);
    // (2) The row's own sentence, not the pane's fallback.
    check(`${preset.name}: tip is the preset's description`,
      staged.tip.includes(preset.description ?? "\0"),
      staged.tip === GENERIC_TIP(preset.name) ? "showing ToolsPane's generic fallback — the preset declares no description" : JSON.stringify(staged.tip.slice(0, 90)));

    // (3) It rendered, and it rendered something no other row produced.
    const png = await canvasShot();
    const slug = preset.name.toLowerCase().replace(/[^a-z0-9]+/g, "_");
    await writeFile(`${shots}/${String(i + 1).padStart(2, "0")}_${slug}.png`, png);
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

  // ── (4b) a click is EXACTLY one undo unit ─────────────────────────────────
  // Done once, on the LAST row: the commit path is app.applyPreset for every row
  // alike (ToolsPane.runRow), so twelve clicks would prove the same fact twelve
  // times while each mutation makes the next row's "document untouched" baseline a
  // moving target.
  const last = await rowCenter(PRESETS.length - 1);
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
  console.log(`\n  ${seen.size - 1}/${PRESETS.length} presets rendered distinctly; shots in ${shots.replace(svelteLib, ".")}`);
} finally {
  await browser.close();
  await server.close();
}

if (failures.length) {
  console.error(`\n${failures.length} FAILURES:\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
console.log("\nlens-flare preset probe: all checks passed");
