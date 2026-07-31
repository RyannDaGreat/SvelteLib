/**
 * PALETTE SCROLL-FOLLOWS-CURSOR PROBE (task palscroll_) — proves the feature
 * the user asked for verbatim: "As I'm scrolling in the command palette,
 * what's under my cursor should update. That way I can scroll through things
 * and read them as I'm scrolling instead of having to move my mouse every
 * time to hover on what's under it."
 *
 * Mechanism under test (web/CommandPalette.svelte): the list remembers the
 * last real pointer position (pointermove), and on its OWN scroll event
 * re-hit-tests via elementFromPoint, adopting the row now under that point
 * through the SAME `highlighted` variable a real hover would set — so the
 * existing preview effect (theme rows previewing on `highlighted`, proved by
 * tests/theme_preview_probe.js) composes for free rather than being
 * special-cased. The re-hit-test only fires within a short window after a
 * REAL wheel/touchmove on the list, which is what stops a KEYBOARD-driven
 * scrollIntoView from stealing the highlight back from the arrow keys.
 *
 * Scenarios:
 *   1. Mouse stationary over the list, dispatch wheel scrolls -> highlighted
 *      becomes the row now under the cursor, and keeps tracking across
 *      further scrolls (not just the first one).
 *   2. Arrow-key navigation scrolls the list programmatically with the mouse
 *      left stationary over an earlier row -> highlighted stays the
 *      KEYBOARD's row, not the mouse's.
 *   3. A previewable row (a theme family) scrolled under the stationary
 *      cursor triggers its live preview, and the preview reverts when the
 *      palette closes.
 *
 * Spawns its own isolated Vite + headless Chromium (swiftshader), same
 * pattern as theme_preview_probe.js. Run from POWERRP or the SvelteLib root.
 */
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(HERE, "../web");

const { createServer } = await import("vite");
const server = await createServer({ configFile: resolve(webRoot, "vite.config.js"), server: { port: 0, open: false, host: "127.0.0.1", hmr: false, watch: null } });
await server.listen();
const baseUrl = `http://127.0.0.1:${server.httpServer.address().port}`;

const { launchBrowser } = await import("./puppeteerLaunch.js");
const browser = await launchBrowser();

const fails = [];
const errors = [];
const assert = (cond, msg) => { if (!cond) { fails.push(msg); console.log(`  FAIL ${msg}`); } else { console.log(`  ok   ${msg}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  // "Manifest: Line: 1, column: 1, Syntax error" is Chrome parsing web/index.html's
  // <link rel="manifest"> (in-flight PWA work, task offline_ — not this probe's
  // concern; theme_preview_probe.js predates that file and does not filter it,
  // which is exactly why it also aborts standalone without a backend today).
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource|thumbnail|\/api\/thumb|no WebGPU adapter|WebGPU init failed|Manifest: Line/i.test(m.text())) errors.push(`console.error: ${m.text()}`); });

  await page.goto(`${baseUrl}/`, { waitUntil: "networkidle0" });
  await page.waitForFunction(() => window.__powerrp_app != null, { timeout: 60000 });
  await sleep(400);
  if (errors.length) { console.error("BOOT ERRORS:\n" + errors.join("\n")); process.exit(1); }

  const openPalette = async () => {
    await page.evaluate(() => (window.__powerrp_app.paletteOpen = true));
    await page.waitForSelector(".palette input", { timeout: 4000 });
    await sleep(120);
  };
  const closePalette = async () => { await page.evaluate(() => (window.__powerrp_app.paletteOpen = false)); await sleep(120); };
  const typeQuery = async (text) => { await page.type(".palette input", text); await sleep(140); };
  const pressKey = async (key) => { await page.keyboard.press(key); await sleep(140); };
  // Empty query at the top level lists every command — deep enough to overflow
  // .palette-results' max-height (--a-palette-max-h, 240px) so there is
  // something to scroll. "color theme" then Enter drills into the themes
  // submenu, whose family rows are ALSO previewable (scenario 3 needs that).
  const enterThemeSubmenu = async () => { await typeQuery("color theme"); await pressKey("Enter"); await sleep(140); };

  const highlightedTitle = () => page.evaluate(() => document.querySelector(".palette-item.highlighted .title")?.textContent?.trim() ?? null);
  const rowCount = () => page.$$eval(".palette-item", (els) => els.length);
  const listMetrics = () => page.evaluate(() => {
    const el = document.querySelector(".palette-results");
    return { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
  });
  const rowCenter = async (i) => {
    const rows = await page.$$(".palette-item");
    const box = await rows[i].boundingBox();
    if (!box) return null;
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  };
  const rowIndexUnderPoint = (x, y) => page.evaluate(({ x, y }) => {
    const el = document.elementFromPoint(x, y)?.closest(".palette-item");
    if (!el) return -1;
    return [...document.querySelectorAll(".palette-item")].indexOf(el);
  }, { x, y });

  // ── Scenario 1: wheel scroll under a stationary mouse tracks the cursor ────
  await openPalette();
  {
    const n = await rowCount();
    assert(n > 15, `top-level list has enough rows to scroll (n=${n})`);
    const before = await listMetrics();
    assert(before.scrollHeight > before.clientHeight, `list overflows its box (scrollHeight=${before.scrollHeight} clientHeight=${before.clientHeight})`);

    // Park the real mouse over a row in the middle of the visible viewport and
    // leave it there — every later "movement" of the highlight in this
    // scenario must come from scroll re-hit-testing, never from the mouse.
    const parkAt = await rowCenter(2);
    assert(!!parkAt, "found a row to park the mouse over");
    await page.mouse.move(parkAt.x, parkAt.y);
    await sleep(80);
    const initialIdxUnderMouse = await rowIndexUnderPoint(parkAt.x, parkAt.y);
    const initialTitle = await highlightedTitle();
    assert(initialTitle !== null, `hover set an initial highlight (title=${initialTitle})`);

    // Dispatch a real wheel event at that exact point — CDP Input.dispatchMouseEvent
    // with type "mouseWheel" is what Puppeteer's page.mouse.wheel sends, and it
    // fires a genuine `wheel` DOM event without moving the pointer, exactly the
    // browser behavior the mechanism is built around.
    await page.mouse.wheel({ deltaY: 220 });
    await sleep(180);
    const afterScroll1 = await listMetrics();
    assert(afterScroll1.scrollTop > before.scrollTop, `first wheel actually scrolled the list (scrollTop ${before.scrollTop} -> ${afterScroll1.scrollTop})`);
    const rowNowUnderMouse1 = await rowIndexUnderPoint(parkAt.x, parkAt.y);
    const titleAfter1 = await highlightedTitle();
    const expectedTitle1 = await page.evaluate((i) => document.querySelectorAll(".palette-item")[i]?.querySelector(".title")?.textContent?.trim() ?? null, rowNowUnderMouse1);
    assert(rowNowUnderMouse1 !== initialIdxUnderMouse, `the row under the stationary cursor actually changed after scrolling (was idx ${initialIdxUnderMouse}, now ${rowNowUnderMouse1})`);
    assert(titleAfter1 === expectedTitle1 && titleAfter1 !== initialTitle,
      `highlight followed the cursor to the NEW row under it without any mouse movement (before="${initialTitle}" after="${titleAfter1}" expected="${expectedTitle1}")`);

    // Scroll again — continued tracking, not a one-shot correction.
    await page.mouse.wheel({ deltaY: 220 });
    await sleep(180);
    const afterScroll2 = await listMetrics();
    assert(afterScroll2.scrollTop > afterScroll1.scrollTop, `second wheel scrolled further (scrollTop ${afterScroll1.scrollTop} -> ${afterScroll2.scrollTop})`);
    const rowNowUnderMouse2 = await rowIndexUnderPoint(parkAt.x, parkAt.y);
    const titleAfter2 = await highlightedTitle();
    const expectedTitle2 = await page.evaluate((i) => document.querySelectorAll(".palette-item")[i]?.querySelector(".title")?.textContent?.trim() ?? null, rowNowUnderMouse2);
    assert(titleAfter2 === expectedTitle2 && titleAfter2 !== titleAfter1,
      `highlight CONTINUED tracking across a second scroll (after1="${titleAfter1}" after2="${titleAfter2}" expected="${expectedTitle2}")`);
  }
  await closePalette();

  // ── Scenario 2: keyboard scroll must not let the stationary mouse steal it ─
  await openPalette();
  {
    // Park the mouse over an EARLY row, then arrow down far enough that the
    // list scrolls that row out from under the cursor entirely (ArrowDown's
    // scrollIntoView is programmatic — no wheel/touch event fires for it).
    const parkAt = await rowCenter(1);
    await page.mouse.move(parkAt.x, parkAt.y);
    await sleep(80);
    const mouseRowTitle = await highlightedTitle();
    assert(mouseRowTitle !== null, `mouse hover set an initial highlight (title=${mouseRowTitle})`);

    // Hovering row 1 above already set highlighted=1 (real hover, not yet
    // arrow-driven) — so ARROW_PRESSES lands at 1 + ARROW_PRESSES, not at
    // ARROW_PRESSES itself. Deriving the expectation from that starting point
    // (rather than assuming a start of 0) is what keeps this assertion
    // non-brittle.
    const startIdx = await page.evaluate(() => [...document.querySelectorAll(".palette-item")].findIndex((el) => el.classList.contains("highlighted")));
    const ARROW_PRESSES = 25; // enough to scroll the list at 240px/~28px rows
    for (let i = 0; i < ARROW_PRESSES; i += 1) await page.keyboard.press("ArrowDown");
    await sleep(200);

    const metrics = await listMetrics();
    assert(metrics.scrollTop > 0, `arrowing down actually scrolled the list (scrollTop=${metrics.scrollTop})`);
    const rowNowUnderMouse = await rowIndexUnderPoint(parkAt.x, parkAt.y);
    const rowUnderMouseTitle = rowNowUnderMouse >= 0
      ? await page.evaluate((i) => document.querySelectorAll(".palette-item")[i]?.querySelector(".title")?.textContent?.trim() ?? null, rowNowUnderMouse)
      : null;
    const keyboardTitle = await highlightedTitle();
    const keyboardIdx = await page.evaluate(() => [...document.querySelectorAll(".palette-item")].findIndex((el) => el.classList.contains("highlighted")));
    const expectedIdx = startIdx + ARROW_PRESSES;
    assert(keyboardIdx === expectedIdx, `keyboard highlight is at the row arrowed to (idx=${keyboardIdx}, expected ${expectedIdx} = start ${startIdx} + ${ARROW_PRESSES} presses)`);
    assert(rowUnderMouseTitle !== keyboardTitle || rowNowUnderMouse < 0,
      `stationary-mouse row ("${rowUnderMouseTitle}") differs from the keyboard row ("${keyboardTitle}") — programmatic scroll did not steal the highlight`);
    assert(keyboardTitle === mouseRowTitle ? false : true, `sanity: keyboard moved off the original mouse row ("${mouseRowTitle}" -> "${keyboardTitle}")`);
  }
  await closePalette();

  // ── Scenario 3: a previewable row scrolled under the cursor previews live,
  //      and reverts when the palette closes. ────────────────────────────────
  await openPalette();
  await enterThemeSubmenu(); // family rows here are previewable (theme_preview_probe.js)
  {
    const applied = () => page.evaluate(() => ({ attr: document.documentElement.dataset.theme, stored: localStorage.getItem("powerrp.theme") }));
    const original = await applied();

    const n = await rowCount();
    assert(n > 8, `theme submenu has enough family rows to scroll (n=${n})`);
    const parkAt = await rowCenter(0);
    await page.mouse.move(parkAt.x, parkAt.y);
    await sleep(80);
    const rowIdxBefore = await rowIndexUnderPoint(parkAt.x, parkAt.y);
    const themeBefore = await applied();

    await page.mouse.wheel({ deltaY: 300 });
    await sleep(220);
    const rowIdxAfter = await rowIndexUnderPoint(parkAt.x, parkAt.y);
    assert(rowIdxAfter !== rowIdxBefore, `scrolling moved a different family row under the cursor (idx ${rowIdxBefore} -> ${rowIdxAfter})`);
    const themeAfter = await applied();
    assert(themeAfter.attr !== themeBefore.attr, `the newly-scrolled-under row PREVIEWED live (theme ${themeBefore.attr} -> ${themeAfter.attr})`);
    assert(themeAfter.stored === original.stored, `the scroll-driven preview did NOT persist (stored still "${themeAfter.stored}")`);

    await closePalette();
    const reverted = await applied();
    assert(reverted.attr === original.attr && reverted.stored === original.stored,
      `closing reverted the scroll-triggered preview back to "${original.attr}" (attr=${reverted.attr}, stored=${reverted.stored})`);
  }

  if (fails.length) {
    console.error(`PALETTE SCROLL-FOLLOW PROBE FAILURES (${fails.length}):\n` + fails.join("\n"));
    process.exit(1);
  }
  console.log("Palette scroll-follow probe passed: all scenarios green.");
} finally {
  await browser.close();
  await server.close();
}
