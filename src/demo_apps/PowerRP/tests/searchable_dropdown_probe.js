/**
 * SEARCHABLE DROPDOWN probe (Round 2 #28/#29/#30/#31). Boots the PowerRP editor
 * headless with the demo deck, selects a rect, puts the Fill slot in "Mat" mode
 * (which mounts the material picker — a SearchableDropdown over the 14 fill
 * materials) and exercises the four new behaviors end-to-end in the REAL app:
 *
 *   A. TYPE-TO-FILTER + HIGHLIGHT — typing a fragment filters the option list to
 *      the fuzzy matches and wraps the matched characters in <mark class="sd-mark">.
 *   B. HOVER-PREVIEW on a FILTERED row still stages the live canvas preview
 *      (the material picker depends on this), and CLICK commits it + closes.
 *   C. NO CLIPPED MENU (#31) — the open menu is position:fixed, fits the viewport
 *      (escapes the Inspector pane's overflow), and FLIPS above the trigger when
 *      there is no room below.
 *   D. SCROLL-UPDATES-HOVER (#30) — scrolling the option list under a STATIONARY
 *      pointer re-hit-tests and makes the row now under the cursor the active one.
 *
 * The doc is a Svelte 5 $state proxy, so every value read out of page.evaluate is
 * JSON.stringify'd IN PAGE and parsed here (the material_paint_ui_probe trap).
 *
 * Run from SvelteLib root: node src/demo_apps/PowerRP/tests/searchable_dropdown_probe.js
 */
import { readFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { launchBrowser } from "./puppeteerLaunch.js";
import { fillCapableMaterialIds, getMaterial } from "../render_gpu/skia/materials.js";
import { rankItems } from "../../../lib/fuzzyMatch.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(HERE, "../web");
const shotDir = resolve(HERE, "../.claude_vlm_checks");
const demoJson = await readFile(resolve(HERE, "../examples/demo.powerrp.json"), "utf8");
await mkdir(shotDir, { recursive: true });

// ── Node-side truth: pick a (target material, query) that cleanly filters ──────
// A non-default material whose short prefix fuzzy-matches ITSELF, keeps the list
// smaller than the whole registry, and does NOT match the default — so the probe
// can assert the target is IN the filtered set, its match is highlighted, and the
// default is EXCLUDED. Computed with the SAME ranker the component uses.
const FILL_IDS = fillCapableMaterialIds();
const FILL_DEFAULT = FILL_IDS[0];
const OPTIONS = FILL_IDS.map((id) => ({ value: id, label: getMaterial(id).title ?? id }));
let target = null, query = null;
for (const o of OPTIONS) {
  if (o.value === FILL_DEFAULT) continue;
  const q = o.label.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 3);
  if (q.length < 3) continue;
  const ranked = rankItems(q, OPTIONS);
  const ids = ranked.map((r) => r.value);
  if (ids.includes(o.value) && ids.length < OPTIONS.length && !ids.includes(FILL_DEFAULT)) {
    target = o; query = q; break;
  }
}
if (!target) { console.error("could not pick a filtering (target, query) from the fill registry"); process.exit(1); }

const server = await createServer({ configFile: resolve(webRoot, "vite.config.js"), server: { port: 0, open: false, host: "127.0.0.1", hmr: false, watch: null } });
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/`;
const browser = await launchBrowser();

const errors = [];
const checks = [];
const ok = (cond, label) => { checks.push([!!cond, label]); if (!cond) errors.push(`CHECK FAILED: ${label}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const IGNORE_BOOT = [/PowerRP repair:/, /was missing font/, /duration.*transition|transition.*duration/i, /no.*adapter|adapters/i, /WebGPU/i, /VideoV7/i];
const isBootNoise = (s) => IGNORE_BOOT.some((re) => re.test(s));

// Locate the Fill Inspector row (the material picker lives inside it) in page.
const FILL_ROW = `[...document.querySelectorAll(".inspector .row")].find((r) => r.querySelector(".label")?.textContent === "Fill")`;

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error" && !isBootNoise(m.text())) errors.push(`console.error: ${m.text()}`); });
  await page.evaluateOnNewDocument((json) => localStorage.setItem("powerrp.autosave", json), demoJson);
  await page.goto(url, { waitUntil: "networkidle0" });
  await sleep(600);
  const realBoot = errors.filter((e) => !isBootNoise(e));
  if (realBoot.length) { console.error("PAGE ERRORS AT BOOT:\n" + realBoot.join("\n")); process.exit(1); }
  errors.length = 0;

  const rectId = await page.evaluate(() => {
    const app = window.__powerrp_app;
    app.slideIndex = 0;
    const items = app.doc.slides[0].delta.items;
    const id = Object.keys(items).find((k) => items[k].type === "rect");
    app.selection = id;
    return id;
  });
  ok(rectId, "found a rect item in the demo deck");
  await sleep(250);

  // Put Fill into Mat mode → mounts the material SearchableDropdown.
  await page.evaluate((rowJs) => {
    const row = eval(rowJs);
    [...row.querySelectorAll("button")].find((b) => b.textContent.trim() === "Mat")?.click();
  }, FILL_ROW);
  await sleep(200);

  const openPicker = () => page.evaluate((rowJs) => { eval(rowJs).querySelector(".dd-trigger").click(); }, FILL_ROW);
  const menuInfo = () => page.evaluate((rowJs) => {
    const row = eval(rowJs);
    const menu = row.querySelector(".dd-menu");
    const trig = row.querySelector(".dd-trigger");
    const items = [...row.querySelectorAll(".dd-item")];
    return JSON.stringify({
      open: !!menu,
      hasSearch: !!row.querySelector(".sd-search"),
      itemCount: items.length,
      labels: items.map((li) => li.querySelector(".dd-item-body")?.textContent?.trim()),
      markTexts: [...row.querySelectorAll(".sd-mark")].map((m) => m.textContent),
      position: menu ? getComputedStyle(menu).position : null,
      menuRect: menu ? (({ left, top, right, bottom, width, height }) => ({ left, top, right, bottom, width, height }))(menu.getBoundingClientRect()) : null,
      trigRect: (({ top, bottom }) => ({ top, bottom }))(trig.getBoundingClientRect()),
      upFlip: menu ? menu.classList.contains("dd-menu-up") : false,
      vw: window.innerWidth, vh: window.innerHeight,
    });
  }, FILL_ROW).then(JSON.parse);
  const typeQuery = (q) => page.evaluate((rowJs, text) => {
    const input = eval(rowJs).querySelector(".sd-search");
    input.focus();
    input.value = text;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }, FILL_ROW, q);

  // ── A. Type-to-filter + highlight ───────────────────────────────────────────
  await openPicker();
  await sleep(150);
  const opened = await menuInfo();
  ok(opened.open && opened.hasSearch, `material picker opens WITH a search box (14 > threshold); open=${opened.open} search=${opened.hasSearch}`);
  ok(opened.itemCount === OPTIONS.length, `unfiltered list shows all ${OPTIONS.length} materials; got ${opened.itemCount}`);

  await typeQuery(query);
  await sleep(150);
  const filtered = await menuInfo();
  ok(filtered.itemCount > 0 && filtered.itemCount < OPTIONS.length,
    `typing "${query}" FILTERS the list (${filtered.itemCount} of ${OPTIONS.length})`);
  ok(filtered.labels.includes(target.label), `filtered list contains the target "${target.label}"; got [${filtered.labels.join(", ")}]`);
  ok(!filtered.labels.includes(getMaterial(FILL_DEFAULT).title ?? FILL_DEFAULT),
    `the non-matching default "${getMaterial(FILL_DEFAULT).title ?? FILL_DEFAULT}" is EXCLUDED`);
  ok(filtered.markTexts.length > 0, `matched characters are HIGHLIGHTED in <mark class="sd-mark"> (got ${JSON.stringify(filtered.markTexts)})`);
  ok(filtered.markTexts.join("").toLowerCase().includes(query[0]),
    `the highlight spans the typed fragment "${query}" (marks: ${JSON.stringify(filtered.markTexts)})`);
  await page.screenshot({ path: resolve(shotDir, "searchable_dropdown_search.png") });

  // ── B. Hover-preview on a filtered row, then click commits ──────────────────
  const hoverTarget = await page.evaluate((rowJs, label) => {
    const row = eval(rowJs);
    const li = [...row.querySelectorAll(".dd-item")].find((el) => el.querySelector(".dd-item-body")?.textContent?.trim() === label);
    li.dispatchEvent(new PointerEvent("pointerenter", { bubbles: true, pointerId: 1 }));
    return !!li;
  }, FILL_ROW, target.label);
  ok(hoverTarget, `hovered the filtered "${target.label}" row`);
  await sleep(100);
  const previewId = JSON.parse(await page.evaluate((id) => JSON.stringify(window.__powerrp_app.previewDelta?.items?.[id]?.fill?.material?.id ?? null), rectId));
  ok(previewId === target.value, `hover-preview on the FILTERED row stages "${target.value}" on the canvas; got ${JSON.stringify(previewId)}`);
  const committedBefore = JSON.parse(await page.evaluate((id) => JSON.stringify(window.__powerrp_app.doc.slides[0].delta.items[id].fill?.material?.id ?? null), rectId));
  ok(committedBefore === FILL_DEFAULT, `doc still on "${FILL_DEFAULT}" while hovering (hover never commits); got ${committedBefore}`);

  await page.evaluate((rowJs, label) => {
    const row = eval(rowJs);
    [...row.querySelectorAll(".dd-item")].find((el) => el.querySelector(".dd-item-body")?.textContent?.trim() === label)?.click();
  }, FILL_ROW, target.label);
  await sleep(150);
  const afterPick = await page.evaluate((rowJs, id) => JSON.stringify({
    committed: window.__powerrp_app.doc.slides[0].delta.items[id].fill?.material?.id ?? null,
    open: !!eval(rowJs).querySelector(".dd-menu"),
  }), FILL_ROW, rectId).then(JSON.parse);
  ok(afterPick.committed === target.value, `clicking the filtered row COMMITS "${target.value}"; got ${afterPick.committed}`);
  ok(!afterPick.open, "picking closes the menu");

  // ── C. No clipped menu: fixed, fits the viewport, flips up near the bottom ───
  await openPicker();
  await sleep(150);
  const placed = await menuInfo();
  ok(placed.position === "fixed", `open menu is position:fixed (escapes the pane's overflow); got ${placed.position}`);
  const r = placed.menuRect;
  ok(r && r.top >= -1 && r.left >= -1 && r.bottom <= placed.vh + 1 && r.right <= placed.vw + 1,
    `menu is fully within the viewport (not clipped): rect ${JSON.stringify(r)} in ${placed.vw}x${placed.vh}`);
  // Close, then scroll the Inspector's own scroll container so the Fill trigger
  // sits ~70px above the viewport bottom — less room below than the 14-item menu
  // needs, so the next open MUST flip up (and this is exactly the reported bug:
  // a picker near the pane bottom).
  await openPicker(); await sleep(80); // toggle closed
  await page.evaluate((rowJs) => {
    const trig = eval(rowJs).querySelector(".dd-trigger");
    let el = trig.parentElement;
    while (el && el.scrollHeight <= el.clientHeight + 1) el = el.parentElement;
    if (!el) return;
    el.scrollTop += trig.getBoundingClientRect().top - (window.innerHeight - 70);
  }, FILL_ROW);
  await sleep(120);
  await openPicker();
  await sleep(150);
  const flipped = await menuInfo();
  ok(flipped.open, "menu re-opens with the trigger scrolled near the pane bottom");
  ok(flipped.upFlip, `with no room below, the menu FLIPS above the trigger (dd-menu-up); trigTop=${flipped.trigRect.top} vh=${flipped.vh}`);
  ok(flipped.menuRect && flipped.menuRect.bottom <= flipped.trigRect.top + 2 && flipped.menuRect.top >= -1 && flipped.menuRect.bottom <= flipped.vh + 1,
    `flipped menu sits ABOVE the trigger and stays on-screen (not clipped): menu ${JSON.stringify(flipped.menuRect)} trigTop=${flipped.trigRect.top}`);
  await page.screenshot({ path: resolve(shotDir, "searchable_dropdown_flip.png") });
  await openPicker(); await sleep(80); // close

  // ── D. Scroll-updates-hover: scroll the list under a stationary pointer ──────
  await openPicker();
  await sleep(150);
  // Park the real pointer over a row near the TOP of the list, so a downward
  // scroll brings a different material under it. page.mouse.move dispatches a real
  // pointermove, which is how the component tracks the last pointer position.
  const parked = await page.evaluate((rowJs) => {
    const list = eval(rowJs).querySelector(".dd-list");
    const first = list.querySelector(".dd-item");
    const rc = first.getBoundingClientRect();
    return JSON.stringify({ x: Math.round(rc.left + rc.width / 2), y: Math.round(rc.top + rc.height * 0.5), scrollable: list.scrollHeight > list.clientHeight + 2 });
  }, FILL_ROW).then(JSON.parse);
  ok(parked.scrollable, `the material list is scrollable (a scroll can change what's under the pointer); scrollable=${parked.scrollable}`);
  await page.mouse.move(parked.x, parked.y);
  await sleep(60);
  const beforeScroll = JSON.parse(await page.evaluate((rowJs) => {
    const row = eval(rowJs);
    return JSON.stringify(row.querySelector(".dd-item.dd-active")?.getAttribute("data-dd-index") ?? null);
  }, FILL_ROW));
  // Scroll the list programmatically (fires a scroll event, no mousemove) — the
  // component must re-hit-test at the parked pointer and re-hover the new row.
  await page.evaluate((rowJs) => { eval(rowJs).querySelector(".dd-list").scrollTop += 120; }, FILL_ROW);
  await sleep(120);
  const afterScroll = JSON.parse(await page.evaluate((rowJs) => {
    const row = eval(rowJs);
    return JSON.stringify(row.querySelector(".dd-item.dd-active")?.getAttribute("data-dd-index") ?? null);
  }, FILL_ROW));
  ok(afterScroll !== null && afterScroll !== beforeScroll,
    `scrolling under the stationary pointer re-hovers the new row (active ${beforeScroll} → ${afterScroll})`);
  await page.screenshot({ path: resolve(shotDir, "searchable_dropdown_scrollhover.png") });

  if (errors.length) {
    console.error("PROBE ERRORS:\n" + errors.join("\n"));
    console.error(`\n${checks.filter(([c]) => c).length}/${checks.length} checks passed`);
    process.exit(1);
  }
  console.log(`Searchable dropdown probe passed: ${checks.length}/${checks.length} checks, zero console errors.`);
  console.log(`  (target "${target.label}", query "${query}"; shots in .claude_vlm_checks/searchable_dropdown_*.png)`);
  for (const [, label] of checks) console.log(`  ok  ${label}`);
} finally {
  await browser.close();
  await server.close();
}
