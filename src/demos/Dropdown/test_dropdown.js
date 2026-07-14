/**
 * Puppeteer tests for the extended Dropdown component.
 *
 * Boots a programmatic Vite dev server (same pattern as
 * src/demo_apps/PowerRP/cli/render.js), loads the Dropdown demo page in
 * headless Chromium, and drives real DOM interactions to verify:
 *   (a) legacy single-select behavior is unchanged
 *       (open, arrow-nav, Enter selects, ESC closes, click-outside closes)
 *   (b) multiple:true toggles rows without closing; array binds; summary updates
 *   (c) inserts render between rows, arrow keys skip them, clicking selects nothing
 *   (d) scrollToValue scrolls the target row into view on open (scrollTop > 0)
 *   (e) the default trigger caret is an inline SVG (not a text glyph), sensibly
 *       sized (box height in [14px, trigger height]), doesn't stretch the
 *       trigger, and flips on open
 *
 * Run from the SvelteLib repo root:
 *   node src/demos/Dropdown/test_dropdown.js
 * Exits 0 on all-green, 1 on first failure.
 */

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

let passed = 0;
const failures = [];

function ok(name, cond, detail = "") {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failures.push(`${name}${detail ? " — " + detail : ""}`);
    console.log(`  FAIL  ${name}${detail ? " — " + detail : ""}`);
  }
}

/* Locate the Nth demo card (0-based) matching an <h2> title substring. */
async function cardHandle(page, titleIncludes) {
  return page.evaluateHandle((t) => {
    const cards = [...document.querySelectorAll(".card")];
    return cards.find((c) => c.querySelector("h2")?.textContent.includes(t));
  }, titleIncludes);
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const { createServer } = await import("vite");
const server = await createServer({
  configFile: resolve(repoRoot, "vite.config.js"),
  root: repoRoot,
  server: { port: 0, open: false, host: "127.0.0.1" },
});
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/src/demos/Dropdown/demo.html`;

const { default: puppeteer } = await import("puppeteer");
const browser = await puppeteer.launch({ headless: "new" });

try {
  const page = await browser.newPage();
  page.on("pageerror", (e) => {
    failures.push("pageerror: " + e.message);
    console.log("  PAGEERROR " + e.message);
  });
  await page.goto(url, { waitUntil: "networkidle0" });
  await page.waitForSelector(".dd", { timeout: 5000 });

  /* ---------- (a) legacy single-select ---------- */
  console.log("\n(a) single-select behavior unchanged");
  {
    const card = await cardHandle(page, "Default");
    const trigger = await card.$(".dd-trigger");

    // opens on click
    await trigger.click();
    ok("opens on trigger click", await card.$(".dd-menu") !== null);

    // arrow-down from current selection (banana, idx 1) -> cherry (idx 2)
    await page.keyboard.press("ArrowDown");
    const active1 = await card.$eval(".dd-item.dd-active", (el) => el.textContent.trim());
    ok("ArrowDown moves active down", active1 === "Cherry", `active=${active1}`);

    // arrow-down again skips disabled "Durian" -> "Elderberry"
    await page.keyboard.press("ArrowDown");
    const active2 = await card.$eval(".dd-item.dd-active", (el) => el.textContent.trim());
    ok("ArrowDown skips disabled row", active2 === "Elderberry", `active=${active2}`);

    // Enter selects + closes
    await page.keyboard.press("Enter");
    await sleep(30);
    ok("Enter closes menu", await card.$(".dd-menu") === null);
    const label = await card.$eval(".dd-trigger-label", (el) => el.textContent.trim());
    ok("Enter selects active item", label === "Elderberry", `label=${label}`);

    // reopen, ESC closes
    await trigger.click();
    ok("reopens", await card.$(".dd-menu") !== null);
    await page.keyboard.press("Escape");
    await sleep(30);
    ok("Escape closes menu", await card.$(".dd-menu") === null);

    // reopen, click-outside closes
    await trigger.click();
    await page.mouse.click(2, 2);
    await sleep(30);
    ok("click-outside closes menu", await card.$(".dd-menu") === null);

    // click an item directly selects + closes
    await trigger.click();
    const items = await card.$$(".dd-item");
    await items[0].click(); // Apple
    await sleep(30);
    const label2 = await card.$eval(".dd-trigger-label", (el) => el.textContent.trim());
    ok("click selects + closes", label2 === "Apple" && (await card.$(".dd-menu")) === null,
      `label=${label2}`);
  }

  /* ---------- (b) multi-select ---------- */
  console.log("\n(b) multiple:true toggles, array binds, summary updates");
  {
    const card = await cardHandle(page, "Multi-select"); // first "Multi-select..." card
    const trigger = await card.$(".dd-trigger");

    // starts with ["cheese","basil"] => "2 selected"
    const start = await card.$eval(".dd-trigger-label", (el) => el.textContent.trim());
    ok("default summary shows count", start === "2 selected", `summary=${start}`);

    await trigger.click();
    ok("menu open for multi", await card.$(".dd-menu") !== null);

    // exactly two checkmarks rendered initially
    const checks0 = await card.$$eval(".dd-item .dd-check svg", (els) => els.length);
    ok("initial checkmarks match selection", checks0 === 2, `checks=${checks0}`);

    // click "Pepperoni" (index 2) -> stays open, becomes 3 selected
    const items = await card.$$(".dd-item");
    await items[2].click();
    await sleep(30);
    ok("multi click keeps menu OPEN", await card.$(".dd-menu") !== null);
    const summ1 = await card.$eval(".dd-trigger-label", (el) => el.textContent.trim());
    ok("summary updates to 3 selected", summ1 === "3 selected", `summary=${summ1}`);
    const checks1 = await card.$$eval(".dd-item .dd-check svg", (els) => els.length);
    ok("checkmark added on toggle-on", checks1 === 3, `checks=${checks1}`);

    // click "Pepperoni" again -> toggles off, back to 2
    await items[2].click();
    await sleep(30);
    const summ2 = await card.$eval(".dd-trigger-label", (el) => el.textContent.trim());
    ok("re-click toggles OFF (back to 2)", summ2 === "2 selected", `summary=${summ2}`);

    // Enter toggles the active row too. Clicking an <li> above left focus on
    // <body> (li isn't focusable), so keydowns wouldn't reach the component —
    // refocus the trigger. Move the mouse away too so stray pointerenter events
    // can't retarget `active`. Then navigate by keyboard onto a row we know is
    // UNSELECTED (Mushroom, idx 1) and Enter it ON.
    await page.mouse.move(2, 2);
    await trigger.focus();
    await page.keyboard.press("Home"); // active -> Cheese (idx 0, selected)
    await page.keyboard.press("ArrowDown"); // active -> Mushroom (idx 1, unselected)
    const activeBefore = await card.$eval(".dd-item.dd-active .dd-item-body", (el) => el.textContent.trim());
    const checksBeforeEnter = await card.$$eval(".dd-item .dd-check svg", (els) => els.length);
    await page.keyboard.press("Enter");
    await sleep(30);
    const checksAfterEnter = await card.$$eval(".dd-item .dd-check svg", (els) => els.length);
    ok("Enter toggles active row membership ON",
      activeBefore === "Mushroom" && checksAfterEnter === checksBeforeEnter + 1,
      `active=${activeBefore} before=${checksBeforeEnter} after=${checksAfterEnter}`);

    await page.keyboard.press("Escape");
    await sleep(30);
  }

  /* ---------- (c) inserts ---------- */
  console.log("\n(c) inserts render between rows, skipped by nav + selection");
  {
    const card = await cardHandle(page, "Inserts between items");
    const trigger = await card.$(".dd-trigger");
    await trigger.click();
    await sleep(30);

    const insertCount = await card.$$eval(".dd-insert", (els) => els.length);
    ok("inserts render as .dd-insert rows", insertCount === 3, `count=${insertCount}`);
    const insertTexts = await card.$$eval(".dd-insert", (els) => els.map((e) => e.textContent.trim()));
    ok("insert content renders", insertTexts.join(",") === "Fruits,Vegetables,Grains",
      insertTexts.join(","));

    // selected value is "carrot"; active should be carrot's row, NOT an insert
    const activeStart = await card.$eval(".dd-item.dd-active .dd-item-body", (el) => el.textContent.trim());
    ok("open lands active on a real item (not insert)", activeStart === "Carrot", `active=${activeStart}`);

    // ArrowUp from Carrot must skip the "Vegetables" insert AND land on Banana
    await page.keyboard.press("ArrowUp");
    const afterUp = await card.$eval(".dd-item.dd-active .dd-item-body", (el) => el.textContent.trim());
    ok("ArrowUp skips insert (Carrot->Banana)", afterUp === "Banana", `active=${afterUp}`);

    // clicking an insert selects nothing (value unchanged) and menu stays as-is
    const valBefore = await card.$eval(".dd-trigger-label", (el) => el.textContent.trim());
    const firstInsert = await card.$(".dd-insert");
    // inserts have pointer-events:none, so a direct DOM click is what we assert against
    await page.evaluate((el) => el.click(), firstInsert);
    await sleep(30);
    const valAfter = await card.$eval(".dd-trigger-label", (el) => el.textContent.trim());
    ok("clicking insert selects nothing", valBefore === valAfter, `before=${valBefore} after=${valAfter}`);

    await page.keyboard.press("Escape");
    await sleep(30);
  }

  /* ---------- (d) scrollToValue ---------- */
  console.log("\n(d) scrollToValue scrolls target into view on open");
  {
    const card = await cardHandle(page, "Scroll-to-value");
    const trigger = await card.$(".dd-trigger");
    await trigger.click();
    // scrollIntoView is deferred one rAF; wait for it
    await sleep(120);
    const scrollTop = await card.$eval(".dd-list", (el) => el.scrollTop);
    ok("list scrolled (scrollTop > 0)", scrollTop > 0, `scrollTop=${scrollTop}`);

    // the selected row (Rome) should be within the visible viewport of the list
    const inView = await card.$eval(".dd-list", (list) => {
      const sel = list.querySelector(".dd-item.dd-selected");
      if (!sel) return false;
      const lb = list.getBoundingClientRect();
      const rb = sel.getBoundingClientRect();
      return rb.top >= lb.top - 1 && rb.bottom <= lb.bottom + 1;
    });
    ok("target row is within the visible list viewport", inView);

    await page.keyboard.press("Escape");
    await sleep(30);
  }

  /* ---------- (e) trigger caret ---------- */
  console.log("\n(e) default trigger caret is an inline SVG, sensibly sized");
  {
    const MIN_CARET_H = 14; // px: below this the caret reads as a tiny speck
    const card = await cardHandle(page, "Default");

    const caretExists = (await card.$(".dd-caret")) !== null;
    ok("caret element exists", caretExists);

    // The caret is an inline <svg> (renders synchronously, no web-component /
    // API round-trip, immune to iconify mutation-observer churn — see the
    // component's header note). This is the "SVG-only, never a text glyph" rule.
    const caretChild = await card.$eval(".dd-caret > *", (el) => el.tagName.toLowerCase());
    ok("caret is an <svg> element (not a Unicode text glyph)",
      caretChild === "svg", `tag=${caretChild}`);

    // Inline SVG needs no async wait — measure straight away.
    const box = await card.$eval(".dd-caret svg", (el) => {
      const r = el.getBoundingClientRect();
      return { w: r.width, h: r.height };
    });
    const triggerH = await card.$eval(".dd-trigger", (el) => el.getBoundingClientRect().height);
    ok("caret box height >= 14px (not a tiny speck)",
      box.h >= MIN_CARET_H, `h=${box.h}`);
    ok("caret box height <= trigger height (doesn't overflow the trigger)",
      box.h <= triggerH + 0.5, `caretH=${box.h} triggerH=${triggerH}`);

    // Opening must not resize the trigger — the caret can't stretch it.
    await card.$eval(".dd-trigger", (el) => el.click());
    await sleep(60);
    const triggerHOpen = await card.$eval(".dd-trigger", (el) => el.getBoundingClientRect().height);
    ok("trigger height stable across open/close (caret doesn't stretch it)",
      Math.abs(triggerHOpen - triggerH) < 0.5, `closed=${triggerH} open=${triggerHOpen}`);

    // Open-state affordance: the caret is flipped (rotated) while open.
    const flipped = await card.$eval(".dd-caret svg", (el) => {
      const t = getComputedStyle(el).transform;
      return t !== "none" && t !== "";
    });
    ok("caret flips on open (open-state affordance present)", flipped);

    await page.keyboard.press("Escape");
    await sleep(30);
  }

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log("FAILURES:");
    for (const f of failures) console.log("  - " + f);
  }
} finally {
  await browser.close();
  await server.close();
}

process.exit(failures.length ? 1 : 0);
