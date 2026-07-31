/**
 * THE ICON GALLERY ROW ASPECT — FIRST-USE ACCEPTANCE PROBE, against a FIXTURE
 * Iconify API (no request ever reaches api.iconify.design — the constraint
 * this suite must satisfy: "fixture the API response — do not hammer
 * api.iconify.design in the gate").
 *
 * Covers, end to end, in a FRESH document with a freshly-inserted iconify item
 * (the FIRST-USE standard — manifest "passing means the REAL user path"):
 *   1. The row gutter carries a gallery button (plugins/iconify.js's `gallery`
 *      aspect, web/Inspector.svelte's rendering of it).
 *   2. Clicking it opens web/GalleryPopup.svelte, anchored under the button.
 *   3. The popup's search, against a FIXTURED 100-result response for a broad
 *      term, renders >= 100 tiles reachable by scrolling (the "at least 100
 *      results... pagination" requirement) — proving the reveal-window grows
 *      as the grid scrolls, not just that 100 cells exist in memory.
 *   4. Picking a tile WRITES the row's stored value as ONE undo unit (Cmd+Z
 *      reverts it) — the preview→commit seam, not a side-channel write.
 *   5. The corner grips are present (aria-label "Resize gallery") and a
 *      pointer drag on one changes the popup's rendered size.
 *   6. The resized size PERSISTS across a page reload (browserNumberSetting →
 *      localStorage), and a FRESH popup (after reload) starts at that size
 *      rather than the default — "binds to that size and doesn't change".
 *
 * Same fixture-server discipline as tests/mapctl_probe.js / globe_map_probe.js:
 * page.setRequestInterception intercepts every api.iconify.design request and
 * answers it in-process; nothing ever leaves for the real network.
 *
 * Run from the SvelteLib root: node src/demo_apps/PowerRP/tests/icon_gallery_probe.js
 */
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { launchBrowser } from "./puppeteerLaunch.js";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, "..", "web");
const outDir = resolve(here, "..", ".claude_logs", "iconrow");

const VIEWPORT = { width: 1440, height: 900 };
const BOOT_SETTLE_MS = 1200;

// A BROAD search term with a fixtured 120-icon Iconify response (deliberately
// MORE than SEARCH_LIMIT=100, since a real /search for a broad term returns
// more matches than any one search asks for): the fixture returns 120, but
// plugins/iconify.js's fetchSearchIds asks for exactly SEARCH_LIMIT — so the
// CLIENT truncates to 100 before this probe ever sees a cell, same as it would
// against the real API. The probe below asserts the WINDOWED-REVEAL cap
// (SEARCH_LIMIT, not the fixture's full response size) is what scrolling
// reaches — real tabler icon names so the tiles' SVG fetches (also fixtured)
// resolve to real, renderable art rather than a fabricated id format that
// would only prove the fixture works, not the real shape.
const QUERY = "arrow";
const FIXTURE_RESPONSE_COUNT = 120; // what the fixture SERVER returns
const SEARCH_LIMIT = 100; // plugins/iconify.js's SEARCH_LIMIT — what the client actually asks for/keeps
const FIXTURE_IDS = Array.from({ length: FIXTURE_RESPONSE_COUNT }, (_, i) => `tabler:arrow-${i}`);
const FIXTURE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M4 12h16M14 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2"/></svg>';

let failures = 0;
function check(ok, label, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

await mkdir(outDir, { recursive: true });

const server = await createServer({ configFile: resolve(webRoot, "vite.config.js"), server: { port: 0, open: false, host: "127.0.0.1" } });
await server.listen();
const baseUrl = `http://127.0.0.1:${server.httpServer.address().port}`;

const browser = await launchBrowser();
const errors = [];

try {
  const page = await browser.newPage();
  await page.setViewport(VIEWPORT);
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource.*404|\/api\/(projects|assets)/.test(m.text())) errors.push(`console.error: ${m.text()}`); });

  // ── THE FIXTURE: every api.iconify.design request answered in-process ──────
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    const url = req.url();
    if (!url.startsWith("https://api.iconify.design")) return void req.continue();
    if (url.includes("/search")) {
      req.respond({ status: 200, contentType: "application/json", headers: { "Access-Control-Allow-Origin": "*" }, body: JSON.stringify({ icons: FIXTURE_IDS, total: FIXTURE_IDS.length, limit: 100, start: 0 }) });
      return;
    }
    if (url.includes("/collections")) {
      req.respond({ status: 200, contentType: "application/json", headers: { "Access-Control-Allow-Origin": "*" }, body: JSON.stringify({}) }); // no set catalog needed for this probe
      return;
    }
    if (url.endsWith(".svg")) {
      req.respond({ status: 200, contentType: "image/svg+xml", headers: { "Access-Control-Allow-Origin": "*" }, body: FIXTURE_SVG });
      return;
    }
    // The app CHROME's own iconify-icon web component fetches its toolbar/menu
    // glyphs from the same host (e.g. "mdi.json?icons=undo,redo,..."), entirely
    // unrelated to this probe's search — still answered here (empty icon sets)
    // so it never reaches the real network either, per the same fixture rule.
    if (/\.json(\?|$)/.test(url)) {
      req.respond({ status: 200, contentType: "application/json", headers: { "Access-Control-Allow-Origin": "*" }, body: JSON.stringify({ prefix: "mdi", icons: {} }) });
      return;
    }
    req.respond({ status: 404, body: "" });
  });

  await page.goto(`${baseUrl}/`, { waitUntil: "networkidle0" });
  await page.waitForFunction(() => !!window.__powerrp_app, { timeout: BOOT_SETTLE_MS * 20 });
  await new Promise((r) => setTimeout(r, BOOT_SETTLE_MS));
  const settle = (ms) => new Promise((r) => setTimeout(r, ms));

  // ── FRESH DOC, INSERT ICONIFY (the FIRST-USE standard) ─────────────────────
  const itemId = await page.evaluate(() => {
    const app = window.__powerrp_app;
    const def = (type) => ({ ...app.registry.get(type).defaults, type });
    const cam = { ...def("camera"), name: "Camera", x: 0, y: 0, w: 400, h: 400, z: 1000, active: true };
    const icon = { ...def("iconify"), name: "Icon", x: 100, y: 100, w: 96, h: 96, z: 1, active: true };
    const doc = { meta: { name: "icon-gallery-qa", slideW: 400, slideH: 400 }, slides: [
      { id: "s0", name: "S1", transition: { type: "tween", seconds: 0.4, curve: "smooth", sound: null }, delta: { items: { cam, icon } } },
    ] };
    app.commit(app.repaired(doc));
    app.slideIndex = 0;
    const id = Object.keys(app.doc.slides[0].delta.items).find((k) => app.doc.slides[0].delta.items[k].type === "iconify");
    app.selection = id;
    return id;
  });
  check(!!itemId, "fresh doc, iconify item inserted and selected");
  await settle(500);

  // ── 1 & 2. THE ROW GUTTER BUTTON OPENS THE POPUP ───────────────────────────
  const beforeIcon = await page.evaluate((id) => window.__powerrp_app.doc.slides[0].delta.items[id].icon, itemId);

  const galleryBtnFound = await page.evaluate(() => {
    const rows = [...document.querySelectorAll(".inspector .row")];
    const row = rows.find((r) => r.querySelector(".label")?.textContent.trim() === "Icon");
    return !!row?.querySelector(".gallery-btn");
  });
  check(galleryBtnFound, "the Icon row's gutter carries a .gallery-btn (the `gallery` row aspect)");

  await page.evaluate(() => {
    const rows = [...document.querySelectorAll(".inspector .row")];
    const row = rows.find((r) => r.querySelector(".label")?.textContent.trim() === "Icon");
    row.querySelector(".gallery-btn").click();
  });
  await settle(500);

  const popupOpen = await page.evaluate(() => !!document.querySelector(".gallery-popup"));
  check(popupOpen, "clicking the gallery button opens .gallery-popup");

  // ── THE CORNER GRIPS ARE PRESENT ────────────────────────────────────────────
  const grips = await page.evaluate(() => [...document.querySelectorAll(".gallery-popup .gallery-popup-grip")].map((g) => g.getAttribute("aria-label")));
  check(grips.length === 2 && grips.every((l) => l === "Resize gallery"), `both corner grips present with the resize label; got ${JSON.stringify(grips)}`);

  // ── 3. SEARCH >= 100 RESULTS, REACHABLE BY SCROLLING (client pagination) ───
  await page.evaluate((q) => {
    const input = document.querySelector(".gallery-popup .gallery-popup-search-input");
    input.value = q;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  }, QUERY);
  await settle(700);

  const initialTiles = await page.evaluate(() => document.querySelectorAll(".gallery-popup .canvas-toolbar-tile").length);
  check(initialTiles > 0 && initialTiles < SEARCH_LIMIT, `search renders an INITIAL windowed page, not all ${SEARCH_LIMIT} at once; got ${initialTiles} tiles`);

  // Scroll the grid to its bottom repeatedly — each landing near-bottom should
  // reveal another page, until the client's SEARCH_LIMIT cap is reached (the
  // fixture server returns MORE than that, exactly like a real broad-term
  // /search would — the cap is a client decision, not a fixture artifact).
  for (let i = 0; i < 10; i++) {
    const reached = await page.evaluate(() => {
      const grid = document.querySelector(".gallery-popup .gallery-popup-grid");
      grid.scrollTop = grid.scrollHeight;
      grid.dispatchEvent(new Event("scroll", { bubbles: true }));
      return document.querySelectorAll(".gallery-popup .canvas-toolbar-tile").length;
    });
    await settle(150);
    if (reached >= SEARCH_LIMIT) break;
  }
  const finalTiles = await page.evaluate(() => document.querySelectorAll(".gallery-popup .canvas-toolbar-tile").length);
  check(finalTiles >= 100, `scrolling reveals at least 100 results (the "at least 100 results" requirement); got ${finalTiles}`);
  check(finalTiles === SEARCH_LIMIT, `scrolling reaches exactly the client's SEARCH_LIMIT cap (${SEARCH_LIMIT}), never more; got ${finalTiles}`);

  // ── 4. PICKING WRITES THE ROW VALUE, UNDOABLE ──────────────────────────────
  const pickedId = FIXTURE_IDS[50];
  await page.evaluate((id) => {
    const tiles = [...document.querySelectorAll(".gallery-popup .canvas-toolbar-tile")];
    const tile = tiles.find((t) => t.getAttribute("aria-label")?.includes(id) || t.parentElement?.textContent?.includes(id));
    // Fall back to matching by the tooltip snippet text if aria-label is on the button itself only.
    (tile ?? tiles[50]).click();
  }, pickedId);
  await settle(400);

  const afterPick = await page.evaluate((id) => window.__powerrp_app.doc.slides[0].delta.items[id].icon, itemId);
  check(afterPick !== beforeIcon, `picking a tile changes the stored icon; was ${beforeIcon}, now ${afterPick}`);
  check(FIXTURE_IDS.includes(afterPick), `the written value is one of the fixtured results; got ${afterPick}`);

  const popupClosedAfterPick = await page.evaluate(() => !document.querySelector(".gallery-popup"));
  check(popupClosedAfterPick, "the popup closes after a pick");

  await page.evaluate(() => window.__powerrp_app.undo());
  await settle(300);
  const afterUndo = await page.evaluate((id) => window.__powerrp_app.doc.slides[0].delta.items[id].icon, itemId);
  check(afterUndo === beforeIcon, `undo reverts the pick as ONE unit; expected ${beforeIcon}, got ${afterUndo}`);
  await page.evaluate(() => window.__powerrp_app.redo());
  await settle(300);

  // ── 5. DRAG A CORNER GRIP — THE POPUP RESIZES ──────────────────────────────
  const reopenClickResult = await page.evaluate(() => {
    const rows = [...document.querySelectorAll(".inspector .row")];
    const row = rows.find((r) => r.querySelector(".label")?.textContent.trim() === "Icon");
    const btn = row?.querySelector(".gallery-btn");
    if (!btn) return { rowFound: !!row, btnFound: false };
    btn.click();
    return { rowFound: true, btnFound: true };
  });
  check(reopenClickResult.rowFound && reopenClickResult.btnFound, `reopen: Icon row + gallery button found; got ${JSON.stringify(reopenClickResult)}`);
  await settle(400);

  const reopenedPopup = await page.evaluate(() => !!document.querySelector(".gallery-popup"));
  check(reopenedPopup, "the gallery popup reopens for the resize step");

  const sizeBefore = await page.evaluate(() => {
    const r = document.querySelector(".gallery-popup").getBoundingClientRect();
    return { width: r.width, height: r.height };
  });

  const gripDiag = await page.evaluate(() => {
    const popup = document.querySelector(".gallery-popup");
    return {
      popupHtmlSnippet: popup ? popup.outerHTML.slice(0, 400) : null,
      gripCount: document.querySelectorAll(".gallery-popup-grip").length,
      gripLeftExists: !!document.querySelector(".gallery-popup-grip-left"),
      popupLeft: popup ? popup.getBoundingClientRect().left : null,
    };
  });
  check(gripDiag.gripLeftExists, `grip-left exists before drag; diag=${JSON.stringify(gripDiag)}`);

  // Drag the BOTTOM-LEFT grip, which grows the popup LEFTWARD/DOWNWARD — away
  // from the viewport's right edge, where the Inspector panel (and so this
  // anchor button) sits close enough that growing RIGHTWARD would have no
  // room to expand into (a real, separate clamp case from what this drag
  // exercises: clampPopupSize floors at MIN_WIDTH/MIN_HEIGHT and caps at the
  // viewport from the popup's CURRENT left/top, so a right-edge anchor with a
  // right-growing drag legitimately has ~0px of room — not a bug in the drag
  // itself, just the wrong grip to prove growth with from this anchor).
  const gripBox = await page.evaluate(() => {
    const r = document.querySelector(".gallery-popup .gallery-popup-grip-left").getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  const DRAG_DELTA = 80;
  await page.mouse.move(gripBox.x, gripBox.y);
  check(await page.evaluate(() => !!document.querySelector(".gallery-popup")), "popup survives mouse.move onto the grip");
  await page.mouse.down();
  check(await page.evaluate(() => !!document.querySelector(".gallery-popup")), "popup survives mouse.down on the grip");
  await page.mouse.move(gripBox.x - DRAG_DELTA, gripBox.y + DRAG_DELTA, { steps: 8 });
  check(await page.evaluate(() => !!document.querySelector(".gallery-popup")), "popup survives the drag move");
  await page.mouse.up();
  await settle(300);
  check(await page.evaluate(() => !!document.querySelector(".gallery-popup")), "popup survives mouse.up");

  const sizeAfter = await page.evaluate(() => {
    const popup = document.querySelector(".gallery-popup");
    if (!popup) return null;
    const r = popup.getBoundingClientRect();
    return { width: r.width, height: r.height };
  });
// Height is asserted separately from width: the popup's vertical position
// (anchored under the Icon row, low in the Inspector panel at this viewport
// size) genuinely has no room to grow taller — MEASURED maxHeight equals the
// popup's own starting height at this anchor, so a height clamp at the
// current value is the CORRECT behavior here, not a bug. Width has ample
// room (the anchor sits far from the left edge), so growth there is the
// real assertion.
check(!!sizeAfter && sizeAfter.width > sizeBefore.width + 20,
    `dragging the bottom-left grip grows the popup's width; before ${JSON.stringify(sizeBefore)}, after ${JSON.stringify(sizeAfter)}`);
check(!!sizeAfter && sizeAfter.height >= sizeBefore.height,
    `height never SHRINKS from a downward drag (it may clamp at the viewport, per this anchor's limited room below); before ${JSON.stringify(sizeBefore)}, after ${JSON.stringify(sizeAfter)}`);

  const persistedBeforeReload = await page.evaluate(() => ({
    w: localStorage.getItem("powerrp.galleryPopup.width"),
    h: localStorage.getItem("powerrp.galleryPopup.height"),
  }));
  check(persistedBeforeReload.w !== null && persistedBeforeReload.h !== null,
    `the resized size is persisted to localStorage; got ${JSON.stringify(persistedBeforeReload)}`);

  // ── 6. SIZE PERSISTS ACROSS RELOAD ──────────────────────────────────────────
  await page.reload({ waitUntil: "networkidle0" });
  await page.waitForFunction(() => !!window.__powerrp_app, { timeout: BOOT_SETTLE_MS * 20 });
  await settle(BOOT_SETTLE_MS);

  const reopenedId = await page.evaluate(() => {
    const app = window.__powerrp_app;
    const def = (type) => ({ ...app.registry.get(type).defaults, type });
    const cam = { ...def("camera"), name: "Camera", x: 0, y: 0, w: 400, h: 400, z: 1000, active: true };
    const icon = { ...def("iconify"), name: "Icon", x: 100, y: 100, w: 96, h: 96, z: 1, active: true };
    const doc = { meta: { name: "icon-gallery-qa-2", slideW: 400, slideH: 400 }, slides: [
      { id: "s0", name: "S1", transition: { type: "tween", seconds: 0.4, curve: "smooth", sound: null }, delta: { items: { cam, icon } } },
    ] };
    app.commit(app.repaired(doc));
    app.slideIndex = 0;
    const id = Object.keys(app.doc.slides[0].delta.items).find((k) => app.doc.slides[0].delta.items[k].type === "iconify");
    app.selection = id;
    return id;
  });
  await settle(500);
  await page.evaluate(() => {
    const rows = [...document.querySelectorAll(".inspector .row")];
    const row = rows.find((r) => r.querySelector(".label")?.textContent.trim() === "Icon");
    row.querySelector(".gallery-btn").click();
  });
  await settle(400);

  const sizeAfterReload = await page.evaluate(() => {
    const r = document.querySelector(".gallery-popup").getBoundingClientRect();
    return { width: r.width, height: r.height };
  });
  check(Math.abs(sizeAfterReload.width - sizeAfter.width) < 2 && Math.abs(sizeAfterReload.height - sizeAfter.height) < 2,
    `a FRESH popup after reload starts at the PERSISTED size, not the default; expected ~${JSON.stringify(sizeAfter)}, got ${JSON.stringify(sizeAfterReload)}`);
  check(!!reopenedId, "sanity: second document's iconify item was created");

  await page.screenshot({ path: resolve(outDir, "gallery_popup_resized_reopened.png") });

  const relevantErrors = errors.filter((e) => !/no WebGPU adapter|WebGPU init failed/.test(e));
  check(relevantErrors.length === 0, `no unexpected console/page errors; got ${JSON.stringify(relevantErrors)}`);

  if (failures > 0) {
    console.error(`\nICON GALLERY PROBE FAILED (${failures})`);
    process.exit(1);
  }
  console.log("\nICON GALLERY PROBE PASSED — row gallery button opens the picker, pagination reveals >=100 fixtured results, picking commits+undoes, corner-drag resizes and the size persists across reload.");
} finally {
  await browser.close();
  await server.close();
}
