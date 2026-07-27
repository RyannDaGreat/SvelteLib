/**
 * ACTIVATION MIGRATION probe — the flag-day proof, in a real browser.
 *
 * tests/activation_migration_test.js pins the REGISTRY in bare node (every widget
 * declares its own handler, the legacy claim fallback is gone, migrationPlan is
 * empty). This probe pins the BEHAVIOUR that used to depend on those claims, by
 * driving REAL pointer gestures (page.mouse — CanvasView's handlers call
 * setPointerCapture, so a synthetic dispatchEvent would never route through them;
 * the crosshair_probe.js technique).
 *
 * WHY A SECOND PROBE AND NOT A WIDER activation_probe.js. That suite was written
 * while the plugin files belonged to other agents, so it INJECTS the Mandelbrot's
 * declaration onto the live plugin object at runtime and checks six of the ten
 * migrated widgets. Both gaps matter now that the claims are deleted: an injected
 * declaration proves the mechanism but NOT the plugin file, and the four widgets it
 * does not touch (video_scrub, pdf_page, video_v5, video_v5_scrub) each resolved
 * ONLY through a claim before this round. This probe injects NOTHING and covers all
 * ten, so what it exercises is exactly what ships.
 *
 * ONE WIDGET AT A TIME, AT ONE FIXED SPOT, PURGED AFTER. Measured the other way
 * first: laying ten widgets out across the canvas and double-clicking each in turn
 * fails after the FIRST media widget, because its asset picker is a real modal whose
 * backdrop then swallows every later page.mouse event (screenshot 1-*.png of that
 * run showed "Choose video asset — Source" covering the editor). Cycling one widget
 * through the same spot removes both hazards at once — no overlap arithmetic, and
 * each widget's own dismissal is checked before the next begins.
 *
 * WHAT IT PROVES
 *   (1) ALL TEN activations behave as before, from the plugin's own declaration:
 *       text → in-place rich edit, plaintext → PLAIN inline edit, latex → the
 *       equation editor, cursor → its canvas palette, and all SIX media widgets →
 *       the asset-pick signal (which really does open the picker). A rect still
 *       does nothing.
 *   (2) INTERIOR EXPLORE MODE works off plugins/demo/mandelbrot.js itself: a drag
 *       pans, a wheel zooms, each gesture is ONE undo unit, and the view lands in
 *       the DOCUMENT (so a reload / CLI render agrees with the screen).
 *   (3) THE FILMSTRIP'S TWO-STEP CREATION is a declared creation gesture: a real
 *       crosshair drag places the box AND raises the asset prompt — the behaviour
 *       that used to be a `type === "filmstrip"` branch inside app.addItem.
 *   (4) A widget placed by the plain "bbox" gesture raises NO prompt, which is the
 *       half of (3) that proves the prompt followed the DECLARATION and not the
 *       placement path.
 *
 * Run from SvelteLib root:
 *   node src/demo_apps/PowerRP/tests/activation_migration_probe.js [shot_dir]
 */
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer } from "vite";
import puppeteer from "puppeteer";

const repo = process.cwd();
const webRoot = resolve(repo, "src/demo_apps/PowerRP/web");
const shots = process.argv[2] ?? "/tmp/activation_migration_probe";
await mkdir(shots, { recursive: true });

// THE SPOT every widget is cycled through: comfortably inside the visible render
// area at the default camera and viewport, and the Mandelbrot's probe size too.
const SPOT = { x: 300, y: 180, w: 160, h: 120 };
const SPOT_CX = SPOT.x + SPOT.w / 2;
const SPOT_CY = SPOT.y + SPOT.h / 2;

// A SMALL, CHEAP Mandelbrot: headless Chromium rasterizes SkSL in software, and the
// shipped 520x390 at 900 iterations is ~200k heavy pixels per frame — minutes, not
// milliseconds. Same probe sizing activation_probe.js measured.
const PROBE_ITER = 60;
const SETTLE_MS = 260; // one reactive paint + Skia frame at probe size
const WHEEL_TICKS = 6; // one continuous zoom gesture
const WHEEL_DELTA = 60; // scroll down = zoom OUT (a deeper view at 60 iterations is legitimately solid)
const ZOOM_IDLE_WAIT_MS = 700; // > ZOOM_GESTURE_IDLE_MS (250), so the gesture ends

// HMR + the file watcher are OFF: many agents edit this tree concurrently, and a
// stray HMR reload mid-probe drops window.__powerrp_app for reasons that have
// nothing to do with what is being tested.
const server = await createServer({
  configFile: resolve(webRoot, "vite.config.js"),
  server: { port: 0, open: false, host: "127.0.0.1", hmr: false, watch: null },
});
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/`;

const browser = await puppeteer.launch({
  headless: "new",
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox", "--ignore-gpu-blocklist"],
});
const checks = [];
const errors = [];
const ok = (cond, label) => { checks.push([!!cond, label]); if (!cond) errors.push(`CHECK FAILED: ${label}`); };
// Documented boot/runtime noise from OTHER lanes (the crosshair_probe.js treatment):
// repair reports, missing fonts, the WebGPU-less headless video overlays — plus the
// SOURCE-LESS media widgets this probe deliberately spawns. Every media plugin ships
// a 1x1 PNG data URI as its blank `src`, so a <video> pointed at it reports
// "MEDIA_ELEMENT_ERROR: Unable to load URL due to content type". That report IS the
// widget behaving (a media widget must never fail silently); it is noise HERE only
// because a probe about double-clicks has to spawn media with no real asset.
const IGNORE = [
  /PowerRP repair:/, /was missing font/, /VideoV7/, /WebGPU/, /no WebGPU adapter/, /preserveAspect/,
  /failed to load/, /MEDIA_ELEMENT_ERROR/, /filmstrip has no video source/, /no frames resolved/,
  /Failed to load resource/,
];
const isNoise = (s) => IGNORE.some((re) => re.test(s));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  const bootErrors = [];
  const liveErrors = [];
  const phase = { live: false };
  page.on("pageerror", (e) => (phase.live ? liveErrors : bootErrors).push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() !== "error" || isNoise(m.text())) return;
    (phase.live ? liveErrors : bootErrors).push(`console.error: ${m.text()}`);
  });

  await page.goto(url, { waitUntil: "networkidle0" });
  await sleep(900);
  ok(bootErrors.length === 0, `no boot errors (${JSON.stringify(bootErrors)})`);
  phase.live = true;

  const worldToPage = (wx, wy) => page.evaluate((wx, wy) => {
    const app = window.__powerrp_app;
    const s = app.canvasActions.worldToScreen(wx, wy);
    const rect = document.querySelector(".overlay").getBoundingClientRect();
    return { x: rect.left + s.x, y: rect.top + s.y };
  }, wx, wy);
  const stored = (id, key) => page.evaluate((id, key) => window.__powerrp_app.storedItemValue(id, [key]), id, key);
  const modeId = () => page.evaluate(() => window.__powerrp_app.canvasMode?.handlerId ?? null);
  const itemIds = () => page.evaluate(() => Object.keys(window.__powerrp_app.rawState().items));
  const spawnAtSpot = (type, extra = {}) => page.evaluate((type, spot, extra) => {
    const app = window.__powerrp_app;
    app.addItem({ ...app.registry.get(type).defaults, ...spot, ...extra });
    return app.selection;
  }, type, SPOT, extra);
  /** Command. Removes `id` from existence and clears the selection, so the next
   *  widget through the spot is the only thing there. */
  const purge = (id) => page.evaluate((id) => {
    const app = window.__powerrp_app;
    app.selection = id;
    app.purgeSelection();
    app.deselectAll();
  }, id);
  /** Query. The open modal dialog's title, or null (src/lib/Modal.svelte markup). */
  const modalTitle = () => page.evaluate(() => document.querySelector(".modal-panel .modal-title")?.textContent?.trim() ?? null);
  /** Command. Closes an open modal through its own × button (a DOM button click,
   *  not a canvas gesture, so pointer capture is not involved). */
  const dismissModal = async () => {
    await page.evaluate(() => document.querySelector(".modal-panel .modal-close")?.click());
    await sleep(SETTLE_MS);
  };
  const dblAtSpot = async () => {
    const p = await worldToPage(SPOT_CX, SPOT_CY);
    await page.mouse.click(p.x, p.y, { clickCount: 2 });
    await sleep(SETTLE_MS);
  };

  // NOTHING IS INJECTED. Asserted up front, so a future "just patch it at runtime"
  // shortcut cannot quietly make this probe pass for the wrong reason.
  const declared = await page.evaluate(() => {
    const app = window.__powerrp_app;
    const out = {};
    for (const t of ["text", "plaintext", "latex", "cursor", "image", "video", "video_scrub", "pdf_page", "video_v5", "video_v5_scrub", "demo_mandelbrot", "filmstrip"])
      out[t] = { activate: app.registry.get(t)?.activate ?? null, placement: app.registry.get(t)?.placement ?? null };
    return out;
  });
  const TEN = {
    text: "rich_text_edit", plaintext: "inline_text_edit", latex: "latex_edit", cursor: "overlay_palette",
    image: "asset_picker", video: "asset_picker", video_scrub: "asset_picker", pdf_page: "asset_picker",
    video_v5: "asset_picker", video_v5_scrub: "asset_picker",
  };
  const misdeclared = Object.entries(TEN).filter(([t, id]) => declared[t].activate !== id);
  ok(misdeclared.length === 0, `all ten SHIPPED plugins declare their activation (bad: ${JSON.stringify(misdeclared)})`);
  ok(declared.demo_mandelbrot.activate === "navigate_interior", `the SHIPPED mandelbrot plugin declares explore mode (got ${declared.demo_mandelbrot.activate})`);
  ok(declared.filmstrip.placement === "bbox_then_asset", `the SHIPPED filmstrip plugin declares its two-step creation (got ${declared.filmstrip.placement})`);

  // ── (3)+(4) CREATION, on an otherwise empty canvas ─────────────────────────
  // A real crosshair drag, not app.addItem — the prompt belongs to the GESTURE now,
  // so only the gesture can prove it.
  const dragPlace = async (type, from, to) => {
    const before = await itemIds();
    await page.evaluate((t) => window.__powerrp_app.armCrosshairPlacement(window.__powerrp_app.registry.get(t)), type);
    await sleep(SETTLE_MS);
    const a = await worldToPage(from.x, from.y);
    const b = await worldToPage(to.x, to.y);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(b.x, b.y, { steps: 6 });
    await sleep(60);
    await page.mouse.up();
    await sleep(SETTLE_MS);
    const after = await itemIds();
    const id = after.find((x) => !before.includes(x));
    return { id, state: id ? await page.evaluate((i) => window.__powerrp_app.rawState().items[i], id) : null };
  };

  await page.evaluate(() => { window.__powerrp_app.pendingVideoPickFor = null; });
  const film = await dragPlace("filmstrip", { x: 150, y: 150 }, { x: 550, y: 230 });
  ok(!!film.id, "the crosshair drag placed a filmstrip");
  ok(film.state && Math.abs(film.state.x - 150) < 1 && Math.abs(film.state.w - 400) < 1 && Math.abs(film.state.h - 80) < 1,
    `it placed the EXACT dragged rect (got ${JSON.stringify(film.state && { x: film.state.x, y: film.state.y, w: film.state.w, h: film.state.h })}, want x150 y150 w400 h80)`);
  ok(await page.evaluate(() => window.__powerrp_app.pendingVideoPickFor) === film.id,
    "and the SAME gesture raised the asset prompt for it (manifest 14.3, now a declared creation gesture)");
  await page.screenshot({ path: `${shots}/1-filmstrip-two-step-creation.png` });
  await dismissModal();
  await page.evaluate(() => { window.__powerrp_app.pendingVideoPickFor = null; });
  if (film.id) await purge(film.id);

  const plainRect = await dragPlace("rect", { x: 150, y: 150 }, { x: 250, y: 230 });
  ok(!!plainRect.id, "the plain bbox gesture placed a rect");
  ok(await page.evaluate(() => window.__powerrp_app.pendingVideoPickFor) === null,
    "a plain bbox placement raises NO asset prompt — the prompt followed the DECLARATION, not the placement path");
  ok(await modalTitle() === null, "and it opened no picker");
  if (plainRect.id) await purge(plainRect.id);

  // ── (1) ALL TEN activations, one widget at a time through THE SPOT ──────────
  const textId = await spawnAtSpot("text");
  await dblAtSpot();
  ok(await page.evaluate(() => window.__powerrp_app.textEditing !== null), "text → in-place RICH edit");
  await page.keyboard.press("Escape");
  await sleep(SETTLE_MS);
  await purge(textId);

  const plainId = await spawnAtSpot("plaintext");
  await dblAtSpot();
  const plainEdit = await page.evaluate(() => window.__powerrp_app.textEditing?.plain ?? null);
  ok(plainEdit === true, `plaintext → PLAIN inline edit (got ${plainEdit})`);
  await page.keyboard.press("Escape");
  await sleep(SETTLE_MS);
  await purge(plainId);

  const latexId = await spawnAtSpot("latex");
  await dblAtSpot();
  ok(await page.evaluate(() => window.__powerrp_app.latexEditing !== null), "latex → the equation editor");
  await page.keyboard.press("Escape");
  await sleep(600); // the latex editor closes through a crossfade
  await purge(latexId);

  const cursorId = await spawnAtSpot("cursor");
  await dblAtSpot();
  ok(await page.evaluate(() => !!document.querySelector(".canvas-toolbar, .floating-toolbar")), "cursor → its canvas palette overlay");
  await page.screenshot({ path: `${shots}/2-cursor-palette.png` });
  await page.mouse.click(50, 700); // dismiss (the activation_probe.js precedent)
  await sleep(SETTLE_MS);
  await purge(cursorId);

  // THE SIX MEDIA WIDGETS. Four of them (video_scrub, pdf_page, video_v5,
  // video_v5_scrub) resolved ONLY through the deleted `primaryAsset` claim, so this
  // is the first time their double-click has been exercised at all.
  let pickersOpened = 0;
  for (const type of ["image", "video", "video_scrub", "pdf_page", "video_v5", "video_v5_scrub"]) {
    const id = await spawnAtSpot(type);
    await page.evaluate(() => { window.__powerrp_app.pendingVideoPickFor = null; });
    await dblAtSpot();
    const pickFor = await page.evaluate(() => window.__powerrp_app.pendingVideoPickFor);
    ok(pickFor === id, `${type} → the asset-pick signal for ITSELF (got ${JSON.stringify(pickFor)}, want ${id})`);
    const title = await modalTitle();
    if (title) {
      pickersOpened += 1;
      if (pickersOpened === 1) await page.screenshot({ path: `${shots}/3-asset-picker-open.png` });
      await dismissModal();
    }
    await page.evaluate(() => { window.__powerrp_app.pendingVideoPickFor = null; });
    await purge(id);
  }
  // The signal has a REAL READER: at least one of the six opened the picker end to
  // end. Not asserted per widget on purpose — the Inspector's AssetField only exists
  // while its category is expanded, so a collapsed category legitimately leaves the
  // signal unread (the known bound recorded in web/widget_handlers.js).
  ok(pickersOpened >= 1, `the asset-pick signal really opens the picker (opened for ${pickersOpened} of 6)`);

  const rectId = await spawnAtSpot("rect");
  await page.evaluate(() => { window.__powerrp_app.pendingVideoPickFor = null; });
  await dblAtSpot();
  ok(await page.evaluate(() => window.__powerrp_app.textEditing === null && window.__powerrp_app.latexEditing === null && window.__powerrp_app.pendingVideoPickFor === null && window.__powerrp_app.canvasMode === null),
    "a rect declares NO activation, so double-clicking it still does nothing");
  await purge(rectId);

  // ── (2) INTERIOR EXPLORE MODE, off the shipped plugin ─────────────────────
  const mbId = await spawnAtSpot("demo_mandelbrot", { maxIterations: PROBE_ITER });
  await sleep(1200);
  const start = {
    centerX: await stored(mbId, "centerX"),
    centerY: await stored(mbId, "centerY"),
    zoomExponent: await stored(mbId, "zoomExponent"),
  };
  await dblAtSpot();
  ok(await modeId() === "navigate_interior", `double-click enters explore mode from the PLUGIN's own declaration (got ${await modeId()})`);
  await page.screenshot({ path: `${shots}/4-explore-mode.png` });

  // PAN: one undo unit, committed on release, previewing live.
  await page.evaluate(() => { window.__probeCommits = 0; const a = window.__powerrp_app; const real = a.commit.bind(a); a.commit = (d) => { window.__probeCommits += 1; return real(d); }; });
  await sleep(1500); // let any unrelated async widget commit (latex re-typeset) land first
  const base = await page.evaluate(() => window.__probeCommits);
  const from = await worldToPage(SPOT_CX - 30, SPOT_CY - 20);
  const to = await worldToPage(SPOT_CX + 20, SPOT_CY + 15);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= 5; i += 1) {
    await page.mouse.move(from.x + (to.x - from.x) * i / 5, from.y + (to.y - from.y) * i / 5);
    await sleep(40);
  }
  const midPan = await stored(mbId, "centerX");
  const midCommits = await page.evaluate(() => window.__probeCommits) - base;
  await page.mouse.up();
  await sleep(SETTLE_MS);
  const panned = { centerX: await stored(mbId, "centerX"), centerY: await stored(mbId, "centerY") };
  const panCommits = await page.evaluate(() => window.__probeCommits) - base;
  ok(midPan !== start.centerX, "mid-drag the interior centre is already previewing (live, not on release)");
  ok(midCommits === 0, `NO document commit during the drag — the preview is undo-free (got ${midCommits})`);
  ok(panCommits === 1, `the whole 5-move pan is ONE undo unit (got ${panCommits})`);
  ok(panned.centerX !== start.centerX && panned.centerY !== start.centerY,
    `the WIDGET's own stored centre moved (${start.centerX},${start.centerY} → ${panned.centerX},${panned.centerY})`);
  await page.screenshot({ path: `${shots}/5-after-pan.png` });

  // ZOOM: N wheel ticks = ONE undo unit (a wheel has no "up", so an idle ends it).
  await page.evaluate(() => { window.__probeCommits = 0; });
  const at = await worldToPage(SPOT_CX, SPOT_CY);
  await page.mouse.move(at.x, at.y);
  for (let i = 0; i < WHEEL_TICKS; i += 1) {
    await page.mouse.wheel({ deltaY: WHEEL_DELTA });
    await sleep(30);
  }
  const midZoomCommits = await page.evaluate(() => window.__probeCommits);
  await sleep(ZOOM_IDLE_WAIT_MS);
  const zoomCommits = await page.evaluate(() => window.__probeCommits);
  const zoomed = await stored(mbId, "zoomExponent");
  ok(midZoomCommits === 0, `no commit while the wheel is still turning (got ${midZoomCommits})`);
  ok(zoomCommits === 1, `${WHEEL_TICKS} wheel ticks = ONE undo unit (got ${zoomCommits})`);
  ok(zoomed !== start.zoomExponent, `the widget's own zoomExponent changed with the wheel (${start.zoomExponent} → ${zoomed})`);
  await page.screenshot({ path: `${shots}/6-after-zoom.png` });

  // ONE undo reverts the WHOLE zoom gesture, and only it.
  await page.evaluate(() => window.__powerrp_app.undo());
  await sleep(SETTLE_MS);
  ok(await stored(mbId, "zoomExponent") === start.zoomExponent, "one undo reverts the ENTIRE zoom gesture");
  ok(await stored(mbId, "centerX") === panned.centerX, "that same undo does NOT also revert the earlier pan (separate units)");
  await page.evaluate(() => window.__powerrp_app.redo());
  await sleep(SETTLE_MS);

  // The view is DOCUMENT state, so a reload / CLI render / export agrees with it.
  const inDoc = await page.evaluate((id) => {
    const doc = JSON.parse(JSON.stringify(window.__powerrp_app.doc));
    return doc.slides[0].delta.items[id] ?? {};
  }, mbId);
  ok(inDoc.zoomExponent === await stored(mbId, "zoomExponent"), `the explored view is stored IN THE DOCUMENT (slide delta zoomExponent = ${inDoc.zoomExponent})`);
  ok(inDoc.centerX === await stored(mbId, "centerX"), `and so is the panned centre (slide delta centerX = ${inDoc.centerX})`);
  ok(Math.abs(await page.evaluate(() => window.__powerrp_app.lastViewport?.zoom ?? 1) - 1) < 1e-9, "the CANVAS zoom is untouched by interior zooming");

  await page.keyboard.press("Escape");
  await sleep(SETTLE_MS);
  ok(await modeId() === null, "Escape exits the mode");

  ok(liveErrors.length === 0, `no console errors during the whole run (${JSON.stringify(liveErrors)})`);
} finally {
  await browser.close();
  await server.close();
}

const failed = checks.filter(([pass]) => !pass);
for (const [pass, label] of checks) console.log(`${pass ? "PASS" : "FAIL"} — ${label}`);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed. Screenshots in ${shots}`);
if (failed.length) {
  console.log(errors.join("\n"));
  process.exit(1);
}
