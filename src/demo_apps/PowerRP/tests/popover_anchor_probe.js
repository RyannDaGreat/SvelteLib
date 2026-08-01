/**
 * POPOVER ANCHOR-FOLLOW probe — the behaviour src/lib/popover.js's
 * `trackAnchoredSurface` exists to guarantee, measured in the real app.
 *
 * THE BUG THIS PINS, and why prose could not catch it. A floating surface that
 * is anchored to a button inside a SCROLLING PANE must follow that button when
 * the pane scrolls — the alternative, closing on scroll, was measured to tear the
 * surface down on the pane's own spurious open-time scroll, so src/lib/Dropdown
 * chose to follow and every later surface copied that choice. Copying it is where
 * it went wrong: web/GalleryPopup.svelte registered the handler as
 * `<svelte:window onscroll={…}>`, which Svelte compiles to
 * `window.addEventListener("scroll", h)` with NO capture option. A scroll event
 * fired by an element does not bubble, so a bubble-phase window listener sees
 * only the document scrolling — and this app scrolls panes, not the document.
 * The popup therefore stayed frozen in place while its anchor slid away, which
 * looks like a rendering quirk and reads, in the source, like working code.
 * Dropdown had the reason written down in a comment; the copy lost it.
 *
 * WHY A PROBE AND NOT ONLY THE BAN TEST. tests/popover_reinvention_ban_test.js
 * bans the bubble-phase SPELLING, which is cheap and catches a re-introduction by
 * grep. It cannot prove the surface actually tracks — a correctly-phased listener
 * wired to the wrong element, or a reposition that reads a stale rect, would pass
 * it. This measures the pixels: scroll the Inspector, and the popup's top edge
 * must move by the same delta as its anchor button's.
 *
 * FIXTURE DISCIPLINE, same as tests/icon_gallery_probe.js: every
 * api.iconify.design request is answered in-process. Nothing leaves for the real
 * network.
 *
 * Run from the SvelteLib root: node src/demo_apps/PowerRP/tests/popover_anchor_probe.js
 */
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { launchBrowser } from "./puppeteerLaunch.js";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, "..", "web");
const outDir = resolve(here, "..", ".claude_logs", "popoveranchor");

// The viewport is a BALANCE, and both ends of it are load-bearing. It must be
// SHORT enough that the Inspector's property list overflows its pane (no pane
// scroll, nothing to follow) and TALL enough that the popup is not jammed
// against popupPosition's own viewport clamp (a clamped popup cannot move, so a
// working implementation and the frozen bug measure identically). At 600px the
// second condition failed: the 360px popup pinned at top 234 and the probe could
// prove nothing. Both conditions are asserted below rather than assumed.
const VIEWPORT = { width: 1280, height: 1000 };
const BOOT_SETTLE_MS = 1200;

// How far to scroll the pane. Large enough that a frozen popup is unmistakable
// (the tolerance below is 2px), small enough not to scroll the anchor out of the
// pane entirely, which would be a different situation.
const SCROLL_BY = 120;
// Sub-pixel rounding between a fixed box's style and its measured rect.
const TRACK_TOLERANCE_PX = 2;
// How much an ancestor must overflow before the walk accepts it as THE pane.
// Anything less catches an inline label wrapper that overflows by a hairline.
const PANE_MIN_OVERFLOW_PX = 200;

const FIXTURE_IDS = Array.from({ length: 24 }, (_, i) => `tabler:arrow-${i}`);
const FIXTURE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M4 12h16" fill="none" stroke="currentColor" stroke-width="2"/></svg>';

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

  await page.setRequestInterception(true);
  page.on("request", (req) => {
    const url = req.url();
    if (!url.startsWith("https://api.iconify.design")) return void req.continue();
    const json = (body) => req.respond({ status: 200, contentType: "application/json", headers: { "Access-Control-Allow-Origin": "*" }, body: JSON.stringify(body) });
    if (url.includes("/search")) return void json({ icons: FIXTURE_IDS, total: FIXTURE_IDS.length, limit: 100, start: 0 });
    if (url.includes("/collections")) return void json({});
    if (url.endsWith(".svg")) return void req.respond({ status: 200, contentType: "image/svg+xml", headers: { "Access-Control-Allow-Origin": "*" }, body: FIXTURE_SVG });
    if (/\.json(\?|$)/.test(url)) return void json({ prefix: "mdi", icons: {} });
    req.respond({ status: 404, body: "" });
  });

  await page.goto(`${baseUrl}/`, { waitUntil: "networkidle0" });
  await page.waitForFunction(() => !!window.__powerrp_app, { timeout: BOOT_SETTLE_MS * 20 });
  const settle = (ms) => new Promise((r) => setTimeout(r, ms));
  await settle(BOOT_SETTLE_MS);

  // A fresh doc with one iconify item selected — the Inspector then shows its
  // full property list, and the Icon row carries the gallery gutter button.
  const itemId = await page.evaluate(() => {
    const app = window.__powerrp_app;
    const def = (type) => ({ ...app.registry.get(type).defaults, type });
    const cam = { ...def("camera"), name: "Camera", x: 0, y: 0, w: 400, h: 400, z: 1000, active: true };
    const icon = { ...def("iconify"), name: "Icon", x: 100, y: 100, w: 96, h: 96, z: 1, active: true };
    app.commit(app.repaired({ meta: { name: "popover-anchor-qa", slideW: 400, slideH: 400 }, slides: [
      { id: "s0", name: "S1", transition: { type: "tween", seconds: 0.4, curve: "smooth", sound: null }, delta: { items: { cam, icon } } },
    ] }));
    app.slideIndex = 0;
    const id = Object.keys(app.doc.slides[0].delta.items).find((k) => app.doc.slides[0].delta.items[k].type === "iconify");
    app.selection = id;
    return id;
  });
  check(!!itemId, "fresh doc with an iconify item selected");
  await settle(600);

  // PARK THE ANCHOR BEFORE OPENING. Order matters and got this wrong once. Find
  // the button's nearest SUBSTANTIALLY scrollable ancestor by walking up and
  // testing its overflow, rather than naming a class: a class name would rot the
  // moment the Inspector's markup changes, and the property under test is "it
  // scrolls", not "it is called X". The overflow floor matters — the first
  // version stopped at a 3px-overflowing inline label wrapper.
  //
  // Park the anchor ONE THIRD down the pane, measured through rects rather than
  // offsetTop (the button's offsetParent is not the pane, so offsetTop is in the
  // wrong coordinate space and left the anchor near the fold). A third down is
  // the window where BOTH of popupPosition's clamps are slack: high enough that
  // the popup opening BELOW the anchor clears the viewport floor, low enough that
  // the test scroll does not push the anchor off the top. Parked at the pane's
  // very top it did, and the popup then correctly clamped to VIEWPORT_MARGIN and
  // tracked half the distance — right behaviour, useless measurement.
  //
  // And this happens BEFORE the popup opens, because a broken build does not
  // reposition on the parking scroll either: the popup would open at the old
  // anchor position, sit at its clamp, and the probe would fail with "cannot
  // measure" instead of "did not track". Both are red, but only one names the bug.
  const parked = await page.evaluate((minOverflow) => {
    const btn = [...document.querySelectorAll(".inspector .row")]
      .find((r) => r.querySelector(".label")?.textContent.trim() === "Icon")
      .querySelector(".gallery-btn");
    let pane = btn.parentElement;
    while (pane && pane.scrollHeight - pane.clientHeight < minOverflow) pane = pane.parentElement;
    if (!pane || pane === document.documentElement) return { ok: false, why: `no ancestor of the gallery button overflows by ${minOverflow}px or more` };
    const paneRect = pane.getBoundingClientRect();
    pane.scrollTop += btn.getBoundingClientRect().top - (paneRect.top + paneRect.height / 3);
    return { ok: true, pane: pane.className.split(" ")[0] };
  }, PANE_MIN_OVERFLOW_PX);
  check(parked.ok, "the gallery button sits inside a pane that really scrolls", parked.why ?? `pane .${parked.pane}`);
  if (!parked.ok) throw new Error(`probe precondition failed: ${parked.why}`);
  await settle(400);

  await page.evaluate(() => {
    const row = [...document.querySelectorAll(".inspector .row")].find((r) => r.querySelector(".label")?.textContent.trim() === "Icon");
    row.querySelector(".gallery-btn").click();
  });
  await settle(600);
  check(await page.evaluate(() => !!document.querySelector(".gallery-popup")), "the gutter button opens .gallery-popup");
  await page.screenshot({ path: resolve(outDir, "popup_before_scroll.png") });

  // THE MEASUREMENT.
  const scrolled = await page.evaluate((by, minOverflow) => {
    const btn = [...document.querySelectorAll(".inspector .row")]
      .find((r) => r.querySelector(".label")?.textContent.trim() === "Icon")
      .querySelector(".gallery-btn");
    let pane = btn.parentElement;
    while (pane && pane.scrollHeight - pane.clientHeight < minOverflow) pane = pane.parentElement;
    const popup = document.querySelector(".gallery-popup").getBoundingClientRect();
    const before = { anchor: btn.getBoundingClientRect().top, popup: popup.top };
    // The popup must be free to move: pinned at a viewport clamp, neither a
    // working nor a broken implementation will shift it.
    const clampedTop = Math.max(6, window.innerHeight - popup.height - 6);
    if (Math.abs(popup.top - clampedTop) < 1) {
      return { ok: false, why: `the popup opened pinned at its viewport clamp (popup top ${popup.top}, clamp ${clampedTop}, popup height ${popup.height}, anchor top ${before.anchor}, viewport ${window.innerHeight}) — raise the viewport or park the anchor higher` };
    }
    const from = pane.scrollTop;
    pane.scrollTop = from + by;
    if (pane.scrollTop === from) return { ok: false, why: `the pane did not move: scrollTop stayed ${from}` };
    return { ok: true, before, moved: pane.scrollTop - from };
  }, SCROLL_BY, PANE_MIN_OVERFLOW_PX);
  check(scrolled.ok, "the pane scrolled by a measurable amount with the popup free to follow", scrolled.why ?? `moved ${scrolled.moved}px`);
  if (!scrolled.ok) throw new Error(`probe precondition failed: ${scrolled.why}`);
  await settle(400);

  const after = await page.evaluate(() => {
    const btn = [...document.querySelectorAll(".inspector .row")]
      .find((r) => r.querySelector(".label")?.textContent.trim() === "Icon")
      ?.querySelector(".gallery-btn");
    const popup = document.querySelector(".gallery-popup");
    const r = popup?.getBoundingClientRect();
    return {
      anchor: btn ? btn.getBoundingClientRect().top : null,
      popup: r ? r.top : null,
      // Still free of both clamps AFTER the move? If the scroll pushed the popup
      // onto an edge, tracking is expected to be partial and the delta check below
      // would be measuring the clamp rather than the follow.
      free: !!r && r.top > 6 + 1 && r.top < window.innerHeight - r.height - 6 - 1,
    };
  });
  check(after.free, "the popup is still clear of both viewport clamps after the scroll, so the delta below measures tracking and not clamping");
  await page.screenshot({ path: resolve(outDir, "popup_after_scroll.png") });

  check(after.popup !== null, "the popup is still open after the pane scrolled (it FOLLOWS, it does not close)");
  check(after.anchor !== null && Math.abs(after.anchor - scrolled.before.anchor) > TRACK_TOLERANCE_PX,
    "the anchor button actually moved, so there is something to track",
    `anchor top ${scrolled.before.anchor} -> ${after.anchor}`);

  const anchorDelta = after.anchor - scrolled.before.anchor;
  const popupDelta = after.popup - scrolled.before.popup;
  check(Math.abs(popupDelta - anchorDelta) <= TRACK_TOLERANCE_PX,
    "the popup TRACKED its anchor through the pane scroll",
    `anchor moved ${anchorDelta.toFixed(1)}px, popup moved ${popupDelta.toFixed(1)}px ` +
    `(a frozen popup — the bubble-phase-listener bug — gives popup 0.0px)`);

  // AND IT STILL DISMISSES. The same commit moved the outside-press listener from
  // bubble to capture phase; a listener that never fires would also "track"
  // perfectly, so tracking alone is not evidence the lifecycle is intact.
  await page.mouse.click(VIEWPORT.width / 2, VIEWPORT.height - 10);
  await settle(400);
  check(await page.evaluate(() => !document.querySelector(".gallery-popup")), "a press outside still dismisses the popup");

  const relevantErrors = errors.filter((e) => !/no WebGPU adapter|WebGPU init failed/.test(e));
  check(relevantErrors.length === 0, `no unexpected console/page errors; got ${JSON.stringify(relevantErrors)}`);

  if (failures > 0) {
    console.error(`\nPOPOVER ANCHOR PROBE FAILED (${failures})`);
    process.exit(1);
  }
  console.log("\nPOPOVER ANCHOR PROBE PASSED — the gallery popup follows its gutter button through an Inspector pane scroll, and an outside press still closes it.");
} finally {
  await browser.close();
  await server.close();
}
