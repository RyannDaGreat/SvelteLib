/**
 * INSPECTOR SCROLL-MEMORY PROBE — the Property Panel keeps its scroll position
 * across a deselect + reselect, and across switching straight from one item to
 * another (user, 2026-08-21: "the properties need to stop scrolling back to the
 * top each time I deselect and reselect a widget... so annoying").
 *
 * The mechanism under test lives in web/Inspector.svelte (SCROLL MEMORY): the
 * Panel body is the scroller, deselecting collapses its content so the browser
 * clamps scrollTop to 0, and the Inspector restores the remembered position once
 * the next selection's rows have mounted.
 *
 * Verifies:
 *   1. With a row-heavy widget selected, the panel body scrolls (there is
 *      something to remember — otherwise the test is vacuous).
 *   2. Deselect → reselect the SAME widget: scrollTop comes back.
 *   3. Select a DIFFERENT widget with at least as many rows: scrollTop holds.
 *   4. Scrolling somewhere else and repeating remembers the NEW position (it is
 *      memory, not a fixed offset).
 *
 * Spawns its OWN Vite + headless Chromium. Run from POWERRP or the SvelteLib root:
 *   node src/demo_apps/PowerRP/tests/inspector_scroll_probe.js
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

const errors = [];
const fails = [];
const assert = (cond, msg) => { if (!cond) { fails.push(msg); console.log(`  FAIL ${msg}`); } else { console.log(`  ok   ${msg}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A scroll depth that any row-heavy widget's panel can reach at a 700px viewport. */
const SCROLL_A = 260;
const SCROLL_B = 140;

try {
  const page = await browser.newPage();
  // SHORT on purpose: the panel must overflow for scrolling to exist at all.
  await page.setViewport({ width: 1400, height: 700, deviceScaleFactor: 1 });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource|thumbnail|\/api\/thumb|WebGPU|VideoV7|listAssets|could not list project assets|\/api\/assets/i.test(m.text())) errors.push(`console.error: ${m.text()}`); });

  await page.goto(`${baseUrl}/`, { waitUntil: "networkidle0" });
  await sleep(3500);
  if (errors.length) { console.error("BOOT ERRORS:\n" + errors.join("\n")); process.exit(1); }

  // Two row-heavy widgets (a visual node declares ~45 rows across nine sections).
  await page.evaluate(() => {
    const app = window.__powerrp_app;
    const def = (type) => ({ ...app.registry.get(type).defaults, type });
    const cam = { ...def("camera"), name: "Camera", x: 0, y: 0, w: 1000, h: 500, z: 1000, active: true, background: "#f4f4f8" };
    const a = { ...def("visual_node"), name: "A", x: 100, y: 100, w: 200, h: 120, z: 1, active: true, text: "A" };
    const b = { ...def("visual_node"), name: "B", x: 500, y: 100, w: 200, h: 120, z: 1, active: true, text: "B" };
    const doc = { meta: { name: "scroll-qa", slideW: 1000, slideH: 500 }, slides: [
      { id: "s0", name: "S1", transition: { type: "tween", seconds: 0.4, curve: "smooth", sound: null }, delta: { items: { cam, a, b } } },
    ] };
    app.commit(app.repaired(doc));
    app.slideIndex = 0;
    app.selection = null;
  });
  await sleep(500);

  const scroller = () => page.evaluate(() => {
    const el = document.querySelector(".inspector")?.parentElement;
    return el ? { top: el.scrollTop, max: el.scrollHeight - el.clientHeight } : null;
  });
  const select = async (id) => { await page.evaluate((i) => { window.__powerrp_app.selection = i; }, id); await sleep(350); };
  const scrollTo = async (y) => { await page.evaluate((v) => { document.querySelector(".inspector").parentElement.scrollTop = v; }, y); await sleep(250); };

  // (1) There is something to remember.
  await select("a");
  let s = await scroller();
  assert(s && s.max >= SCROLL_A, `the panel body overflows enough to scroll to ${SCROLL_A} (max ${s?.max})`);
  await scrollTo(SCROLL_A);
  s = await scroller();
  assert(s.top === SCROLL_A, `scrolled the panel body to ${SCROLL_A} (got ${s.top})`);

  // (2) Deselect, reselect the same widget.
  await select(null);
  s = await scroller();
  assert(s.top === 0, `deselecting collapses the panel and the browser clamps it to the top (got ${s.top}) — the defect this memory exists for`);
  await select("a");
  s = await scroller();
  assert(s.top === SCROLL_A, `reselecting A restores the panel to ${SCROLL_A} (got ${s.top})`);

  // (3) Straight to another widget.
  await select("b");
  s = await scroller();
  assert(s.top === SCROLL_A, `switching A → B keeps the panel at ${SCROLL_A} (got ${s.top})`);

  // (4) It is memory, not an offset.
  await scrollTo(SCROLL_B);
  await select(null);
  await select("b");
  s = await scroller();
  assert(s.top === SCROLL_B, `a new position (${SCROLL_B}) is the one remembered (got ${s.top})`);

  if (errors.length) { console.error("PAGE ERRORS:\n" + errors.join("\n")); fails.push("page errors"); }
} finally {
  await browser.close();
  await server.close();
}

if (fails.length) { console.error(`\ninspector scroll probe: ${fails.length} FAILED`); process.exit(1); }
console.log("\ninspector scroll probe: all checks passed");
