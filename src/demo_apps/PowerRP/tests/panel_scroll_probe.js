/**
 * PANEL SCROLL-MEMORY PROBE — EVERY panel keeps its scroll position across a
 * content collapse and regrowth: the Property Panel across deselect + reselect,
 * the Tools pane likewise, and switching straight from one item to another.
 *
 * User, 2026-08-21: "the properties need to stop scrolling back to the top each
 * time I deselect and reselect a widget... so annoying" — and when the fix landed
 * inside the Inspector: "same applies to ALL panels including tool panels. It
 * should have been done higher up in the class hierarchy." So the mechanism
 * under test is web/Panel.svelte's SCROLL MEMORY, the one scroller every pane
 * shares: deselecting collapses a pane's content, the browser clamps scrollTop
 * to 0, and the Panel restores the remembered position once the content is back.
 *
 * Verifies, for BOTH the properties panel and the tools panel:
 *   1. With a row-heavy widget selected, the panel body scrolls (there is
 *      something to remember — otherwise the test is vacuous).
 *   2. Deselect → reselect the SAME widget: scrollTop comes back.
 *   3. Select a DIFFERENT widget of the same kind: scrollTop holds.
 *   4. Scrolling somewhere else and repeating remembers the NEW position (it is
 *      memory, not a fixed offset).
 *
 * Spawns its OWN Vite + headless Chromium. Run from POWERRP or the SvelteLib root:
 *   node src/demo_apps/PowerRP/tests/panel_scroll_probe.js
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

/** Scroll depths any row-heavy widget's panels can reach at a 700px viewport. */
const SCROLL_A = 120;
const SCROLL_B = 60;

try {
  const page = await browser.newPage();
  // SHORT on purpose: a panel must overflow for scrolling to exist at all.
  await page.setViewport({ width: 1400, height: 700, deviceScaleFactor: 1 });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource|thumbnail|\/api\/thumb|WebGPU|VideoV7|listAssets|could not list project assets|\/api\/assets/i.test(m.text())) errors.push(`console.error: ${m.text()}`); });

  await page.goto(`${baseUrl}/`, { waitUntil: "networkidle0" });
  await sleep(3500);
  if (errors.length) { console.error("BOOT ERRORS:\n" + errors.join("\n")); process.exit(1); }

  // Two row-heavy widgets (a visual node declares ~45 rows and eight presets, so
  // both the properties panel and the tools pane overflow a 700px window).
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

  /** The scroller of the panel whose content root matches `sel`. */
  const scroller = (sel) => page.evaluate((s) => {
    const el = document.querySelector(s)?.closest(".panel-body");
    return el ? { top: el.scrollTop, max: el.scrollHeight - el.clientHeight } : null;
  }, sel);
  const select = async (id) => { await page.evaluate((i) => { window.__powerrp_app.selection = i; }, id); await sleep(400); };
  const scrollTo = async (sel, y) => { await page.evaluate((s, v) => { document.querySelector(s).closest(".panel-body").scrollTop = v; }, sel, y); await sleep(250); };

  // The content roots: the Inspector's, and the Tools pane's.
  const PANES = [
    { name: "properties panel", root: ".inspector" },
    { name: "tools pane", root: ".tools-pane, .toolspane, [data-region] .tools" },
  ];
  // Resolve the tools pane's root selector from what the DOM actually has: its
  // Panel is the one that is NOT the inspector's and whose content mentions presets.
  await select("a");
  const toolsRoot = await page.evaluate(() => {
    const bodies = [...document.querySelectorAll(".panel-body")];
    const body = bodies.find((b) => !b.querySelector(".inspector") && /preset/i.test(b.textContent));
    const root = body?.firstElementChild;
    if (!root) return null;
    if (!root.id) root.id = "probe-tools-root";
    return `#${root.id}`;
  });
  assert(!!toolsRoot, `found the tools pane's content root (${toolsRoot})`);
  PANES[1].root = toolsRoot ?? PANES[1].root;
  await select(null);

  for (const pane of PANES) {
    console.log(`— ${pane.name}`);
    // (1) There is something to remember.
    await select("a");
    let s = await scroller(pane.root);
    assert(s && s.max >= SCROLL_A, `${pane.name} overflows enough to scroll to ${SCROLL_A} (max ${s?.max})`);
    if (!s || s.max < SCROLL_A) continue;
    await scrollTo(pane.root, SCROLL_A);
    s = await scroller(pane.root);
    assert(s.top === SCROLL_A, `scrolled to ${SCROLL_A} (got ${s.top})`);

    // (2) Deselect, reselect the same widget.
    await select(null);
    s = await scroller(pane.root);
    assert(s.top < SCROLL_A, `deselecting collapses the content and the browser clamps the scroller (got ${s.top}) — the defect this memory exists for`);
    await select("a");
    s = await scroller(pane.root);
    assert(s.top === SCROLL_A, `reselecting A restores ${SCROLL_A} (got ${s.top})`);

    // (3) Straight to another widget.
    await select("b");
    s = await scroller(pane.root);
    assert(s.top === SCROLL_A, `switching A → B keeps ${SCROLL_A} (got ${s.top})`);

    // (4) It is memory, not an offset.
    await scrollTo(pane.root, SCROLL_B);
    await select(null);
    await select("b");
    s = await scroller(pane.root);
    assert(s.top === SCROLL_B, `a new position (${SCROLL_B}) is the one remembered (got ${s.top})`);
    await select(null);
  }

  if (errors.length) { console.error("PAGE ERRORS:\n" + errors.join("\n")); fails.push("page errors"); }
} finally {
  await browser.close();
  await server.close();
}

if (fails.length) { console.error(`\npanel scroll probe: ${fails.length} FAILED`); process.exit(1); }
console.log("\npanel scroll probe: all checks passed");
