/**
 * CURSOR OVERHAUL PROBE (browser) — renders the built-in cursor library live in
 * the editor (real glob + DOMParser + Skia WebGL2 pipeline) and screenshots it
 * for a VLM look. Used to (a) reproduce the upside-down + always-spinning +
 * off-center-spin defects, and (b) verify the fixes.
 *
 * Phases screenshotted into .claude_vlm_checks/:
 *   cursor_grid_static.png   — a labelled grid of many cursors, spin OFF: every
 *                              one must render UPRIGHT.
 *   cursor_beachball_spin.png— one beachball, spin ON, mid-spin: must be CENTERED
 *                              on the ball (rotation about the ball's own center).
 *   cursor_nonball_static.png— a non-ball cursor with the (default) spin flag:
 *                              must render STATIC (spin is beachball-only).
 *
 * Spawns its OWN isolated Vite + headless Chromium (swiftshader), the
 * demo_widget_probe.js pattern. Run from SvelteLib root:
 *   node src/demo_apps/PowerRP/tests/cursor_overhaul_probe.js
 */
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import fs from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(HERE, "../web");
const SHOTS = resolve(HERE, "../.claude_vlm_checks");
fs.mkdirSync(SHOTS, { recursive: true });

// ALL 39 built-in cursors — render every one so the VLM can spot ANY that is
// upside-down / flipped (the reproduction sweep).
const GRID = [
  "default", "contextualmenu", "copy", "makealias", "notallowed", "poof",
  "cross", "cell", "help", "handopen", "handgrabbing", "handpointing",
  "textcursor", "textcursorvertical", "zoomin", "zoomout", "move", "busy",
  "resizenorth", "resizesouth", "resizeeast", "resizewest",
  "resizeup", "resizedown", "resizeleft", "resizeright",
  "resizenortheast", "resizenorthwest", "resizesoutheast", "resizesouthwest",
  "resizenorthsouth", "resizewesteast", "resizeleftright", "resizeupdown",
  "resizenortheastsouthwest", "resizenorthwestsoutheast",
  "screenshotselection", "screenshotwindow", "beachball",
];

const { createServer } = await import("vite");
const server = await createServer({
  configFile: resolve(webRoot, "vite.config.js"),
  server: { port: 0, open: false, host: "127.0.0.1", hmr: false, watch: null },
});
await server.listen();
const baseUrl = `http://127.0.0.1:${server.httpServer.address().port}`;

const { default: puppeteer } = await import("puppeteer");
const browser = await puppeteer.launch({ headless: "new", args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox", "--ignore-gpu-blocklist"] });

const errors = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fitToCamera = (page) => page.evaluate(() => window.__powerrp_app.commands.get("reset-view")?.run(window.__powerrp_app));

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  const IGNORE = /Failed to load resource|thumbnail|\/api\/|clipboard|listAssets|project assets|Internal Server Error|ECONNREFUSED|http proxy error/i;
  page.on("console", (m) => { if (m.type() === "error" && !IGNORE.test(m.text())) errors.push(`console.error: ${m.text()}`); });

  await page.goto(`${baseUrl}/`, { waitUntil: "networkidle0" });
  await sleep(3500);
  if (errors.length) { console.error("BOOT ERRORS:\n" + errors.join("\n")); process.exit(1); }

  // ── (1) STATIC GRID: many cursors, spin explicitly OFF, with a text label
  //        under each so the VLM can tell which is which.
  await page.evaluate((names) => {
    const app = window.__powerrp_app;
    const def = (type) => ({ ...app.registry.get(type).defaults, type });
    const COLS = 6, CELL = 200, CUR = 96, PAD = 30, ROWS = Math.ceil(names.length / COLS);
    const cam = { ...def("camera"), name: "Camera", x: 0, y: 0, w: PAD + COLS * CELL, h: PAD + ROWS * CELL, z: 1000, active: true, background: "#20242e" };
    const items = { cam };
    names.forEach((name, i) => {
      const col = i % COLS, row = Math.floor(i / COLS);
      const cx = PAD + col * CELL, cy = PAD + row * CELL;
      items["cur_" + name] = { ...def("cursor"), name, x: cx + (CELL - CUR) / 2, y: cy, w: CUR, h: CUR, z: 1, active: true, cursorKind: name, spin: false };
      items["lbl_" + name] = { ...def("text"), name: "lbl " + name, x: cx, y: cy + CUR + 6, w: CELL, h: 26, z: 2, active: true, text: name, fontSize: 16, color: "#e8e8ec", align: "center" };
    });
    const tr = { type: "tween", seconds: 0.4, curve: "smooth", sound: null };
    const doc = { meta: { name: "cursor-grid", slideW: 960, slideH: 760 }, slides: [{ id: "s0", name: "S1", transition: tr, delta: { items } }] };
    app.commit(app.repaired(doc));
    app.slideIndex = 0;
    app.selection = null;
  }, GRID);
  await fitToCamera(page); await sleep(900);
  await page.screenshot({ path: resolve(SHOTS, "cursor_grid_static.png") });

  // ── (2) BEACHBALL SPIN: one large beachball, spin ON. Screenshot mid-spin.
  //        The freeze clock (particleTime) is fixed in the editor, so we nudge
  //        it to a representative non-zero phase for the shot.
  await page.evaluate(() => {
    const app = window.__powerrp_app;
    const def = (type) => ({ ...app.registry.get(type).defaults, type });
    const cam = { ...def("camera"), name: "Camera", x: 0, y: 0, w: 600, h: 600, z: 1000, active: true, background: "#20242e" };
    // a small reference crosshair rect behind so the VLM can judge centering
    const dot = { ...def("rect"), name: "ctr", x: 298, y: 100, w: 4, h: 400, z: 0, active: true, fill: "#ff3b6b", cornerRadius: 0 };
    const dot2 = { ...def("rect"), name: "ctr2", x: 100, y: 298, w: 400, h: 4, z: 0, active: true, fill: "#ff3b6b", cornerRadius: 0 };
    const ball = { ...def("cursor"), name: "ball", x: 200, y: 200, w: 200, h: 200, z: 1, active: true, cursorKind: "beachball", spin: true };
    const tr = { type: "tween", seconds: 0.4, curve: "smooth", sound: null };
    const doc = { meta: { name: "cursor-ball", slideW: 600, slideH: 600 }, slides: [{ id: "s0", name: "S1", transition: tr, delta: { items: { cam, dot, dot2, ball } } }] };
    app.commit(app.repaired(doc));
    app.slideIndex = 0;
    app.selection = null;
  });
  await fitToCamera(page); await sleep(900);
  await page.screenshot({ path: resolve(SHOTS, "cursor_beachball_spin.png") });

  // ── (3) NON-BALL + spin flag: an arrow with spin:true must render STATIC.
  await page.evaluate(() => {
    const app = window.__powerrp_app;
    const def = (type) => ({ ...app.registry.get(type).defaults, type });
    const cam = { ...def("camera"), name: "Camera", x: 0, y: 0, w: 400, h: 400, z: 1000, active: true, background: "#20242e" };
    const arrow = { ...def("cursor"), name: "arrow", x: 120, y: 120, w: 160, h: 160, z: 1, active: true, cursorKind: "default", spin: true };
    const tr = { type: "tween", seconds: 0.4, curve: "smooth", sound: null };
    const doc = { meta: { name: "cursor-nonball", slideW: 400, slideH: 400 }, slides: [{ id: "s0", name: "S1", transition: tr, delta: { items: { cam, arrow } } }] };
    app.commit(app.repaired(doc));
    app.slideIndex = 0;
    app.selection = null;
  });
  await fitToCamera(page); await sleep(900);
  await page.screenshot({ path: resolve(SHOTS, "cursor_nonball_static.png") });

  // ── (4) FLOATING TOOLBAR: double-click a cursor widget → its visual grid
  //        popover appears anchored above it.
  await page.evaluate(() => {
    const app = window.__powerrp_app;
    const def = (type) => ({ ...app.registry.get(type).defaults, type });
    const cam = { ...def("camera"), name: "Camera", x: 0, y: 0, w: 800, h: 600, z: 1000, active: true, background: "#20242e" };
    const cur = { ...def("cursor"), name: "cur", x: 340, y: 320, w: 120, h: 120, z: 1, active: true, cursorKind: "default", spin: false };
    const tr = { type: "tween", seconds: 0.4, curve: "smooth", sound: null };
    const doc = { meta: { name: "cursor-toolbar", slideW: 800, slideH: 600 }, slides: [{ id: "s0", name: "S1", transition: tr, delta: { items: { cam, cur } } }] };
    app.commit(app.repaired(doc));
    app.slideIndex = 0;
    window.__curId = Object.keys(app.doc.slides[0].delta.items).find((k) => app.doc.slides[0].delta.items[k].type === "cursor");
  });
  await fitToCamera(page); await sleep(700);
  // Double-click the cursor widget (page coords = render-area offset + the
  // widget's screen center) to open its floating toolbar.
  const dbl = await page.evaluate(() => {
    const app = window.__powerrp_app;
    const n = app.nodes().find((nn) => nn.itemId === window.__curId);
    const cw = (n.state.w ?? 0) / 2, ch = (n.state.h ?? 0) / 2; // rotation 0, scale 1 → world center = (x+w/2, y+h/2)
    const s = app.canvasActions.worldToScreen(n.world.x + cw, n.world.y + ch);
    const r = document.querySelector(".overlay").getBoundingClientRect();
    return { px: r.left + s.x, py: r.top + s.y };
  });
  await page.mouse.click(dbl.px, dbl.py, { clickCount: 2 });
  await sleep(700);
  await page.screenshot({ path: resolve(SHOTS, "cursor_toolbar.png") });

  // Functional check: the toolbar is a live grid — clicking a tile writes
  // cursorKind (one undo unit). Verify count + that a pick lands.
  const picked = await page.evaluate(() => {
    const app = window.__powerrp_app;
    const tiles = [...document.querySelectorAll(".canvas-toolbar-tile")];
    const before = app.state().items[window.__curId].cursorKind;
    const cross = tiles.find((t) => t.title === "Cross");
    cross?.click();
    return { count: tiles.length, before, after: app.state().items[window.__curId].cursorKind, clicked: !!cross };
  });
  const okPick = picked.count === 39 && picked.clicked && picked.after === "cross" && picked.before === "default";
  console.log(`  ${okPick ? "ok  " : "FAIL"} floating toolbar: ${picked.count} tiles, pick "${picked.before}"→"${picked.after}"`);
  if (!okPick) errors.push("floating-toolbar pick did not write cursorKind");

  // ── (5) HOTSPOT PLACEMENT: place several cursors so each cursor's OWN
  //        placement anchor (its hotspot) lands on a red crosshair mark. The
  //        arrow's TIP, the crosshair's CENTER, and the hand's FINGERTIP must
  //        each sit on their mark — proof the tip lands where positioned.
  await page.evaluate(() => {
    const app = window.__powerrp_app;
    const def = (type) => ({ ...app.registry.get(type).defaults, type });
    const cam = { ...def("camera"), name: "Camera", x: 0, y: 0, w: 900, h: 360, z: 1000, active: true, background: "#20242e" };
    const cur = app.registry.get("cursor");
    const items = { cam };
    const CUR = 120, MARK = 60;
    ["default", "cross", "handpointing"].forEach((kind, i) => {
      const P = { x: 150 + i * 300, y: 180 }; // the point to land the tip on
      items["mh_" + kind] = { ...def("rect"), name: "mh", x: P.x - MARK / 2, y: P.y - 1, w: MARK, h: 2, z: 5, active: true, fill: "#ff3b6b", cornerRadius: 0 };
      items["mv_" + kind] = { ...def("rect"), name: "mv", x: P.x - 1, y: P.y - MARK / 2, w: 2, h: MARK, z: 5, active: true, fill: "#ff3b6b", cornerRadius: 0 };
      const st = { ...cur.defaults, cursorKind: kind, w: CUR, h: CUR };
      const a = cur.placementAnchor(st); // hotspot in box-local (the same call CanvasView placement makes)
      items["c_" + kind] = { ...cur.defaults, type: "cursor", name: kind, cursorKind: kind, w: CUR, h: CUR, x: P.x - a.x, y: P.y - a.y, z: 1, active: true, spin: false };
    });
    const tr = { type: "tween", seconds: 0.4, curve: "smooth", sound: null };
    const doc = { meta: { name: "cursor-hotspot", slideW: 900, slideH: 360 }, slides: [{ id: "s0", name: "S1", transition: tr, delta: { items } }] };
    app.commit(app.repaired(doc));
    app.slideIndex = 0;
    app.selection = null;
  });
  await fitToCamera(page); await sleep(900);
  await page.screenshot({ path: resolve(SHOTS, "cursor_hotspot.png") });

  if (errors.length) console.error("PAGE ERRORS:\n" + errors.join("\n"));
  console.log("SHOTS written to", SHOTS);
} finally {
  await browser.close();
  await server.close();
}
process.exit(0);
