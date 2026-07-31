/**
 * HANDLE-TOOLBAR ANCHOR probe — boot the real editor, select individual polygon
 * handles, and MEASURE where the selected-handle toolbar actually lands.
 *
 * WHY THIS EXISTS. The bar used to hang off the SELECTED HANDLES' bounding box,
 * which read as a tooltip stuck to a handle and jumped every time the selection
 * changed. User ruling: "the bar u put is hovering above the handle....it should be
 * above the widget or below like other toolbars". Commit b0bfc8e re-anchored it to
 * the WIDGET via FloatingCanvasPanel's shared widgetPanelAnchor. That change was
 * committed UNVERIFIED — the lead's first probe read app.selectedHandles(), which
 * returns the current selection rather than the handles available to be selected,
 * so it could not observe the bar at all. This probe pays that debt.
 *
 * THE TWO DECISIVE ASSERTIONS ARE DELIBERATELY NON-CIRCULAR. Checking the bar
 * against widgetPanelAnchor's own formula would only prove the component calls the
 * function it visibly calls. Instead:
 *   - INVARIANCE: select handle A, then handle B on the opposite corner. The bar's
 *     screen rect must be IDENTICAL. This is the user's actual complaint expressed
 *     as a measurement, and it fails loudly under the old handle-bbox anchor.
 *   - SEPARATION: with a single corner handle selected, the bar's centre must NOT
 *     sit over that handle. Under the old anchor it sat exactly there.
 * A third check confirms the bar is horizontally centred on the widget, which is
 * what "like other toolbars" means positionally.
 *
 * Run from SvelteLib root:
 *   node src/demo_apps/PowerRP/tests/handle_toolbar_anchor_probe.js
 */
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { launchBrowser } from "./puppeteerLaunch.js";
import * as T from "../core/transform.js";

// Paths resolve off THIS file, never process.cwd() — the suite convention, so the
// probe runs identically from the repo root or from its own directory.
const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, "../web");
const demoJson = await readFile(resolve(here, "../examples/demo.powerrp.json"), "utf8");

/** How many screen px two measurements of the SAME anchor may differ by and still
 *  count as identical. Sub-pixel layout rounding is expected; anything larger means
 *  the bar genuinely moved. */
const SAME_PLACE_PX = 1.5;

/** How far the bar's centre must be from a handle to prove it is not anchored to
 *  it. The polygon below is 300 world px wide, so a corner handle sits 150 world px
 *  from the widget's centre line — an order of magnitude above this floor. */
const CLEARLY_APART_PX = 40;

const server = await createServer({ configFile: resolve(webRoot, "vite.config.js"), server: { port: 0, open: false, host: "127.0.0.1" } });
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/`;

const browser = await launchBrowser();
const checks = [];
const errors = [];
const ok = (cond, label) => { checks.push([!!cond, label]); if (!cond) errors.push(`CHECK FAILED: ${label}`); };

// The stale-fixture boot-noise allowance handle_selection_probe.js documents: other
// agents' in-flight migrations on the shared demo fixture, plus this container's
// headless graphics reality. Named specifically — anything else still fails.
const IGNORE_BOOT = [/PowerRP repair:/, /was missing font/, /duration.*transition|transition.*duration/i, /no.*adapter|adapters/i];
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

  // A SQUARE polygon at a known pose, unrotated, large enough that its four corner
  // handles are far apart and a click can never land ambiguously between two.
  const setup = await page.evaluate(() => {
    const app = window.__powerrp_app;
    app.addItem(app.registry.get("polygon").defaults);
    const id = app.selection;
    app.setPreview([
      [["items", id, "x"], 300], [["items", id, "y"], 300],
      [["items", id, "w"], 300], [["items", id, "h"], 300],
      [["items", id, "rotation"], 0],
      [["items", id, "points"], [[0, 0], [1, 0], [1, 1], [0, 1]]],
      [["items", id, "closed"], true],
    ]);
    app.commitPreview();
    const node = app.nodes().find((n) => n.itemId === id);
    return {
      id,
      world: node.world,
      w: node.state.w,
      h: node.state.h,
      locals: node.plugin.modifierPoints(node.state).map((m) => ({ id: m.id, x: m.x, y: m.y })),
    };
  });
  ok(setup.locals.length >= 4, `polygon exposes at least 4 handles (got ${setup.locals.length})`);

  /** World point → PAGE (absolute) screen coords, through the app's OWN
   *  worldToScreen plus the overlay's real rect — so the probe never assumes a
   *  zoom/pan. */
  const worldToPage = (wx, wy) => page.evaluate((wx, wy) => {
    const app = window.__powerrp_app;
    const s = app.canvasActions.worldToScreen(wx, wy);
    const rect = document.querySelector(".overlay").getBoundingClientRect();
    return { x: rect.left + s.x, y: rect.top + s.y };
  }, wx, wy);

  /** Query. The selected-handle toolbar's page rect, or null when it is absent.
   *  Found by ROLE + LABEL, the accessible identity FloatingCanvasPanel gives it,
   *  rather than by a class name that styling could rename. */
  const toolbarRect = () => page.evaluate(() => {
    const el = document.querySelector('[role="toolbar"][aria-label="Selected points"]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
  });

  /** Command. Clicks the handle with the given id, selecting it (the inner
   *  selection scope), and returns that handle's own page coords. */
  const clickHandle = async (handleId) => {
    const loc = setup.locals.find((m) => m.id === handleId);
    if (!loc) throw new Error(`no handle "${handleId}" among ${setup.locals.map((m) => m.id).join(", ")}`);
    const w = T.apply(setup.world, loc.x, loc.y);
    const p = await worldToPage(w.x, w.y);
    await page.mouse.click(p.x, p.y);
    await new Promise((r) => setTimeout(r, 120));
    return p;
  };

  // Two handles on OPPOSITE corners, so any handle-following anchor must move a
  // long way between them.
  const [first, last] = [setup.locals[0], setup.locals[2]];

  const pageA = await clickHandle(first.id);
  const barA = await toolbarRect();
  ok(barA !== null, "the selected-handle toolbar appears once a handle is selected");

  const pageB = await clickHandle(last.id);
  const barB = await toolbarRect();
  ok(barB !== null, "the toolbar is still present with the opposite handle selected");

  if (barA && barB) {
    // INVARIANCE — the user's complaint, measured.
    const moved = Math.hypot(barA.cx - barB.cx, barA.y - barB.y);
    ok(moved <= SAME_PLACE_PX,
      `the bar does NOT move when the handle selection changes (moved ${moved.toFixed(2)}px between two opposite corners; handles themselves are ${Math.hypot(pageA.x - pageB.x, pageA.y - pageB.y).toFixed(0)}px apart)`);

    // SEPARATION — it is not sitting on the handle it acts on.
    const fromHandle = Math.hypot(barA.cx - pageA.x, barA.cy - pageA.y);
    ok(fromHandle >= CLEARLY_APART_PX,
      `the bar is not anchored to the handle (centre is ${fromHandle.toFixed(0)}px from it, floor ${CLEARLY_APART_PX})`);

    // CENTRED ON THE WIDGET — what "like other toolbars" means positionally.
    const topCentre = T.apply(setup.world, setup.w / 2, 0);
    const wantX = (await worldToPage(topCentre.x, topCentre.y)).x;
    ok(Math.abs(barA.cx - wantX) <= CLEARLY_APART_PX,
      `the bar is horizontally centred on the widget (bar cx ${barA.cx.toFixed(0)} vs widget centre ${wantX.toFixed(0)})`);
  }

  ok(liveErrors.length === 0, `no console errors during the gestures (${JSON.stringify(liveErrors)})`);
} finally {
  await browser.close();
  await server.close();
}

for (const [pass, label] of checks) console.log(`${pass ? "ok  " : "FAIL"} ${label}`);
if (errors.length) {
  console.error(`\n${errors.length} of ${checks.length} checks failed`);
  process.exit(1);
}
console.log(`\nall ${checks.length} checks passed`);
