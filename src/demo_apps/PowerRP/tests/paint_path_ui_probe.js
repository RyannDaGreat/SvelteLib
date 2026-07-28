/**
 * PAINT-PATH UI probe (F.16–21): boot the PowerRP editor headless, add a paint_path
 * (the default two-crest WAVE — three CURVE anchors), select it, and pin the on-canvas
 * editing UX that ?cli=1 render probes structurally cannot reach:
 *
 *   F.17  each curve handle draws as a TRIANGLE (polygon.modifier), each anchor as a
 *         SQUARE (rect.modifier) — so counts split 3 anchors / 3 curve handles.
 *   F.16  a GHOST dashed stem line (.handle-stem) is drawn for a CURVE point only —
 *         three at first, and one fewer once a point is turned into a corner.
 *   F.20  selecting a handle shows the HandleToolbar with a CURVE toggle; clicking it
 *         zeroes that point's bezier handle (corner) as ONE undo unit, and undo restores.
 *   F.19  a corner exposes NO coincident bezier handle (only its position handle), so a
 *         drag there moves the point instead of sprouting a curve.
 *   F.18  right-clicking a point opens the CONTEXT MENU with Curve / New subpath / Remove.
 *   F.21  a corner's hx/hy Inspector fields render GRAYED (.disabled-val), the ghost idiom.
 *
 * PROBE-AUTHOR TRAP (shared with material_paint_ui_probe): the doc is a Svelte 5 $state
 * proxy — puppeteer's return-by-value mangles it, so anything read out of the doc is
 * JSON.stringify'd IN PAGE and parsed node-side.
 *
 * Run from SvelteLib root: node src/demo_apps/PowerRP/tests/paint_path_ui_probe.js
 */
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import puppeteer from "puppeteer";

const HERE = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(HERE, "../web");
const demoJson = await readFile(resolve(HERE, "../examples/demo.powerrp.json"), "utf8");
const shotDir = resolve(HERE, "../.claude_vlm_checks");

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const IGNORE_BOOT = [/PowerRP repair:/, /was missing font/, /duration.*transition|transition.*duration/i, /no.*adapter|adapters/i];
const isBootNoise = (s) => IGNORE_BOOT.some((re) => re.test(s));

/** JSON round-trip of the selected paint_path's stored paintPoints (in-page). */
const points = (page, id) => page.evaluate((pid) =>
  JSON.parse(JSON.stringify(window.__powerrp_app.doc.slides[0].delta.items[pid].paintPoints)), id);

/** Counts of the overlay's handle glyphs (F.16/F.17). */
const overlay = (page) => page.evaluate(() => ({
  triangles: document.querySelectorAll("svg.overlay polygon.modifier").length,
  squares: document.querySelectorAll("svg.overlay rect.modifier").length,
  stems: document.querySelectorAll("svg.overlay line.handle-stem").length,
}));

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
  errors.length = 0; // from here, ANY console error fails

  // ── Add a paint_path from the REGISTERED plugin defaults (effects bundle and all)
  //    and select it, so the overlay draws its handles. ─────────────────────────
  const pid = await page.evaluate(() => {
    const app = window.__powerrp_app;
    app.slideIndex = 0;
    app.addItem({ ...app.registry.get("paint_path").defaults });
    return app.selection;
  });
  ok(pid, "added and selected a paint_path");
  await sleep(300);

  const pts0 = await points(page, pid);
  ok(pts0.length === 3 && pts0.every((p) => p[2] !== 0 || p[3] !== 0),
    `the default path is three CURVE anchors; got ${JSON.stringify(pts0.map((p) => [p[2], p[3]]))}`);

  // ── F.16 / F.17 — triangle curve handles, square anchors, one ghost stem each ─
  const o0 = await overlay(page);
  ok(o0.squares === 3, `three ANCHOR squares (rect.modifier); got ${o0.squares}`);
  ok(o0.triangles === 3, `three CURVE-handle TRIANGLES (polygon.modifier); got ${o0.triangles}`);
  ok(o0.stems === 3, `a ghost STEM line per curve handle; got ${o0.stems}`);

  await page.screenshot({ path: resolve(shotDir, "paint_path_ux_handles.png") });

  // ── F.20 — select a handle → HandleToolbar's CURVE toggle flips it, one undo unit
  await page.evaluate(() => { window.__powerrp_app.selectHandle("a0"); });
  await sleep(200);
  const hasToggle = await page.evaluate(() =>
    !![...document.querySelectorAll('button[aria-label="Curve for selected points"]')].length);
  ok(hasToggle, "the selected-handle toolbar shows a Curve toggle (aria-pressed reflects state)");

  await page.screenshot({ path: resolve(shotDir, "paint_path_ux_toolbar.png") });

  await page.evaluate(() =>
    document.querySelector('button[aria-label="Curve for selected points"]').click());
  await sleep(200);
  const pts1 = await points(page, pid);
  ok(pts1[0][2] === 0 && pts1[0][3] === 0,
    `Curve toggle turned point 0 into a CORNER (handle zeroed); got [${pts1[0][2]}, ${pts1[0][3]}]`);

  // F.16/F.17 follow-through: one fewer triangle and stem now that point 0 is a corner.
  const o1 = await overlay(page);
  ok(o1.triangles === 2 && o1.stems === 2, `corner drops its triangle + ghost line; got ${o1.triangles} tri / ${o1.stems} stem`);

  await page.evaluate(() => window.__powerrp_app.undo());
  await sleep(150);
  const pts2 = await points(page, pid);
  ok(pts2[0][2] === pts0[0][2] && pts2[0][3] === pts0[0][3],
    "one undo restores the handle (the toggle was ONE undo unit)");

  // ── F.19 — a corner exposes NO bezier handle: after making point 0 a corner, its
  //          modifierPoints offer only the position handle, so a drag moves the point.
  const cornerHandleIds = await page.evaluate(() => {
    const app = window.__powerrp_app;
    // turn point 0 into a corner directly through the same write the toggle uses
    app.selectHandle("a0");
    app.transformHandleSelectionElements((el) => [el[0], el[1], 0, 0, el[4]]);
    const node = app.selectedNode();
    return node.plugin.modifierPoints(node.state).map((m) => m.id);
  });
  ok(!cornerHandleIds.includes("h0") && cornerHandleIds.includes("a0"),
    `a corner offers its position handle but NO coincident bezier handle; got ${JSON.stringify(cornerHandleIds)}`);
  await page.evaluate(() => window.__powerrp_app.undo()); // restore the curve
  await sleep(150);

  // ── F.18 — right-click a point opens the context menu with the declared entries ─
  const menu = await page.evaluate(() => {
    const rect = document.querySelector("svg.overlay rect.modifier"); // an anchor
    rect.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 400, clientY: 300 }));
    return null;
  });
  await sleep(150);
  const menuLabels = await page.evaluate(() =>
    [...document.querySelectorAll(".context-menu .context-menu-item .context-menu-label")].map((n) => n.textContent.trim()));
  ok(menuLabels.includes("Curve") && menuLabels.includes("New subpath") && menuLabels.includes("Remove"),
    `the point menu offers Curve / New subpath / Remove; got ${JSON.stringify(menuLabels)}`);
  await page.screenshot({ path: resolve(shotDir, "paint_path_ux_menu.png") });
  // Escape dismisses it (the LOCAL popover-dismiss convention).
  await page.keyboard.press("Escape");
  await sleep(120);
  const menuGone = await page.evaluate(() => !document.querySelector(".context-menu"));
  ok(menuGone, "Escape dismisses the point context menu");

  // ── F.21 — a corner's hx/hy Inspector fields render GRAYED (.disabled-val) ─────
  // Make point 0 a corner, then read the paintPoints list row's inert fields. The
  // path is selected (its rows are LIVE), so any .disabled-val is the field-inert
  // idiom, not a not-yet-created row.
  const inertBefore = await page.evaluate(() => document.querySelectorAll(".inspector .list-el .disabled-val").length);
  await page.evaluate(() => {
    const app = window.__powerrp_app;
    app.selectHandle("a0");
    app.transformHandleSelectionElements((el) => [el[0], el[1], 0, 0, el[4]]);
  });
  await sleep(200);
  const inertAfter = await page.evaluate(() => document.querySelectorAll(".inspector .list-el .disabled-val").length);
  ok(inertAfter - inertBefore === 2,
    `turning point 0 into a corner grays its two handle fields (hx, hy); .disabled-val went ${inertBefore} → ${inertAfter}`);
  await page.screenshot({ path: resolve(shotDir, "paint_path_ux_inspector.png") });

  if (errors.length) {
    console.error("PROBE ERRORS:\n" + errors.join("\n"));
    console.error(`\n${checks.filter(([c]) => c).length}/${checks.length} checks passed`);
    process.exit(1);
  }
  console.log(`Paint-path UI probe passed: ${checks.length}/${checks.length} checks, zero console errors.`);
  for (const [, label] of checks) console.log(`  ok  ${label}`);
} finally {
  await browser.close();
  await server.close();
}
