/**
 * Crosshair mode + anchor snap probe (SB2, manifest ARCHITECTURE PLAN #4
 * ANCHOR SNAP + #5 CROSSHAIR MODE). Boots the PowerRP editor headless with
 * the demo deck and drives REAL pointer/keyboard gestures (page.mouse /
 * page.keyboard — CanvasView's handlers call setPointerCapture, so a
 * synthetic dispatchEvent would not route through them; same technique
 * modifier_probe.js/editor_smoke.js use) against the live app, asserting:
 *   - crosshairs render + follow the cursor while armed, and Esc cancels
 *     the arm with no gesture;
 *   - the toolbar "Box select" button arms the band crosshair;
 *   - a SHIFT-held band drag DESELECTS the caught items;
 *   - an empty-space drag (no arming) band-SELECTS by default;
 *   - Add Rectangle's click-DRAG places the exact dragged rect;
 *   - Add Rectangle's plain CLICK places a default-size box centered there;
 *   - holding A through a snapping move release writes the anchor EQUATION
 *     (asserts the stored string), and a plain release still writes plain
 *     numbers.
 * Zero console errors throughout (ignoring the documented stale-fixture
 * boot noise other in-flight agents' migrations leave — same IGNORE_BOOT
 * list as rotated_resize_probe.js/colorfield_probe.js).
 *
 * Run from SvelteLib root: node src/demo_apps/PowerRP/tests/crosshair_probe.js
 *
 * Demo fixture (examples/demo.powerrp.json): rect c5c2bed3 (x120 y160 w260
 * h160), circle 0f3d6775 (x760 y200 w180 h180), camera 1280x720. World≈
 * screen at zoom 1 (no pan/zoom on fresh boot).
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer } from "vite";
import puppeteer from "puppeteer";

const repo = process.cwd();
const webRoot = resolve(repo, "src/demo_apps/PowerRP/web");
const demoJson = await readFile(resolve(repo, "src/demo_apps/PowerRP/examples/demo.powerrp.json"), "utf8");
const shots = process.argv[2] ?? "/tmp";

const RECT = "c5c2bed3"; // x120 y160 w260 h160
const CIRCLE = "0f3d6775"; // x760 y200 w180 h180
const EPS = 1e-6;
const approx = (a, b, eps = EPS) => Math.abs(a - b) < eps;

const server = await createServer({ configFile: resolve(webRoot, "vite.config.js"), server: { port: 0, open: false, host: "127.0.0.1" } });
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/`;

const browser = await puppeteer.launch({ headless: "new" });
const checks = [];
const errors = [];
const ok = (cond, label) => { checks.push([!!cond, label]); if (!cond) errors.push(`CHECK FAILED: ${label}`); };
const IGNORE_BOOT = [/PowerRP repair:/, /was missing font/, /duration.*transition|transition.*duration/i];
const isBootNoise = (s) => IGNORE_BOOT.some((re) => re.test(s));

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  const bootErrors = [];
  page.on("pageerror", (e) => bootErrors.push(`pageerror: ${e.message}`));
  const afterBoot = { on: false };
  const liveErrors = [];
  page.on("console", (m) => {
    if (m.type() !== "error" || isBootNoise(m.text())) return;
    (afterBoot.on ? liveErrors : bootErrors).push(`console.error: ${m.text()}`);
  });
  await page.evaluateOnNewDocument((json) => localStorage.setItem("powerrp.autosave", json), demoJson);
  await page.goto(url, { waitUntil: "networkidle0" });
  await new Promise((r) => setTimeout(r, 600));
  ok(bootErrors.length === 0, `no non-noise boot errors (${JSON.stringify(bootErrors)})`);
  afterBoot.on = true;

  /** World point → PAGE (absolute) screen coordinates through the app's own
   * canvasActions.worldToScreen + the overlay's real bounding rect — the
   * SAME transform CanvasView's overlay/drag code uses (modifier_probe.js
   * precedent), so the probe never assumes a specific zoom/pan. */
  const worldToPage = (wx, wy) => page.evaluate((wx, wy) => {
    const app = window.__powerrp_app;
    const s = app.canvasActions.worldToScreen(wx, wy);
    const rect = document.querySelector(".overlay").getBoundingClientRect();
    return { x: rect.left + s.x, y: rect.top + s.y };
  }, wx, wy);

  const appState = (fn) => page.evaluate(fn);
  const rawItem = (id) => page.evaluate((id) => window.__powerrp_app.rawState().items[id], id);
  const nodeState = (id) => page.evaluate((id) => {
    const n = window.__powerrp_app.nodes().find((n) => n.itemId === id);
    return n ? { x: n.state.x, y: n.state.y, w: n.state.w, h: n.state.h } : null;
  }, id);
  // Svelte 5 $state proxies don't survive puppeteer's page.evaluate return
  // serialization (concerns.md lesson — returning app.doc/deep-proxy
  // subtrees yields {}); read the PRIMITIVE .kind string in-page instead of
  // returning app.crosshair itself.
  const crosshairKind = () => page.evaluate(() => window.__powerrp_app.crosshair?.kind ?? null);

  // ── Scenario 1: crosshairs render + follow the cursor, Esc cancels ────────
  await page.evaluate(() => window.__powerrp_app.armCrosshairBand("regular"));
  await new Promise((r) => setTimeout(r, 60));
  const armed1 = await crosshairKind();
  ok(armed1 === "band", `armCrosshairBand sets app.crosshair.kind="band" (got ${JSON.stringify(armed1)})`);
  const crosshairGeom = () => page.evaluate(() => [...document.querySelectorAll(".overlay .crosshair")].map((l) => l.getAttribute("x1") + "," + l.getAttribute("y1")));
  const p1 = await worldToPage(400, 300);
  await page.mouse.move(p1.x, p1.y);
  await new Promise((r) => setTimeout(r, 60));
  const segsAt1 = await page.evaluate(() => document.querySelectorAll(".overlay .crosshair").length);
  ok(segsAt1 === 2, `2 crosshair lines (H+V) render while armed and hovering (got ${segsAt1})`);
  const geomAt1 = await crosshairGeom();
  const p2 = await worldToPage(600, 450);
  await page.mouse.move(p2.x, p2.y);
  await new Promise((r) => setTimeout(r, 60));
  // FOLLOWS the cursor: the crosshair lines' geometry must change between the
  // two hover points (not frozen at the first position), and returning to p1
  // must reproduce the SAME geometry (not stale/drifting).
  const geomAt2 = await crosshairGeom();
  await page.mouse.move(p1.x, p1.y);
  await new Promise((r) => setTimeout(r, 60));
  const geomBackAt1 = await crosshairGeom();
  ok(JSON.stringify(geomBackAt1) === JSON.stringify(geomAt1), "crosshair geometry at p1 is reproducible (follows the stored cursor, not stale)");
  ok(JSON.stringify(geomAt2) !== JSON.stringify(geomAt1), "crosshair geometry differs between two distinct cursor positions (follows the cursor)");
  // Esc cancels the ARM (no gesture happened) — app.crosshair clears, lines gone.
  await page.keyboard.press("Escape");
  await new Promise((r) => setTimeout(r, 60));
  const armedAfterEsc = await appState(() => window.__powerrp_app.crosshair);
  ok(armedAfterEsc === null, `Escape clears app.crosshair while armed (got ${JSON.stringify(armedAfterEsc)})`);
  const segsAfterEsc = await page.evaluate(() => document.querySelectorAll(".overlay .crosshair").length);
  ok(segsAfterEsc === 0, `crosshair lines gone after Esc (got ${segsAfterEsc})`);

  // ── Scenario 2: toolbar "Box select" button arms the band crosshair ───────
  const toolbarArmed = await page.evaluate(() => {
    const btn = document.querySelector('[aria-label="Box select"]');
    if (!btn) return { found: false, kind: null };
    btn.click();
    return { found: true, kind: window.__powerrp_app.crosshair?.kind ?? null };
  });
  ok(toolbarArmed.found, "toolbar renders a Box select button (aria-label)");
  ok(toolbarArmed.kind === "band", `clicking it arms the band crosshair (got ${JSON.stringify(toolbarArmed.kind)})`);
  await page.keyboard.press("Escape"); // clean up the arm before the next scenario
  await new Promise((r) => setTimeout(r, 60));

  // ── Scenario 3: SHIFT-held band drag DESELECTS the caught items ───────────
  // Select BOTH rect and circle first, then shift-band-drag a box over just
  // the rect — only the rect should drop out of the selection.
  await page.evaluate((rect, circle) => window.__powerrp_app.selectMany([rect, circle]), RECT, CIRCLE);
  await new Promise((r) => setTimeout(r, 60));
  const before3 = await appState(() => window.__powerrp_app.selectedIds());
  ok(before3.length === 2, `both items selected before the shift-band (got ${JSON.stringify(before3)})`);
  await page.evaluate(() => window.__powerrp_app.armCrosshairBand("outer")); // outer = touching counts, most forgiving for a tight box
  const rBefore = { x: 100, y: 140 }, rAfter = { x: 400, y: 340 }; // world box enclosing the rect (120..380, 160..320)
  const d1 = await worldToPage(rBefore.x, rBefore.y);
  const d2 = await worldToPage(rAfter.x, rAfter.y);
  await page.mouse.move(d1.x, d1.y);
  await page.mouse.down();
  await page.keyboard.down("Shift");
  await page.mouse.move(d2.x, d2.y, { steps: 6 });
  await new Promise((r) => setTimeout(r, 60));
  await page.mouse.up();
  await page.keyboard.up("Shift");
  await new Promise((r) => setTimeout(r, 80));
  const after3 = await appState(() => window.__powerrp_app.selectedIds());
  ok(!after3.includes(RECT) && after3.includes(CIRCLE), `shift-band DESELECTS only the caught rect, keeps circle (got ${JSON.stringify(after3)})`);

  // ── Scenario 4: empty-space drag (no arming) band-SELECTS by default ──────
  await page.evaluate(() => window.__powerrp_app.deselectAll());
  await new Promise((r) => setTimeout(r, 60));
  const e1 = await worldToPage(100, 140);
  const e2 = await worldToPage(400, 340); // encloses the rect, well clear of the circle (760..940)
  await page.mouse.move(e1.x, e1.y);
  await page.mouse.down();
  await page.mouse.move(e2.x, e2.y, { steps: 6 });
  await new Promise((r) => setTimeout(r, 60));
  await page.mouse.up();
  await new Promise((r) => setTimeout(r, 80));
  const after4 = await appState(() => window.__powerrp_app.selectedIds());
  ok(after4.length === 1 && after4[0] === RECT, `plain empty-space drag SELECTS the enclosed rect with no arming (got ${JSON.stringify(after4)})`);
  await page.evaluate(() => window.__powerrp_app.deselectAll());

  // ── Scenario 5: Add Rectangle click-DRAG places the EXACT dragged rect ────
  await page.evaluate(() => window.__powerrp_app.runCommand("add-rect"));
  await new Promise((r) => setTimeout(r, 60));
  const armedPlace = await crosshairKind();
  ok(armedPlace === "place", `"add-rect" ARMS placement instead of spawning immediately (got ${JSON.stringify(armedPlace)})`);
  const idsBefore5 = await appState(() => Object.keys(window.__powerrp_app.rawState().items));
  const g1 = await worldToPage(500, 500);
  const g2 = await worldToPage(650, 580); // 150 x 80 world rect
  await page.mouse.move(g1.x, g1.y);
  await page.mouse.down();
  await page.mouse.move(g2.x, g2.y, { steps: 6 });
  await new Promise((r) => setTimeout(r, 60));
  await page.mouse.up();
  await new Promise((r) => setTimeout(r, 80));
  const idsAfter5 = await appState(() => Object.keys(window.__powerrp_app.rawState().items));
  const newId5 = idsAfter5.find((id) => !idsBefore5.includes(id));
  ok(!!newId5, "a new item exists after the placement drag");
  const placed5 = newId5 ? await nodeState(newId5) : null;
  ok(placed5 && approx(placed5.x, 500) && approx(placed5.y, 500) && approx(placed5.w, 150) && approx(placed5.h, 80),
    `click-drag places the EXACT dragged rect (got ${JSON.stringify(placed5)}, want x500 y500 w150 h80)`);

  // ── Scenario 6: Add Rectangle plain CLICK places the DEFAULT size ─────────
  await page.evaluate(() => window.__powerrp_app.runCommand("add-rect"));
  await new Promise((r) => setTimeout(r, 60));
  const idsBefore6 = await appState(() => Object.keys(window.__powerrp_app.rawState().items));
  const defaults6 = await appState(() => window.__powerrp_app.registry.get("rect").defaults);
  const clickPoint6 = { x: 700, y: 500 }; // within the visible render area (world x 0..~893 at this viewport)
  const c1 = await worldToPage(clickPoint6.x, clickPoint6.y);
  await page.mouse.move(c1.x, c1.y);
  await page.mouse.down();
  await new Promise((r) => setTimeout(r, 30));
  await page.mouse.up(); // no movement — a plain click
  await new Promise((r) => setTimeout(r, 80));
  const idsAfter6 = await appState(() => Object.keys(window.__powerrp_app.rawState().items));
  const newId6 = idsAfter6.find((id) => !idsBefore6.includes(id));
  const placed6 = newId6 ? await nodeState(newId6) : null;
  const wantX6 = clickPoint6.x - defaults6.w / 2, wantY6 = clickPoint6.y - defaults6.h / 2;
  ok(placed6 && approx(placed6.w, defaults6.w) && approx(placed6.h, defaults6.h) && approx(placed6.x, wantX6) && approx(placed6.y, wantY6),
    `plain click places DEFAULT size centered on the point (got ${JSON.stringify(placed6)}, want x${wantX6} y${wantY6} w${defaults6.w} h${defaults6.h})`);

  // ── Scenario 7: A-held release on a snapping MOVE writes the EQUATION ─────
  // Drag the rect so its top-left (tl) lands on the circle's top-left (tl)
  // world point — well within SNAP_PX so the point-snap engages, then
  // release with A held.
  const CIRCLE_TL = { x: 760, y: 200 }; // circle's world x/y IS its tl (bbox top-left)
  await page.evaluate((id) => { window.__powerrp_app.selection = id; }, RECT);
  await new Promise((r) => setTimeout(r, 60));
  const rectBefore7 = await nodeState(RECT);
  const grabPoint = { x: rectBefore7.x + 5, y: rectBefore7.y + 5 }; // inside the rect body, near its tl corner
  const grabScreen = await worldToPage(grabPoint.x, grabPoint.y);
  // Target: move the rect so its OWN top-left (tl) lands within a couple px
  // of the circle's tl — drag delta = circle.tl - rect.tl (minus a small
  // deliberate few-px offset so the snap CORRECTS it, proving the solver —
  // not just the drag — produced the final pose).
  const dx7 = CIRCLE_TL.x - rectBefore7.x - 3, dy7 = CIRCLE_TL.y - rectBefore7.y - 3;
  const dropScreen = await worldToPage(grabPoint.x + dx7, grabPoint.y + dy7);
  await page.mouse.move(grabScreen.x, grabScreen.y);
  await page.mouse.down();
  await page.mouse.move(dropScreen.x, dropScreen.y, { steps: 8 });
  await new Promise((r) => setTimeout(r, 80));
  const engaged7 = await appState(() => window.__powerrp_app.snapEngaged);
  ok(engaged7 === true, "snapEngaged is true mid-drag near the circle's tl corner (snap actually applied)");
  await page.keyboard.down("KeyA");
  await new Promise((r) => setTimeout(r, 40));
  await page.mouse.up();
  await page.keyboard.up("KeyA");
  await new Promise((r) => setTimeout(r, 80));
  const rectAfter7 = await rawItem(RECT);
  ok(typeof rectAfter7.x === "string" && rectAfter7.x.startsWith(`@${CIRCLE}_tl.x`),
    `A-held release writes an EQUATION referencing the circle's tl anchor on x (got ${JSON.stringify(rectAfter7.x)})`);
  ok(typeof rectAfter7.y === "string" && rectAfter7.y.startsWith(`@${CIRCLE}_tl.y`),
    `A-held release writes an EQUATION referencing the circle's tl anchor on y (got ${JSON.stringify(rectAfter7.y)})`);
  // The equation must EVALUATE to the exact snapped position (tl coincides
  // with the circle's tl — a bare reference, no offset, since it was an
  // exact-point snap).
  const evaluated7 = await nodeState(RECT);
  ok(approx(evaluated7.x, 760) && approx(evaluated7.y, 200), `equation evaluates to the circle's tl world point (got ${JSON.stringify(evaluated7)})`);
  await page.evaluate(() => window.__powerrp_app.undo());
  await new Promise((r) => setTimeout(r, 80));

  // ── Scenario 8: plain release (A NOT held) still writes PLAIN NUMBERS ─────
  const rectBefore8 = await rawItem(RECT); // post-undo: back to plain numeric x/y
  ok(typeof rectBefore8.x === "number", `sanity: rect x is numeric before scenario 8 (got ${JSON.stringify(rectBefore8.x)})`);
  const nodeBefore8 = await nodeState(RECT);
  const grabScreen8 = await worldToPage(nodeBefore8.x + 5, nodeBefore8.y + 5);
  const dx8 = 760 - nodeBefore8.x - 3, dy8 = 200 - nodeBefore8.y - 3;
  const dropScreen8 = await worldToPage(nodeBefore8.x + 5 + dx8, nodeBefore8.y + 5 + dy8);
  await page.mouse.move(grabScreen8.x, grabScreen8.y);
  await page.mouse.down();
  await page.mouse.move(dropScreen8.x, dropScreen8.y, { steps: 8 });
  await new Promise((r) => setTimeout(r, 80));
  await page.mouse.up(); // A NOT held
  await new Promise((r) => setTimeout(r, 80));
  const rectAfter8 = await rawItem(RECT);
  ok(typeof rectAfter8.x === "number" && typeof rectAfter8.y === "number",
    `plain release (no A) still commits PLAIN NUMBERS even though it snapped (got x=${JSON.stringify(rectAfter8.x)} y=${JSON.stringify(rectAfter8.y)})`);
  ok(approx(rectAfter8.x, 760) && approx(rectAfter8.y, 200), `plain numeric commit matches the snapped position (got ${JSON.stringify(rectAfter8)})`);
  await page.evaluate(() => window.__powerrp_app.undo());

  await page.screenshot({ path: `${shots}/crosshair_probe.png` });

  const newErrors = liveErrors;
  if (newErrors.length) errors.push(`console errors during interactions: ${newErrors.join(" | ")}`);

  console.log(checks.map(([p, l]) => `  ${p ? "ok " : "FAIL"} ${l}`).join("\n"));
  if (errors.length) { console.error("\nFAILURES:\n" + errors.join("\n")); process.exit(1); }
  console.log(`\n${checks.length} crosshair/anchor-snap checks passed (ignored ${bootErrors.length} boot error(s)).`);
} finally {
  await browser.close();
  await server.close();
}
