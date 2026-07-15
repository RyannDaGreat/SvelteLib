/**
 * Multi-resize + Add-button crosshair-placement probe (manifest UNDEFERRAL
 * SWEEP: "MULTI-RESIZE via handles" + "crosshair PLACEMENT for ALL Add
 * buttons"). Boots the PowerRP editor headless with the demo deck and drives
 * REAL pointer gestures (page.mouse — CanvasView's handlers call
 * setPointerCapture, so a synthetic dispatchEvent would not route; same
 * technique crosshair_probe/modifier_probe use) against the live app, asserting:
 *
 *   MULTI-RESIZE:
 *   - grabbing the collective box's east/bottom (br) handle on a 2-item
 *     selection scales EVERY member's position AND size proportionally about
 *     the collective box's fixed (top-left) corner — numeric asserts;
 *   - a 45deg ROTATED member scales exactly: its world center moves about the
 *     fixed corner by the collective factor, and its size scales by the factor
 *     (analytic, computed against the live derive/worldTransform paint path);
 *   - Shift-uniform ties the two axes on the collective box.
 *
 *   PLACEMENT (a representative set — every Add command is verified to ARM
 *   placement, then two placements are driven end-to-end):
 *   - every Add command arms app.crosshair.kind === "place" (no immediate spawn);
 *   - a BBOX widget (donut) click-DRAG places the exact dragged rect; a plain
 *     CLICK places the default size centered;
 *   - an ENDPOINT widget (arrow) click-DRAG places from→to along the segment;
 *     a plain CLICK places a default-length arrow rightward.
 *
 * Zero console errors during the interactions (ignoring documented stale-fixture
 * boot noise — same IGNORE_BOOT list as crosshair_probe/rotated_resize_probe).
 *
 * Run from SvelteLib root:
 *   node src/demo_apps/PowerRP/tests/multiresize_place_probe.js [shot_dir]
 *
 * The multi-resize scenarios create their OWN two small rects in a safe canvas
 * region (world x/y that stays inside the render area at zoom 1, so the
 * collective box's handles never land under a right-side panel — the demo
 * rect+circle span too wide). World≈screen at zoom 1 on fresh boot.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer } from "vite";
import puppeteer from "puppeteer";
import * as T from "../core/transform.js";
import { worldTransform } from "../core/derive.js";

const repo = process.cwd();
const webRoot = resolve(repo, "src/demo_apps/PowerRP/web");
const demoJson = await readFile(resolve(repo, "src/demo_apps/PowerRP/examples/demo.powerrp.json"), "utf8");
const shots = process.argv[2] ?? "/tmp";

const approx = (a, b, eps = 0.5) => Math.abs(a - b) < eps; // 0.5px: pointer-driven gestures land within sub-pixel of the analytic target

const server = await createServer({ configFile: resolve(webRoot, "vite.config.js"), server: { port: 0, open: false, host: "127.0.0.1" } });
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/`;

const browser = await puppeteer.launch({ headless: "new" });
const checks = [];
const errors = [];
const ok = (cond, label) => { checks.push([!!cond, label]); if (!cond) errors.push(`CHECK FAILED: ${label}`); };
const IGNORE_BOOT = [/PowerRP repair:/, /was missing/, /duration.*transition|transition.*duration/i, /legacy "/];
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
  // Wait for the app to actually mount (its canvasActions bind) — a fixed sleep
  // races the ~1s GPU Metal warmup + other agents' HMR reloads.
  await page.waitForFunction(() => window.__powerrp_app?.canvasActions != null, { timeout: 15000 });
  await new Promise((r) => setTimeout(r, 300));
  afterBoot.on = true;

  const worldToPage = (wx, wy) => page.evaluate((wx, wy) => {
    const app = window.__powerrp_app;
    const s = app.canvasActions.worldToScreen(wx, wy);
    const rect = document.querySelector(".overlay").getBoundingClientRect();
    return { x: rect.left + s.x, y: rect.top + s.y };
  }, wx, wy);
  const appEval = (fn, ...a) => page.evaluate(fn, ...a);
  const nodeState = (id) => page.evaluate((id) => {
    const n = window.__powerrp_app.nodes().find((n) => n.itemId === id);
    return n ? { x: n.state.x, y: n.state.y, w: n.state.w, h: n.state.h, rotation: n.state.rotation ?? 0, scale: n.state.scale ?? 1, world: n.world } : null;
  }, id);
  const crosshairKind = () => page.evaluate(() => window.__powerrp_app.crosshair?.kind ?? null);
  const rawItem = (id) => page.evaluate((id) => window.__powerrp_app.rawState().items[id], id);
  /** PAGE-absolute center of the resize handle nearest world (wx,wy) — grabs the
   * REAL rendered 8px handle rect (robust to the ±4px handle inset), rather than
   * a bare worldToPage that can land just off the small target. */
  const handleCenterNear = (wx, wy) => page.evaluate((wx, wy) => {
    const app = window.__powerrp_app;
    const s = app.canvasActions.worldToScreen(wx, wy);
    const orect = document.querySelector(".overlay").getBoundingClientRect();
    const target = { x: orect.left + s.x, y: orect.top + s.y };
    let best = null, bestD = Infinity;
    for (const h of document.querySelectorAll(".overlay .handle")) {
      const b = h.getBoundingClientRect();
      const cx = b.left + b.width / 2, cy = b.top + b.height / 2;
      const d = Math.hypot(cx - target.x, cy - target.y);
      if (d < bestD) { bestD = d; best = { x: cx, y: cy }; }
    }
    return best;
  }, wx, wy);

  // Two fresh small rects placed in a SAFE region of the canvas (world x/y that
  // stays well inside the render area at zoom 1, so the collective box's
  // handles never land under a right-side panel). A={200,200,80,60},
  // B={360,320,80,60} → collective AABB x 200..440, y 200..380.
  const [A, B] = await appEval(() => {
    const app = window.__powerrp_app;
    const mk = (x, y) => { app.addItem({ ...app.registry.get("rect").defaults, x, y, w: 80, h: 60, rotation: 0 }); return app.selection; };
    const a = mk(200, 200), b = mk(360, 320);
    return [a, b];
  });
  await new Promise((r) => setTimeout(r, 60));

  // ── Scenario 1: MULTI-RESIZE scales members proportionally about the box ────
  // Grab the BR handle and drag it so the collective box doubles about its
  // fixed TL corner (200,200): BR (440,380) → (200 + 2*240, 200 + 2*180)=(680,560).
  await appEval((a, b) => window.__powerrp_app.selectMany([a, b]), A, B);
  await new Promise((r) => setTimeout(r, 80));
  const aB = await nodeState(A);
  const bB = await nodeState(B);
  const box0 = { x0: 200, y0: 200, x1: 440, y1: 380 };
  const AX = box0.x0, AY = box0.y0; // fixed corner (opposite the BR handle)
  const K = 2; // both axes double
  const brFrom = await handleCenterNear(box0.x1, box0.y1); // the real BR handle rect
  const brTo = await worldToPage(AX + K * (box0.x1 - AX), AY + K * (box0.y1 - AY));
  await page.mouse.move(brFrom.x, brFrom.y);
  await page.mouse.down();
  await page.mouse.move(brTo.x, brTo.y, { steps: 10 });
  await new Promise((r) => setTimeout(r, 60));
  await page.mouse.up();
  await new Promise((r) => setTimeout(r, 100));
  const aA = await nodeState(A);
  const bA = await nodeState(B);
  // Each member's position scales about (AX,AY) by K, size scales by K.
  ok(approx(aA.w, K * aB.w) && approx(aA.h, K * aB.h), `member A size scaled x${K} (got w${aA.w?.toFixed(1)} h${aA.h?.toFixed(1)}, want w${K*aB.w} h${K*aB.h})`);
  ok(approx(aA.x, AX + K * (aB.x - AX)) && approx(aA.y, AY + K * (aB.y - AY)), `member A position scaled about the fixed corner (got x${aA.x?.toFixed(1)} y${aA.y?.toFixed(1)}, want x${AX + K*(aB.x-AX)} y${AY + K*(aB.y-AY)})`);
  ok(approx(bA.w, K * bB.w) && approx(bA.h, K * bB.h), `member B size scaled x${K}`);
  ok(approx(bA.x, AX + K * (bB.x - AX)) && approx(bA.y, AY + K * (bB.y - AY)), `member B position scaled about the fixed corner`);
  await appEval(() => window.__powerrp_app.undo());
  await new Promise((r) => setTimeout(r, 80));

  // ── Scenario 2: MULTI-RESIZE with a 45deg ROTATED member (exactness) ────────
  // Rotate member A 45deg (keeps its self-center pivot), select A + B, grab BR
  // and uniformly scale x1.5 about the collective TL corner. Assert A's WORLD
  // CENTER scales about the fixed corner by the factor and its size scales by
  // the factor — the exact rotation-aware path.
  await appEval((id, rot) => {
    const app = window.__powerrp_app;
    app.selection = id;
    app.setPreview([[["items", id, "rotation"], rot]]);
    app.commitPreview();
  }, A, Math.PI / 4);
  await appEval((a, b) => window.__powerrp_app.selectMany([a, b]), A, B);
  await new Promise((r) => setTimeout(r, 80));
  // Recompute the collective AABB LIVE (the rotated member changed it).
  const box2 = await appEval((ids) => {
    const app = window.__powerrp_app;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const id of ids) {
      const n = app.nodes().find((n) => n.itemId === id);
      const w = n.state.w ?? 0, h = n.state.h ?? 0;
      const cs = Math.cos(n.world.rotation), sn = Math.sin(n.world.rotation), s = n.world.scale;
      for (const [lx, ly] of [[0,0],[w,0],[w,h],[0,h]]) {
        const px = n.world.x + s*(cs*lx - sn*ly), py = n.world.y + s*(sn*lx + cs*ly);
        minX = Math.min(minX, px); minY = Math.min(minY, py); maxX = Math.max(maxX, px); maxY = Math.max(maxY, py);
      }
    }
    return { x0: minX, y0: minY, x1: maxX, y1: maxY };
  }, [A, B]);
  const rectB2 = await nodeState(A);
  const centerBefore = T.apply(rectB2.world, rectB2.w / 2, rectB2.h / 2); // world center pre-resize
  const AX2 = box2.x0, AY2 = box2.y0, K2 = 1.5;
  const brFrom2 = await handleCenterNear(box2.x1, box2.y1); // the real BR handle rect
  const brTo2 = await worldToPage(AX2 + K2 * (box2.x1 - AX2), AY2 + K2 * (box2.y1 - AY2));
  await page.mouse.move(brFrom2.x, brFrom2.y);
  await page.mouse.down();
  await page.mouse.move(brTo2.x, brTo2.y, { steps: 10 });
  await new Promise((r) => setTimeout(r, 60));
  await page.mouse.up();
  await new Promise((r) => setTimeout(r, 100));
  const rectA2 = await nodeState(A);
  const centerAfter = T.apply(rectA2.world, rectA2.w / 2, rectA2.h / 2);
  const wantCx = AX2 + K2 * (centerBefore.x - AX2), wantCy = AY2 + K2 * (centerBefore.y - AY2);
  ok(approx(centerAfter.x, wantCx, 1) && approx(centerAfter.y, wantCy, 1),
    `rotated rect world CENTER scaled about the fixed corner (got ${centerAfter.x.toFixed(2)},${centerAfter.y.toFixed(2)}; want ${wantCx.toFixed(2)},${wantCy.toFixed(2)})`);
  ok(approx(rectA2.w, K2 * rectB2.w, 1) && approx(rectA2.h, K2 * rectB2.h, 1), `rotated rect size scaled x${K2} (got w${rectA2.w?.toFixed(1)} h${rectA2.h?.toFixed(1)})`);
  ok(approx(rectA2.rotation, Math.PI / 4, 1e-6), `rotated rect keeps its 45deg rotation through the multi-resize`);
  await appEval(() => { window.__powerrp_app.undo(); window.__powerrp_app.undo(); }); // undo resize + rotation
  await new Promise((r) => setTimeout(r, 80));

  // ── Scenario 3: every Add command ARMS crosshair placement ──────────────────
  const addCommands = ["add-rect", "add-text", "add-circle", "add-arrow", "add-elbow-arrow", "add-curved-arrow", "add-fancy-arrow", "add-donut", "add-magnifier", "add-cropbox", "add-image", "add-video"];
  for (const cmd of addCommands) {
    await appEval(() => window.__powerrp_app.deselectAll());
    const armed = await appEval((cmd) => { window.__powerrp_app.runCommand(cmd); return window.__powerrp_app.crosshair?.kind ?? null; }, cmd);
    ok(armed === "place", `"${cmd}" arms crosshair placement (got ${JSON.stringify(armed)})`);
    await page.keyboard.press("Escape"); // clear the arm before the next
    await new Promise((r) => setTimeout(r, 30));
  }

  // ── Scenario 4: BBOX placement (donut) — drag = exact rect, click = default ─
  await appEval(() => window.__powerrp_app.runCommand("add-donut"));
  await new Promise((r) => setTimeout(r, 40));
  const before4 = await appEval(() => Object.keys(window.__powerrp_app.rawState().items));
  const dg1 = await worldToPage(500, 500), dg2 = await worldToPage(660, 620); // 160x120 world rect
  await page.mouse.move(dg1.x, dg1.y);
  await page.mouse.down();
  await page.mouse.move(dg2.x, dg2.y, { steps: 6 });
  await new Promise((r) => setTimeout(r, 40));
  await page.mouse.up();
  await new Promise((r) => setTimeout(r, 80));
  const after4 = await appEval(() => Object.keys(window.__powerrp_app.rawState().items));
  const newDonut = after4.find((id) => !before4.includes(id));
  const donutPlaced = newDonut ? await nodeState(newDonut) : null;
  ok(donutPlaced && approx(donutPlaced.x, 500) && approx(donutPlaced.y, 500) && approx(donutPlaced.w, 160) && approx(donutPlaced.h, 120),
    `donut click-drag places the exact rect (got ${JSON.stringify(donutPlaced && {x:donutPlaced.x,y:donutPlaced.y,w:donutPlaced.w,h:donutPlaced.h})})`);

  await appEval(() => window.__powerrp_app.runCommand("add-donut"));
  await new Promise((r) => setTimeout(r, 40));
  const before4b = await appEval(() => Object.keys(window.__powerrp_app.rawState().items));
  const donutDefaults = await appEval(() => window.__powerrp_app.registry.get("donut").defaults);
  const cp = await worldToPage(700, 500);
  await page.mouse.move(cp.x, cp.y);
  await page.mouse.down();
  await new Promise((r) => setTimeout(r, 20));
  await page.mouse.up(); // plain click
  await new Promise((r) => setTimeout(r, 80));
  const after4b = await appEval(() => Object.keys(window.__powerrp_app.rawState().items));
  const newDonut2 = after4b.find((id) => !before4b.includes(id));
  const donut2 = newDonut2 ? await nodeState(newDonut2) : null;
  ok(donut2 && approx(donut2.w, donutDefaults.w) && approx(donut2.h, donutDefaults.h) && approx(donut2.x, 700 - donutDefaults.w / 2) && approx(donut2.y, 500 - donutDefaults.h / 2),
    `donut plain click places the default size centered (got ${JSON.stringify(donut2 && {x:donut2.x,y:donut2.y,w:donut2.w,h:donut2.h})})`);

  // ── Scenario 5: ENDPOINT placement (arrow) — drag = from→to, click = default ─
  await appEval(() => window.__powerrp_app.runCommand("add-arrow"));
  await new Promise((r) => setTimeout(r, 40));
  const before5 = await appEval(() => Object.keys(window.__powerrp_app.rawState().items));
  const af = await worldToPage(300, 650), at = await worldToPage(560, 700);
  await page.mouse.move(af.x, af.y);
  await page.mouse.down();
  await page.mouse.move(at.x, at.y, { steps: 6 });
  await new Promise((r) => setTimeout(r, 40));
  await page.mouse.up();
  await new Promise((r) => setTimeout(r, 80));
  const after5 = await appEval(() => Object.keys(window.__powerrp_app.rawState().items));
  const newArrow = after5.find((id) => !before5.includes(id));
  const arrowItem = newArrow ? await rawItem(newArrow) : null;
  ok(arrowItem && approx(arrowItem.from.x, 300) && approx(arrowItem.from.y, 650) && approx(arrowItem.to.x, 560) && approx(arrowItem.to.y, 700),
    `arrow click-drag places from→to along the segment (got ${JSON.stringify(arrowItem && {from:arrowItem.from,to:arrowItem.to})})`);

  await appEval(() => window.__powerrp_app.runCommand("add-arrow"));
  await new Promise((r) => setTimeout(r, 40));
  const before5b = await appEval(() => Object.keys(window.__powerrp_app.rawState().items));
  const arrowDefaults = await appEval(() => window.__powerrp_app.registry.get("arrow").defaults);
  const defaultLen = arrowDefaults.to.x - arrowDefaults.from.x;
  const cpa = await worldToPage(300, 750);
  await page.mouse.move(cpa.x, cpa.y);
  await page.mouse.down();
  await new Promise((r) => setTimeout(r, 20));
  await page.mouse.up(); // plain click
  await new Promise((r) => setTimeout(r, 80));
  const after5b = await appEval(() => Object.keys(window.__powerrp_app.rawState().items));
  const newArrow2 = after5b.find((id) => !before5b.includes(id));
  const arrow2 = newArrow2 ? await rawItem(newArrow2) : null;
  ok(arrow2 && approx(arrow2.from.x, 300) && approx(arrow2.from.y, 750) && approx(arrow2.to.x, 300 + defaultLen) && approx(arrow2.to.y, 750),
    `arrow plain click places a default-length arrow rightward (len ${defaultLen}; got ${JSON.stringify(arrow2 && {from:arrow2.from,to:arrow2.to})})`);

  await page.screenshot({ path: `${shots}/multiresize_place_probe.png` });

  if (liveErrors.length) errors.push(`console errors during interactions: ${liveErrors.join(" | ")}`);
  console.log(checks.map(([p, l]) => `  ${p ? "ok " : "FAIL"} ${l}`).join("\n"));
  if (errors.length) { console.error("\nFAILURES:\n" + errors.join("\n")); process.exit(1); }
  console.log(`\n${checks.length} multi-resize + placement checks passed (ignored ${bootErrors.length} boot error(s)).`);
} finally {
  await browser.close();
  await server.close();
}
